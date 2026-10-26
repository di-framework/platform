package controller

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

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
	err        error
}

func (f *fakeTarget) Ensure(context.Context, *v1alpha1.PlatformInstance) (targets.State, error) {
	f.ensures++
	return f.state, f.err
}
func (f *fakeTarget) Delete(context.Context, *v1alpha1.PlatformInstance) (bool, error) {
	f.deletes++
	return f.deleteDone, nil
}

type fakeInstaller struct {
	err        error
	deadline   bool
	installs   []installer.Request
	options    []installer.Options
	uninstalls []installer.UninstallOptions
}

func (f *fakeInstaller) Install(ctx context.Context, req installer.Request, opts installer.Options) (installer.Result, error) {
	_, f.deadline = ctx.Deadline()
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
		ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: key.Name, Generation: 1, UID: "uid-1"},
		Spec: v1alpha1.PlatformInstanceSpec{
			Version: "6.0.17", Target: v1alpha1.TargetSpec{Type: v1alpha1.TargetVCluster}, DeletionPolicy: policy,
		},
	}
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(inst).WithStatusSubresource(inst).Build()
	h := &harness{t: t, c: c, tg: &fakeTarget{}, in: &fakeInstaller{}, now: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
	h.r = &Reconciler{
		Client: c, Target: h.tg, Installer: h.in, StorageRootBase: "/var/lib/kubesolo/instances",
		CleanupNamespace: "platform-operator",
		Plan:             plan.Config{RepairInterval: 30 * time.Minute, TargetPoll: 10 * time.Second},
		Now:              func() time.Time { return h.now },
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

// Without the kubeconfig Secret, a target that isn't ready clears the reference.
func TestKubeconfigRefIsClearedWithoutTheSecret(t *testing.T) {
	h, _ := installedHarness(t)
	if err := h.c.Delete(context.Background(), &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: key.Name + "-kubeconfig"}}); err != nil {
		t.Fatal(err)
	}
	h.tg.state = targets.State{Reason: "KubeconfigPending", Message: "no Secret"}
	h.reconcile()
	if inst := h.get(); inst.Status.KubeconfigSecretRef != nil {
		t.Fatalf("reference kept without the Secret: %+v", inst.Status)
	}
}

// The finalizer is added with a merge patch carrying only metadata, so the user's spec is not
// rewritten (platform: {gateway: {}}) and its generation stays 1.
func TestFinalizerPatchLeavesTheSpecAlone(t *testing.T) {
	h := newHarness(t, "")
	var patches []string
	h.r.Client = interceptor.NewClient(h.c.(client.WithWatch), interceptor.Funcs{
		Update: func(context.Context, client.WithWatch, client.Object, ...client.UpdateOption) error {
			t.Fatal("the instance was updated, not patched")
			return nil
		},
		Patch: func(ctx context.Context, cl client.WithWatch, obj client.Object, patch client.Patch, opts ...client.PatchOption) error {
			data, err := patch.Data(obj)
			if err != nil {
				return err
			}
			patches = append(patches, string(data))
			return cl.Patch(ctx, obj, patch, opts...)
		},
	})
	h.reconcile()
	if len(patches) != 1 || strings.Contains(patches[0], "spec") || !strings.Contains(patches[0], Finalizer) || !strings.Contains(patches[0], "resourceVersion") {
		t.Fatalf("finalizer patches %q", patches)
	}
	if inst := h.get(); !containsFinalizer(inst) || inst.Generation != 1 {
		t.Fatalf("finalizer %v generation %d", inst.Finalizers, inst.Generation)
	}
}

