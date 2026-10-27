package controller

import (
	"errors"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"

	"github.com/di-framework/platform/operator/api/v1alpha1"
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
	if len(h.in.installs) != 2 || !h.in.options[1].Refresh {
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
}
