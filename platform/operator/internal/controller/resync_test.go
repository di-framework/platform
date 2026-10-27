package controller

import (
	"context"
	"errors"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/plan"
	"github.com/di-framework/platform/operator/internal/targets"
)

// The first install records the uid of the target's owner Service; an unchanged uid later
// changes nothing (gate 4.7).
func TestInstallRecordsTheServiceUID(t *testing.T) {
	h := newHarness(t, "")
	h.readyTarget()
	h.tg.state.ServiceUID = "uid-a"
	h.reconcile()
	h.reconcile()
	if got := h.get().Status.Target; got.ServiceUID != "uid-a" || got.ResyncServiceUID != "" {
		t.Fatalf("target status %+v", got)
	}
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	if len(h.in.installs) != 1 {
		t.Fatalf("an unchanged Service reinstalled: %d installs", len(h.in.installs))
	}
}

// An instance installed before the uid was recorded gets it without an install.
func TestReadyRecordsAMissingServiceUID(t *testing.T) {
	h, _ := installedHarness(t)
	h.tg.state.ServiceUID = "uid-a"
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	if got := h.get().Status.Target.ServiceUID; got != "uid-a" || len(h.in.installs) != 1 {
		t.Fatalf("uid %q after %d installs", got, len(h.in.installs))
	}
}

// A resync (#466): the target restarts the control plane and reports Resyncing, which is
// recorded; once it is back, the platform is installed again with a refresh before the repair
// is due, and the instance is Ready on the new Service.
func TestResyncForcesAnInstall(t *testing.T) {
	h := newHarness(t, "")
	h.readyTarget()
	h.tg.state.ServiceUID = "uid-a"
	h.reconcile()
	h.reconcile()

	h.tg.state = targets.State{Reason: "Resyncing", Message: "service replaced", ResyncStarted: "uid-b"}
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	inst := h.get()
	if inst.Status.Target.ResyncServiceUID != "uid-b" || conditionReason(inst, v1alpha1.ConditionTargetReady) != "Resyncing" ||
		meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) {
		t.Fatalf("resync status %+v", inst.Status)
	}

	h.readyTarget()
	h.tg.state.ServiceUID, h.tg.state.Resynced = "uid-b", true
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	inst = h.get()
	if len(h.in.installs) != 2 || !h.in.options[1].Refresh || !h.in.options[1].ReinstallRelease || h.in.options[0].ReinstallRelease {
		t.Fatalf("installs %d options %+v", len(h.in.installs), h.in.options)
	}
	if inst.Status.Target != (v1alpha1.TargetStatus{ServiceUID: "uid-b"}) ||
		conditionReason(inst, v1alpha1.ConditionInstalled) != ReasonResync ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionTargetReady) ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) {
		t.Fatalf("after resync %+v", inst.Status)
	}
}

// While the reinstall after a resync runs, TargetReady stays Resyncing; a failed one keeps the
// resync pending, so the next round tries again.
func TestFailedResyncInstallStaysPending(t *testing.T) {
	h := newHarness(t, "")
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	h.tg.state.ServiceUID, h.tg.state.Resynced = "uid-b", true
	h.in.err = errors.New("pulumi up failed")
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	inst := h.get()
	if conditionReason(inst, v1alpha1.ConditionTargetReady) != "Resyncing" || inst.Status.Target.ServiceUID == "uid-b" {
		t.Fatalf("failed resync install %+v", inst.Status)
	}
	// The retry round succeeds and clears the resync marker.
	h.in.err = nil
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	inst = h.get()
	if inst.Status.Target != (v1alpha1.TargetStatus{ServiceUID: "uid-b"}) || !h.in.options[len(h.in.options)-1].ReinstallRelease ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionTargetReady) {
		t.Fatalf("retry %+v", inst.Status)
	}
}

// resyncedHarness records a resync to uid-b and brings the target back Ready and Resynced; the
// APIReader reads the fake API server directly.
func resyncedHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t, "")
	h.r.APIReader = h.c
	h.readyTarget()
	h.tg.state.ServiceUID = "uid-a"
	h.reconcile()
	h.reconcile()
	h.tg.state = targets.State{Reason: "Resyncing", Message: "service replaced", ResyncStarted: "uid-b"}
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	h.readyTarget()
	h.tg.state.ServiceUID, h.tg.state.Resynced = "uid-b", true
	return h
}

