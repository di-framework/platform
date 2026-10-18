package controller

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/installer"
	"github.com/di-framework/platform/operator/internal/plan"
	"github.com/di-framework/platform/operator/internal/targets"
)

type fakeTarget struct {
	state      targets.State
	ensures    int
	deletes    int
	deleteDone bool
}

func (f *fakeTarget) Ensure(context.Context, *v1alpha1.PlatformInstance) (targets.State, error) {
	f.ensures++
	return f.state, nil
}
func (f *fakeTarget) Delete(context.Context, *v1alpha1.PlatformInstance) (bool, error) {
	f.deletes++
	return f.deleteDone, nil
}

type fakeInstaller struct {
	err        error
	installs   []installer.Request
	options    []installer.Options
	uninstalls []installer.UninstallOptions
}

func (f *fakeInstaller) Install(_ context.Context, req installer.Request, opts installer.Options) (installer.Result, error) {
	f.installs, f.options = append(f.installs, req), append(f.options, opts)
	return installer.Result{KubernetesEndpoint: "https://k", HTTPEndpoint: "http://h"}, f.err
}
func (f *fakeInstaller) Status(context.Context, installer.Request) (installer.State, error) {
	return installer.State{}, nil
}
func (f *fakeInstaller) Uninstall(_ context.Context, _ installer.Request, opts installer.UninstallOptions) error {
	f.uninstalls = append(f.uninstalls, opts)
	return nil
}

var key = types.NamespacedName{Namespace: "team-a", Name: "one"}

type harness struct {
	t   *testing.T
	c   client.Client
	r   *Reconciler
	tg  *fakeTarget
	in  *fakeInstaller
	now time.Time
}

func newHarness(t *testing.T, policy v1alpha1.DeletionPolicy) *harness {
	t.Helper()
	s := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{clientgoscheme.AddToScheme, v1alpha1.AddToScheme} {
		if err := add(s); err != nil {
			t.Fatal(err)
		}
	}
	inst := &v1alpha1.PlatformInstance{
		ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: key.Name, Generation: 1},
		Spec: v1alpha1.PlatformInstanceSpec{
			Version: "6.0.17", Target: v1alpha1.TargetSpec{Type: v1alpha1.TargetVCluster}, DeletionPolicy: policy,
		},
	}
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(inst).WithStatusSubresource(inst).Build()
	h := &harness{t: t, c: c, tg: &fakeTarget{}, in: &fakeInstaller{}, now: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	h.r = &Reconciler{
		Client: c, Target: h.tg, Installer: h.in, StorageRootBase: "/var/lib/kubesolo/instances",
		Plan: plan.Config{RepairInterval: 30 * time.Minute, TargetPoll: 10 * time.Second},
		Now:  func() time.Time { return h.now },
	}
	return h
}

func (h *harness) reconcile() ctrl.Result {
	h.t.Helper()
	res, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	if err != nil && h.in.err == nil {
		h.t.Fatalf("reconcile: %v", err)
	}
	return res
}

func (h *harness) get() *v1alpha1.PlatformInstance {
	h.t.Helper()
	var inst v1alpha1.PlatformInstance
	if err := h.c.Get(context.Background(), key, &inst); err != nil {
		h.t.Fatal(err)
	}
	return &inst
}

func (h *harness) readyTarget() {
	h.tg.state = targets.State{Ready: true, Kubeconfig: []byte("kubeconfig-bytes"), Server: "https://vcluster.pi-team-a-one.svc:443"}
}

// installedHarness runs an instance through finalizer and first install with a ready target.
func installedHarness(t *testing.T) (*harness, ctrl.Result) {
	t.Helper()
	h := newHarness(t, "")
	h.readyTarget()
	h.reconcile()
	return h, h.reconcile()
}

func TestFinalizerComesFirst(t *testing.T) {
	h := newHarness(t, "")
	h.reconcile()
	if !containsFinalizer(h.get()) || h.tg.ensures != 0 {
		t.Fatalf("first reconcile must only add the finalizer (ensures %d)", h.tg.ensures)
	}
}

