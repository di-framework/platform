package controller

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/installer"
	"github.com/di-framework/platform/operator/internal/targets/vcluster"
)

// vclusterHelm stands in for Helm and for the vCluster it installs: an install creates the
// release's host-namespace objects at once, ready, with a new owner Service uid and a kubeconfig
// for a new CA, as a vCluster that starts from empty data does.
type vclusterHelm struct {
	t         *testing.T
	c         client.Client
	installed map[string]bool
	n         int
}

func (f *vclusterHelm) Get(_ context.Context, ns, _ string) (*vcluster.Release, error) {
	if !f.installed[ns] {
		return nil, nil
	}
	return &vcluster.Release{Status: "deployed", Revision: 1}, nil
}

func (f *vclusterHelm) Install(ctx context.Context, ns, name string, _ []byte, _ map[string]any) error {
	f.n++
	f.installed[ns] = true
	sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}
	objs := []client.Object{
		sts,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, UID: types.UID(fmt.Sprintf("svc-uid-%d", f.n))}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name + "-headless"}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name + "-0"}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + name},
			Data: map[string][]byte{"config": []byte(vclusterConfig(fmt.Sprintf("ca-%d", f.n)))}},
	}
	for _, obj := range objs {
		if err := f.c.Create(ctx, obj); err != nil {
			return err
		}
	}
	sts.Status.ReadyReplicas = 1
	return f.c.Status().Update(ctx, sts)
}

func (f *vclusterHelm) Repair(context.Context, string, string) error {
	return errors.New("unexpected repair")
}
func (f *vclusterHelm) Rollback(context.Context, string, string) (int, error) {
	return 0, errors.New("unexpected rollback")
}
func (f *vclusterHelm) Uninstall(_ context.Context, ns, _ string) error {
	delete(f.installed, ns)
	return nil
}

func vclusterConfig(ca string) string {
	return `apiVersion: v1
kind: Config
clusters:
- name: my-vcluster
  cluster:
    server: https://localhost:8443
    certificate-authority-data: ` + base64.StdEncoding.EncodeToString([]byte(ca)) + `
contexts:
- name: my-vcluster
  context: {cluster: my-vcluster, user: my-vcluster}
current-context: my-vcluster
users:
- name: my-vcluster
  user: {client-certificate-data: Y2VydA==, client-key-data: a2V5}
`
}

// stateInstaller keeps install state the way Pulumi does: it holds the credentials of the
// cluster it was created against, and an update against a cluster with other credentials fails
// as the refresh did in Layer 4 run 4 (#490). Uninstall drops it, unless failUninstalls is set:
// that many Uninstall calls fail and keep it. failInstalls Install calls fail likewise.
type stateInstaller struct {
	state          []byte
	installs       []installer.Options
	uninstalls     []installer.UninstallOptions
	failUninstalls int
	failInstalls   int
}

func (s *stateInstaller) Install(_ context.Context, req installer.Request, opts installer.Options) (installer.Result, error) {
	if s.failInstalls > 0 {
		s.failInstalls--
		return installer.Result{}, errors.New("pulumi up failed")
	}
	if s.state != nil && !bytes.Equal(s.state, req.Kubeconfig) {
		return installer.Result{}, errors.New(`refresh: failed to verify candidate authority certificate "kubernetes": unreachable cluster (PULUMI_K8S_DELETE_UNREACHABLE)`)
	}
	s.state = req.Kubeconfig
	s.installs = append(s.installs, opts)
	return installer.Result{KubernetesEndpoint: "https://k", HTTPEndpoint: "http://h"}, nil
}
func (s *stateInstaller) Status(context.Context, installer.Request) (installer.State, error) {
	return installer.State{Exists: s.state != nil}, nil
}
func (s *stateInstaller) Uninstall(_ context.Context, _ installer.Request, opts installer.UninstallOptions) error {
	if s.failUninstalls > 0 {
		s.failUninstalls--
		return errors.New("pulumi: the state backend is unavailable")
	}
	s.state = nil
	s.uninstalls = append(s.uninstalls, opts)
	return nil
}

// nsHarness runs the controller with the real vCluster target on the fake API server.
type nsHarness struct {
	*harness
	helm       *vclusterHelm
	in         *stateInstaller
	podDeletes int
	errs       []error
}