// A target error that comes with a State (a rolled-back repair) keeps that reason in the
// condition and is returned, so controller-runtime backs off (review S8).
func TestTargetErrorKeepsTheTargetsReason(t *testing.T) {
	h, _ := installedHarness(t)
	h.tg.state = targets.State{Reason: "RolledBack", Message: "rolled back to revision 1"}
	h.tg.err = errors.New("rolled back vcluster release")
	if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); err == nil {
		t.Fatal("no error to back off on")
	}
	inst := h.get()
	if c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionTargetReady); c == nil || c.Reason != "RolledBack" || c.Message != "rolled back to revision 1" {
		t.Fatalf("TargetReady %+v", c)
	}

	h.tg.state = targets.State{}
	h.tg.err = errors.New("boom")
	h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	if got := conditionReason(h.get(), v1alpha1.ConditionTargetReady); got != "TargetError" {
		t.Fatalf("plain error reason %q", got)
	}
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
		"storageRoot": "/var/lib/kubesolo/instances/team-a/one", "kubernetesEndpoint": "https://vcluster.pi-team-a-one.svc:443",
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
	// The retry refreshes first (the failed run may have created resources), and its success
	// replaces the failure.
	h.in.err = nil
	h.reconcile()
	if inst = h.get(); inst.Status.Phase != v1alpha1.PhaseReady {
		t.Fatalf("recovered status %+v", inst.Status)
	}
	if len(h.in.options) != 2 || !h.in.options[1].Refresh || conditionReason(inst, v1alpha1.ConditionInstalled) != plan.ReasonRetry {
		t.Fatalf("retry options %+v reason %q", h.in.options, conditionReason(inst, v1alpha1.ConditionInstalled))
	}
}

func TestFailedRetryAfterAnUpgradeIsARetry(t *testing.T) {
	h, _ := installedHarness(t)
	inst := h.get()
	inst.Spec.Version = "6.0.18"
	inst.Generation = 2
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.in.err = errors.New("npm install failed")
	_, _ = h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key})
	h.in.err = nil
	h.reconcile()
	if r := conditionReason(h.get(), v1alpha1.ConditionInstalled); r != plan.ReasonRetry || !h.in.options[2].Refresh {
		t.Fatalf("retry reason %q options %+v", r, h.in.options)
	}
}

// A target that stops answering for a while (control plane restart) must not leave the instance
// Failed or Provisioning until the next repair once it answers again.
func TestReadyComesBackAfterATargetBlip(t *testing.T) {
	h, _ := installedHarness(t)
	h.tg.state = targets.State{Reason: "ControlPlanePending", Message: "vcluster control plane not ready"}
	h.reconcile()
	// The kubeconfig Secret still exists, so its reference stays (#453 review S3).
	if inst := h.get(); inst.Status.Phase != v1alpha1.PhaseProvisioning || inst.Status.KubeconfigSecretRef == nil {
		t.Fatalf("blip status %+v", inst.Status)
	}
	h.readyTarget()
	h.now = h.now.Add(time.Minute)
	res := h.reconcile()
	inst := h.get()
	if inst.Status.Phase != v1alpha1.PhaseReady || inst.Status.KubeconfigSecretRef == nil ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionTargetReady) {
		t.Fatalf("status after the blip %+v", inst.Status)
	}
	if len(h.in.installs) != 1 || res.RequeueAfter != 29*time.Minute {
		t.Fatalf("recovery reinstalled (%d) or requeued %v", len(h.in.installs), res.RequeueAfter)
	}
}

func TestHTTPEndpointIsPassedToTheInstall(t *testing.T) {
	h := newHarness(t, "")
	inst := h.get()
	inst.Spec.Platform.Gateway.HTTPEndpoint = "http://apps.example:30080"
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	if got := h.in.installs[0].Settings["httpEndpoint"]; got != "http://apps.example:30080" {
		t.Fatalf("httpEndpoint setting %v", got)
	}
}

func TestInstallTimeoutBoundsTheInstall(t *testing.T) {
	h := newHarness(t, "")
	h.r.InstallTimeout = time.Minute
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	if !h.in.deadline {
		t.Fatal("install ran without a deadline")
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
	// The default storageRoot goes last; the finalizer holds until its Job completes.
	if !containsFinalizer(h.get()) || h.cleanupJob() == nil {
		t.Fatal("released before the storageRoot was cleaned")
	}
	h.finishCleanup(batchv1.JobComplete)
	h.reconcile()
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
	if len(h.in.uninstalls) != 0 || h.tg.deletes != 0 || h.jobCount() != 0 {
		t.Fatalf("Retain touched the target or storage: uninstalls %d deletes %d jobs %d", len(h.in.uninstalls), h.tg.deletes, h.jobCount())
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