// staleCache serves PlatformInstance reads from snapshot, as an informer that hasn't seen the
// latest status patch would; writes and other reads reach the API server.
func staleCache(c client.WithWatch, snapshot *v1alpha1.PlatformInstance) client.Client {
	return interceptor.NewClient(c, interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, k client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if inst, ok := obj.(*v1alpha1.PlatformInstance); ok {
				snapshot.DeepCopyInto(inst)
				return nil
			}
			return c.Get(ctx, k, obj, opts...)
		},
	})
}

// With an up-to-date cache the resync reinstalls once and reports Installed=Resync (#472).
func TestResyncReinstallsOnce(t *testing.T) {
	h := resyncedHarness(t)
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	h.now = h.now.Add(time.Second)
	h.reconcile()
	inst := h.get()
	if len(h.in.installs) != 2 || !h.in.options[1].ReinstallRelease || !h.in.options[1].Refresh {
		t.Fatalf("installs %d options %+v", len(h.in.installs), h.in.options)
	}
	if got := conditionReason(inst, v1alpha1.ConditionInstalled); got != ReasonResync {
		t.Fatalf("Installed reason %q", got)
	}
	if inst.Status.Target != (v1alpha1.TargetStatus{ServiceUID: "uid-b"}) {
		t.Fatalf("target status %+v", inst.Status.Target)
	}
}

// The reconcile after the reinstall can read a cached instance that still carries the resync
// marker, while the target still reports Resynced from it. The live read finds the marker
// cleared, so the platform isn't reinstalled a second time (#472).
func TestResyncStaleCacheDoesNotReinstallAgain(t *testing.T) {
	h := resyncedHarness(t)
	stale := h.get()
	if stale.Status.Target.ResyncServiceUID != "uid-b" {
		t.Fatalf("resync not recorded: %+v", stale.Status.Target)
	}
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	if len(h.in.installs) != 2 || !h.in.options[1].ReinstallRelease {
		t.Fatalf("resync install: %d options %+v", len(h.in.installs), h.in.options)
	}

	h.r.Client = staleCache(h.c.(client.WithWatch), stale)
	h.now = h.now.Add(time.Second)
	h.reconcile()
	if len(h.in.installs) != 2 || len(h.in.uninstalls) != 0 {
		t.Fatalf("reinstalled again from a stale cache: %d installs options %+v, %d uninstalls",
			len(h.in.installs), h.in.options, len(h.in.uninstalls))
	}
	inst := h.get()
	if inst.Status.Phase != v1alpha1.PhaseReady || inst.Status.Target != (v1alpha1.TargetStatus{ServiceUID: "uid-b"}) ||
		conditionReason(inst, v1alpha1.ConditionInstalled) != ReasonResync ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionTargetReady) ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) {
		t.Fatalf("after stale reconcile %+v", inst.Status)
	}
}

// A resync that comes back after the repair interval elapsed would plan Repair/RepairDue; the
// Installed reason is still Resync (#472).
func TestResyncReasonWhenRepairIsDue(t *testing.T) {
	h := resyncedHarness(t)
	h.now = h.now.Add(h.r.Plan.RepairInterval + time.Minute)
	obs := h.r.observe(h.get())
	obs.TargetReady = true
	if d := plan.Next(obs, h.r.Plan); d.Action != plan.Repair || d.Reason != "RepairDue" {
		t.Fatalf("plan without the resync: %+v", d)
	}
	h.reconcile()
	inst := h.get()
	if len(h.in.installs) != 2 || !h.in.options[1].ReinstallRelease {
		t.Fatalf("installs %d options %+v", len(h.in.installs), h.in.options)
	}
	if got := conditionReason(inst, v1alpha1.ConditionInstalled); got != ReasonResync {
		t.Fatalf("Installed reason %q, want %q", got, ReasonResync)
	}
}
