package controller

import (
	"strings"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/tools/events"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets"
)

// A target that can't protect its owner Service (no admission policies) is reported once, with
// a Warning Event, and the instance still installs; protection coming back flips it to True.
func TestUnprotectedOwnerServiceIsReported(t *testing.T) {
	h := newHarness(t, "")
	rec := events.NewFakeRecorder(10)
	h.r.Recorder = rec
	h.readyTarget()
	h.tg.state.Unprotected = "service/vcluster is not protected: no admission policies"
	h.reconcile()
	h.reconcile()
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	inst := h.get()
	c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionOwnerServiceProtected)
	if c == nil || c.Status != "False" || c.Reason != ReasonAdmissionPolicyUnavailable || inst.Status.Phase != v1alpha1.PhaseReady {
		t.Fatalf("status %+v", inst.Status)
	}
	if len(rec.Events) != 1 {
		t.Fatalf("events %d, want 1", len(rec.Events))
	}
	if e := <-rec.Events; !strings.HasPrefix(e, "Warning AdmissionPolicyUnavailable") {
		t.Fatalf("event %q", e)
	}

	h.tg.state.Unprotected = ""
	h.r.Recorder = nil
	h.reconcile()
	if !meta.IsStatusConditionTrue(h.get().Status.Conditions, v1alpha1.ConditionOwnerServiceProtected) {
		t.Fatalf("protection back: %+v", h.get().Status.Conditions)
	}
}

// The resync's start is recorded; a periodic repair never replaces the Release.
func TestResyncStartIsRecordedAndRepairsDontReplace(t *testing.T) {
	h, _ := installedHarness(t)
	h.now = h.now.Add(31 * time.Minute)
	h.reconcile()
	if len(h.in.options) != 2 || !h.in.options[1].Refresh || h.in.options[1].ReplaceRelease {
		t.Fatalf("repair options %+v", h.in.options)
	}
	h.tg.state = targets.State{Reason: "Resyncing", ResyncStarted: "uid-b"}
	h.reconcile()
	if got := h.get().Status.Target.ResyncStarted; got == nil || !got.Time.Equal(h.now) {
		t.Fatalf("resync start %v, want %v", got, h.now)
	}
}