func newNSHarness(t *testing.T, policy v1alpha1.DeletionPolicy) *nsHarness {
	t.Helper()
	h := &nsHarness{harness: newHarness(t, policy), in: &stateInstaller{}}
	// Pod deletes are what a resync restarts the control plane with.
	h.c = interceptor.NewClient(h.c.(client.WithWatch), interceptor.Funcs{
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if _, ok := obj.(*corev1.Pod); ok {
				h.podDeletes++
			}
			return c.Delete(ctx, obj, opts...)
		},
	})
	h.helm = &vclusterHelm{t: t, c: h.c, installed: map[string]bool{}}
	h.r.Client, h.r.APIReader, h.r.Installer = h.c, h.c, h.in
	h.r.Target = &vcluster.Target{
		Client: h.c, Helm: h.helm,
		OperatorNamespace: "platform-operator", OperatorUsername: "system:serviceaccount:platform-operator:platform-operator",
		Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
			return map[string]any{}, nil
		},
		Dial: func(context.Context, string) error { return nil },
		Now:  func() time.Time { return h.now },
	}
	return h
}

// step runs one round, a TargetPoll after the last, and keeps its error.
func (h *nsHarness) step() {
	h.t.Helper()
	h.now = h.now.Add(h.r.Plan.TargetPoll)
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err != nil {
		h.errs = append(h.errs, err)
	}
}

func (h *nsHarness) ns() string { return vcluster.HostNamespace(h.get()) }

// hold puts a finalizer on the host namespace, so a delete leaves it terminating until release.
func (h *nsHarness) hold() {
	h.t.Helper()
	var ns corev1.Namespace
	if err := h.c.Get(context.Background(), client.ObjectKey{Name: h.ns()}, &ns); err != nil {
		h.t.Fatal(err)
	}
	ns.Finalizers = append(ns.Finalizers, "test.di-framework.dev/hold")
	if err := h.c.Update(context.Background(), &ns); err != nil {
		h.t.Fatal(err)
	}
}

// namespace returns the host namespace, or nil when it is gone.
func (h *nsHarness) namespace(name string) *corev1.Namespace {
	h.t.Helper()
	var ns corev1.Namespace
	err := h.c.Get(context.Background(), client.ObjectKey{Name: name}, &ns)
	if apierrors.IsNotFound(err) {
		return nil
	} else if err != nil {
		h.t.Fatal(err)
	}
	return &ns
}

// release lets the terminating namespace go, with its contents (the namespace controller's
// work), and the Helm release recorded in it.
func (h *nsHarness) release(name string) {
	h.t.Helper()
	ctx := context.Background()
	ns := h.namespace(name)
	if ns == nil || ns.DeletionTimestamp == nil {
		h.t.Fatalf("namespace %s not terminating: %+v", name, ns)
	}
	ns.Finalizers = nil
	if err := h.c.Update(ctx, ns); err != nil {
		h.t.Fatal(err)
	}
	for _, obj := range []client.Object{
		&appsv1.StatefulSet{}, &corev1.Service{}, &corev1.Pod{}, &corev1.Secret{},
	} {
		if err := h.c.DeleteAllOf(ctx, obj, client.InNamespace(name)); err != nil {
			h.t.Fatal(err)
		}
	}
	delete(h.helm.installed, name)
}

func (h *nsHarness) installed() *v1alpha1.PlatformInstance {
	h.t.Helper()
	for range 3 {
		h.step()
	}
	inst := h.get()
	if len(h.in.installs) != 1 || !meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) ||
		inst.Status.Target.ServiceUID != "svc-uid-1" || len(h.errs) != 0 {
		h.t.Fatalf("first install: %d installs, errors %v, status %+v", len(h.in.installs), h.errs, inst.Status)
	}
	return inst
}