func TestPendingTargetIsProvisioning(t *testing.T) {
	h := newHarness(t, "")
	h.reconcile()
	h.tg.state = targets.State{Reason: "ControlPlanePending", Message: "not ready"}
	if res := h.reconcile(); res.RequeueAfter != 10*time.Second {
		t.Fatalf("pending target requeue %v", res.RequeueAfter)
	}
	inst := h.get()
	if inst.Status.Phase != v1alpha1.PhaseProvisioning || conditionReason(inst, v1alpha1.ConditionTargetReady) != "ControlPlanePending" {
		t.Fatalf("provisioning status %+v", inst.Status)
	}
	if len(h.in.installs) != 0 {
		t.Fatal("installed before the target was ready")
	}
}

func TestReadyStatus(t *testing.T) {
	h, res := installedHarness(t)
	if res.RequeueAfter != 30*time.Minute {
		t.Fatalf("ready requeue %v, want the repair interval", res.RequeueAfter)
	}
	s := h.get().Status
	if s.Phase != v1alpha1.PhaseReady || s.InstalledVersion != "6.0.17" || s.ObservedGeneration != 1 {
		t.Fatalf("ready status %+v", s)
	}
	if !meta.IsStatusConditionTrue(s.Conditions, v1alpha1.ConditionReady) || s.Endpoints.HTTP != "http://h" {
		t.Fatalf("ready conditions/endpoints %+v", s)
	}
	if s.KubeconfigSecretRef == nil || s.KubeconfigSecretRef.Name != "one-kubeconfig" {
		t.Fatalf("kubeconfig ref %+v", s.KubeconfigSecretRef)
	}
}

func TestKubeconfigSecretIsOwned(t *testing.T) {
	h, _ := installedHarness(t)
	var secret corev1.Secret
	if err := h.c.Get(context.Background(), types.NamespacedName{Namespace: "team-a", Name: "one-kubeconfig"}, &secret); err != nil {
		t.Fatal(err)
	}
	if string(secret.Data[KubeconfigKey]) != "kubeconfig-bytes" || len(secret.OwnerReferences) != 1 {
		t.Fatalf("kubeconfig Secret %+v", secret)
	}
}

func TestInstallRequest(t *testing.T) {
	h, _ := installedHarness(t)
	req := h.in.installs[0]
	want := map[string]any{
		"namespace": "wasmcloud", "networkPolicyEngine": "existing", "httpNodePort": 0,
		"storageRoot": "/var/lib/kubesolo/instances/team-a-one", "kubernetesEndpoint": "https://vcluster.pi-team-a-one.svc:443",
	}
	if req.ID != "team-a.one" || req.Version != "6.0.17" || !reflect.DeepEqual(req.Settings, want) {
		t.Fatalf("install request %+v", req)
	}
	if h.in.options[0].Refresh {
		t.Fatal("first install must not refresh")
	}
}

func TestRepairRunsAfterTheInterval(t *testing.T) {
	h, _ := installedHarness(t)
	h.now = h.now.Add(10 * time.Minute)
	if res := h.reconcile(); res.RequeueAfter != 20*time.Minute || len(h.in.installs) != 1 {
		t.Fatalf("early reconcile requeue %v installs %d", res.RequeueAfter, len(h.in.installs))
	}
	h.now = h.now.Add(20 * time.Minute)
	h.reconcile()
	if len(h.in.installs) != 2 || !h.in.options[1].Refresh {
		t.Fatalf("repair: installs %d options %+v", len(h.in.installs), h.in.options)
	}
}

func TestVersionBumpUpgradesInPlace(t *testing.T) {
	h := newHarness(t, "")
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	inst := h.get()
	inst.Spec.Version = "6.0.18"
	inst.Generation = 2
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.reconcile()
	inst = h.get()
	if len(h.in.installs) != 2 || h.in.installs[1].Version != "6.0.18" || inst.Status.InstalledVersion != "6.0.18" {
		t.Fatalf("upgrade: installs %+v status %+v", h.in.installs, inst.Status)
	}
	if conditionReason(inst, v1alpha1.ConditionInstalled) != "VersionChanged" || h.tg.deletes != 0 {
		t.Fatalf("upgrade reason %q, deletes %d", conditionReason(inst, v1alpha1.ConditionInstalled), h.tg.deletes)
	}
}

