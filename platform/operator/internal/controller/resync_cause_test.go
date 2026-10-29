package controller

import (
	"context"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets/vcluster"
)

const hostNamespaceCause = "host namespace was deleted"

// conditionMessage returns the message of condition cond, or "" if it is not set.
func conditionMessage(inst *v1alpha1.PlatformInstance, cond string) string {
	if c := meta.FindStatusCondition(inst.Status.Conditions, cond); c != nil {
		return c.Message
	}
	return ""
}

// The cause of a host-namespace resync stays in status for every round of it (#536): the
// rounds after the one that saw the delete report TargetReady=Resyncing, and still name the
// host-namespace delete in TargetReady and Ready until the instance is Ready again. Ready clears
// it.
func TestHostNamespaceDeleteCauseStaysUntilReady(t *testing.T) {
	h := newNSHarness(t, "")
	h.installed()
	ns := h.ns()
	h.hold()
	if err := h.c.Delete(context.Background(), &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
		t.Fatal(err)
	}

	resyncing, ready := 0, false
	for round := 1; round <= 12; round++ {
		if round == 4 {
			h.release(ns)
		}
		h.step()
		inst := h.get()
		if meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) {
			ready = true
			break
		}
		if conditionReason(inst, v1alpha1.ConditionTargetReady) == vcluster.ReasonResyncing {
			resyncing++
		}
		// The round that sees the delete reports it as the TargetReady reason; the later ones
		// name it in the TargetReady message.
		named := conditionReason(inst, v1alpha1.ConditionTargetReady) == vcluster.ReasonHostNamespaceDeleted ||
			strings.Contains(conditionMessage(inst, v1alpha1.ConditionTargetReady), hostNamespaceCause)
		if !named || inst.Status.Target.ResyncCause != vcluster.ReasonHostNamespaceDeleted ||
			conditionReason(inst, v1alpha1.ConditionReady) != vcluster.ReasonHostNamespaceDeleted {
			t.Fatalf("round %d lost the cause: %+v", round, inst.Status)
		}
	}
	if !ready || resyncing < 2 || len(h.errs) != 0 {
		t.Fatalf("ready %v after %d Resyncing rounds, errors %v", ready, resyncing, h.errs)
	}
	inst := h.assertHostResynced(ns)
	if inst.Status.Target.ResyncCause != "" || conditionReason(inst, v1alpha1.ConditionReady) != "Ready" ||
		strings.Contains(conditionMessage(inst, v1alpha1.ConditionTargetReady), hostNamespaceCause) {
		t.Fatalf("cause left after Ready: %+v", inst.Status)
	}
	h.step()
	if inst = h.get(); inst.Status.Target.ResyncCause != "" || len(h.in.installs) != 2 {
		t.Fatalf("round after Ready: %d installs, status %+v", len(h.in.installs), inst.Status)
	}
}

// An owner-Service resync (#466, #481) is not a host-namespace delete: no round records a
// cause or names the namespace, and Ready waits as TargetPending.
func TestOwnerServiceResyncHasNoHostNamespaceCause(t *testing.T) {
	h, restarts := resyncRestartHarness(t, 0)
	resyncing, pending := 0, 0
	for round := 1; round <= 6; round++ {
		h.step()
		inst := h.get()
		if conditionReason(inst, v1alpha1.ConditionTargetReady) == vcluster.ReasonResyncing {
			resyncing++
		}
		if inst.Status.Target.ResyncCause != "" ||
			conditionReason(inst, v1alpha1.ConditionReady) == vcluster.ReasonHostNamespaceDeleted ||
			strings.Contains(conditionMessage(inst, v1alpha1.ConditionTargetReady), hostNamespaceCause) ||
			strings.Contains(conditionMessage(inst, v1alpha1.ConditionReady), hostNamespaceCause) {
			t.Fatalf("round %d labelled as a host-namespace delete: %+v", round, inst.Status)
		}
		if conditionReason(inst, v1alpha1.ConditionReady) == "TargetPending" {
			pending++
		}
	}
	if resyncing == 0 || pending == 0 || len(h.errs) != 0 {
		t.Fatalf("%d Resyncing rounds, %d TargetPending rounds, errors %v", resyncing, pending, h.errs)
	}
	assertResyncedOnce(t, h, *restarts)
}

// An instance Ready again without a reinstall drops a cause left in its status.
func TestMarkReadyClearsTheResyncCause(t *testing.T) {
	h, _ := installedHarness(t)
	inst := h.get()
	base := inst.DeepCopy()
	inst.Status.Target.ResyncCause = vcluster.ReasonHostNamespaceDeleted
	if err := h.c.Status().Patch(context.Background(), inst, client.MergeFrom(base)); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(time.Minute)
	h.reconcile()
	inst = h.get()
	if inst.Status.Target.ResyncCause != "" || !meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) {
		t.Fatalf("cause kept on a Ready instance: %+v", inst.Status)
	}
}

// withResyncCause names a recorded cause once, and leaves a message without one alone.
func TestWithResyncCause(t *testing.T) {
	var s v1alpha1.PlatformInstanceStatus
	if got := withResyncCause(&s, "resyncing: x"); got != "resyncing: x" {
		t.Fatalf("no cause: %q", got)
	}
	s.Target.ResyncCause = vcluster.ReasonHostNamespaceDeleted
	if got := withResyncCause(&s, "resyncing: x"); got != "host namespace was deleted; resyncing: x" {
		t.Fatalf("cause: %q", got)
	}
	if got := withResyncCause(&s, "resyncing: host namespace was deleted; y"); got != "resyncing: host namespace was deleted; y" {
		t.Fatalf("cause named twice: %q", got)
	}
	s.Target.ResyncCause = "OtherLoss"
	if got := withResyncCause(&s, "m"); got != "OtherLoss; m" {
		t.Fatalf("unknown cause: %q", got)
	}
}