// assertHostResynced checks the end of a host-namespace resync: the install state dropped once,
// one reinstall (Installed=Resync) on the second vCluster, created in the namespace ns made
// again, the instance Ready on it, and no restart of its control plane.
func (h *nsHarness) assertHostResynced(ns string) *v1alpha1.PlatformInstance {
	h.t.Helper()
	inst := h.get()
	if len(h.in.installs) != 2 || !h.in.installs[1].Refresh || !h.in.installs[1].ReinstallRelease {
		h.t.Fatalf("want one reinstall: %+v", h.in.installs)
	}
	if conditionReason(inst, v1alpha1.ConditionInstalled) != ReasonResync ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) ||
		inst.Status.Phase != v1alpha1.PhaseReady || inst.Status.Target != (v1alpha1.TargetStatus{ServiceUID: "svc-uid-2"}) {
		h.t.Fatalf("after the resync: %+v", inst.Status)
	}
	if n := h.namespace(ns); n == nil || n.DeletionTimestamp != nil || h.helm.n != 2 || h.podDeletes != 0 || len(h.in.uninstalls) != 1 {
		h.t.Fatalf("namespace %+v, %d vclusters, %d pod restarts, %d state drops", n, h.helm.n, h.podDeletes, len(h.in.uninstalls))
	}
	return inst
}

// Deleting an installed instance's host namespace (#490) is a resync, like an owner-Service
// delete: Ready drops in the first round that sees the namespace terminating and the stale
// install state is dropped; nothing is created while it terminates; once it is gone the namespace
// and a vCluster are created again, the platform is installed once more (Installed=Resync), and
// the instance is Ready on the new vCluster, with no error loop and no restart of the new
// control plane.
func TestHostNamespaceDeleteResyncs(t *testing.T) {
	h := newNSHarness(t, "")
	h.installed()
	ns := h.ns()
	h.hold()
	if err := h.c.Delete(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
		t.Fatal(err)
	}

	h.step()
	inst := h.get()
	if meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) ||
		conditionReason(inst, v1alpha1.ConditionTargetReady) != "HostNamespaceDeleted" {
		t.Fatalf("Ready while the host namespace terminates: %+v", inst.Status)
	}
	if len(h.in.uninstalls) != 1 || h.in.uninstalls[0].Destroy || h.in.state != nil {
		t.Fatalf("install state of the lost vcluster kept: uninstalls %+v", h.in.uninstalls)
	}

	for range 3 {
		h.step()
	}
	inst = h.get()
	if n := h.namespace(ns); n == nil || n.DeletionTimestamp == nil || len(h.in.installs) != 1 || h.helm.n != 1 ||
		conditionReason(inst, v1alpha1.ConditionTargetReady) != "Resyncing" ||
		meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) || len(h.errs) != 0 {
		t.Fatalf("while terminating: %d installs, %d vclusters, errors %v, status %+v", len(h.in.installs), h.helm.n, h.errs, inst.Status)
	}

	h.release(ns)
	for range 6 {
		h.step()
	}
	if len(h.errs) != 0 {
		t.Fatalf("errors during the resync: %v", h.errs)
	}
	inst = h.assertHostResynced(ns)
	var secret corev1.Secret
	if err := h.c.Get(context.Background(), client.ObjectKey{Namespace: key.Namespace, Name: kubeconfigSecretName(inst)}, &secret); err != nil ||
		!bytes.Contains(secret.Data[KubeconfigKey], []byte(base64.StdEncoding.EncodeToString([]byte("ca-2")))) {
		t.Fatalf("instance kubeconfig not for the new vcluster: %v", err)
	}
}

// The namespace the operator deletes while it deletes the instance never starts a resync: the
// instance is deleted, and its namespace is not created again.
func TestInstanceDeleteDoesNotResyncItsHostNamespace(t *testing.T) {
	h := newNSHarness(t, v1alpha1.DeletionDelete)
	h.installed()
	ns := h.ns()
	h.hold()
	if err := h.c.Delete(context.Background(), h.get()); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		h.step()
	}
	inst := h.get()
	n := h.namespace(ns)
	if n == nil || n.DeletionTimestamp == nil || len(h.in.installs) != 1 || len(h.in.uninstalls) != 0 ||
		inst.Status.Target.ResyncServiceUID != "" || conditionReason(inst, v1alpha1.ConditionTargetReady) == "HostNamespaceDeleted" ||
		inst.Status.Phase != v1alpha1.PhaseDeleting || len(h.errs) != 0 {
		t.Fatalf("deleting: namespace %+v, %d installs, %d state drops, errors %v, status %+v", n, len(h.in.installs), len(h.in.uninstalls), h.errs, inst.Status)
	}

	h.release(ns)
	h.step()
	h.finishCleanup(batchv1.JobComplete)
	h.step()
	// The delete path drops the install state itself (once per round that finds the target gone).
	if !h.released() || h.namespace(ns) != nil || len(h.in.installs) != 1 || len(h.in.uninstalls) == 0 || h.helm.n != 1 || len(h.errs) != 0 {
		t.Fatalf("after delete: released %v, namespace %v, %d installs, %d state drops, %d vclusters, errors %v",
			h.released(), h.namespace(ns), len(h.in.installs), len(h.in.uninstalls), h.helm.n, h.errs)
	}
}