func TestInstallFailureIsReadable(t *testing.T) {
	h := newHarness(t, "")
	h.readyTarget()
	h.reconcile()
	h.in.err = errors.New("kubernetes API unreachable")
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err == nil {
		t.Fatal("install failure must be returned for backoff")
	}
	inst := h.get()
	c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionInstalled)
	if inst.Status.Phase != v1alpha1.PhaseFailed || c == nil || c.Reason != "InstallFailed" ||
		c.Message != "FirstInstall of 6.0.17 failed: kubernetes API unreachable" {
		t.Fatalf("failure status %+v", inst.Status)
	}
	// The next success replaces the failure.
	h.in.err = nil
	h.reconcile()
	if inst = h.get(); inst.Status.Phase != v1alpha1.PhaseReady {
		t.Fatalf("recovered status %+v", inst.Status)
	}
}

func TestDeletePolicyUninstallsThenReleases(t *testing.T) {
	h := newHarness(t, v1alpha1.DeletionDelete)
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	if err := h.c.Delete(context.Background(), h.get()); err != nil {
		t.Fatal(err)
	}

	h.reconcile() // target still deleting: install state stays until it's gone
	if len(h.in.uninstalls) != 0 || h.tg.deletes != 1 || !containsFinalizer(h.get()) {
		t.Fatalf("first delete round: uninstalls %d deletes %d", len(h.in.uninstalls), h.tg.deletes)
	}
	if inst := h.get(); inst.Status.Phase != v1alpha1.PhaseDeleting {
		t.Fatalf("phase %s, want Deleting", inst.Status.Phase)
	}
	h.tg.deleteDone = true
	h.reconcile()
	if len(h.in.uninstalls) != 1 || h.in.uninstalls[0].Destroy {
		t.Fatalf("uninstall %+v: want one, without destroy (the target took everything)", h.in.uninstalls)
	}
	var inst v1alpha1.PlatformInstance
	if err := h.c.Get(context.Background(), key, &inst); err == nil {
		t.Fatalf("instance still present after release: %+v", inst.Finalizers)
	}
}

func TestRetainPolicyKeepsEverything(t *testing.T) {
	h := newHarness(t, v1alpha1.DeletionRetain)
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	if err := h.c.Delete(context.Background(), h.get()); err != nil {
		t.Fatal(err)
	}
	h.reconcile()
	if len(h.in.uninstalls) != 0 || h.tg.deletes != 0 {
		t.Fatalf("Retain touched the target: uninstalls %d deletes %d", len(h.in.uninstalls), h.tg.deletes)
	}
	var inst v1alpha1.PlatformInstance
	if err := h.c.Get(context.Background(), key, &inst); err == nil {
		t.Fatal("instance still present after Retain release")
	}
}

func TestUnsupportedTarget(t *testing.T) {
	h := newHarness(t, "")
	inst := h.get()
	inst.Spec.Target.Type = "kind"
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.reconcile()
	if inst = h.get(); conditionReason(inst, v1alpha1.ConditionTargetReady) != "UnsupportedTarget" || h.tg.ensures != 0 {
		t.Fatalf("unsupported target status %+v", inst.Status)
	}
}

func containsFinalizer(inst *v1alpha1.PlatformInstance) bool {
	for _, f := range inst.Finalizers {
		if f == Finalizer {
			return true
		}
	}
	return false
}

func conditionReason(inst *v1alpha1.PlatformInstance, typ string) string {
	if c := meta.FindStatusCondition(inst.Status.Conditions, typ); c != nil {
		return c.Reason
	}
	return ""
}

func TestReadableMessages(t *testing.T) {
	if got := readable("\x1b[36m<ref>\x1b[39m failed"); got != "<ref> failed" {
		t.Fatalf("colour codes kept: %q", got)
	}
	long := "start " + strings.Repeat("x", 5000) + " the cause"
	got := readable(long)
	if len(got) > MaxMessage || !strings.HasPrefix(got, "start ") || !strings.HasSuffix(got, " the cause") {
		t.Fatalf("long message: %d bytes, %q…%q", len(got), got[:10], got[len(got)-12:])
	}
}