// A round whose cache still has the instance from before the resync was recorded doesn't take
// the namespace for a new loss: the install state is dropped once, and the resync goes on to one
// reinstall (#481's guard).
func TestHostNamespaceDeleteStaleCache(t *testing.T) {
	h := newNSHarness(t, "")
	before := h.installed()
	ns := h.ns()
	if err := h.c.Delete(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
		t.Fatal(err)
	}
	h.step()
	if got := h.get().Status.Target.ResyncServiceUID; got == "" || len(h.in.uninstalls) != 1 {
		t.Fatalf("resync not recorded: %q, %d state drops", got, len(h.in.uninstalls))
	}
	live := h.c
	h.r.Client = staleCache(live.(client.WithWatch), before)
	h.step()
	if len(h.in.uninstalls) != 1 || len(h.errs) != 0 {
		t.Fatalf("stale round: %d state drops, errors %v", len(h.in.uninstalls), h.errs)
	}
	h.r.Client = live
	for range 6 {
		h.step()
	}
	inst := h.get()
	if len(h.in.installs) != 2 || conditionReason(inst, v1alpha1.ConditionInstalled) != ReasonResync ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) || len(h.errs) != 0 || h.podDeletes != 0 {
		t.Fatalf("after the resync: %d installs, %d pod restarts, errors %v, status %+v", len(h.in.installs), h.podDeletes, h.errs, inst.Status)
	}
}

// Dropping the install state of the lost target fails (#514): the instance reports the failure
// and records no resync marker, so the namespace isn't created again on top of the stale state.
// Each round retries the drop; once it succeeds, the resync goes on to one reinstall.
func TestHostNamespaceDeleteRetriesAFailedStateDrop(t *testing.T) {
	h := newNSHarness(t, "")
	h.installed()
	ns := h.ns()
	h.in.failUninstalls = 2
	rec := events.NewFakeRecorder(20)
	h.r.Recorder = rec
	h.hold()
	if err := h.c.Delete(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
		t.Fatal(err)
	}
	h.release(ns) // gone with the vCluster before the first round

	for i := range 2 {
		h.step()
		inst := h.get()
		ready := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionTargetReady)
		if len(h.errs) != i+1 || inst.Status.Phase != v1alpha1.PhaseFailed || ready == nil ||
			ready.Reason != "HostNamespaceDeleted" || !strings.Contains(ready.Message, "dropping the install state of the lost target failed") ||
			meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) {
			t.Fatalf("round %d: errors %v, status %+v", i+1, h.errs, inst.Status)
		}
		if inst.Status.Target.ResyncServiceUID != "" || h.namespace(ns) != nil || h.in.state == nil ||
			len(h.in.uninstalls) != 0 || len(h.in.installs) != 1 || h.helm.n != 1 {
			t.Fatalf("round %d: marker %q, namespace %v, %d state drops, %d installs, %d vclusters", i+1,
				inst.Status.Target.ResyncServiceUID, h.namespace(ns), len(h.in.uninstalls), len(h.in.installs), h.helm.n)
		}
	}

	h.errs = nil
	h.step()
	if got := h.get().Status.Target.ResyncServiceUID; got != vcluster.ResyncHostNamespace || len(h.in.uninstalls) != 1 || h.in.state != nil {
		t.Fatalf("drop succeeded: marker %q, %d state drops", got, len(h.in.uninstalls))
	}
	// Each attempt is announced with a Warning Event.
	if len(rec.Events) != 3 {
		t.Fatalf("events %d, want one per attempt (3)", len(rec.Events))
	}
	for i := range 3 {
		if e := <-rec.Events; !strings.HasPrefix(e, "Warning HostNamespaceDeleted") {
			t.Fatalf("event %d: %q", i+1, e)
		}
	}
	for range 6 {
		h.step()
	}
	if len(h.errs) != 0 {
		t.Fatalf("errors during the resync: %v", h.errs)
	}
	h.assertHostResynced(ns)
}
