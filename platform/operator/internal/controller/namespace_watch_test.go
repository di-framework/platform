package controller

import (
	"context"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/di-framework/platform/operator/internal/targets/vcluster"
)

func hostNS(deleting bool, labels, annotations map[string]string) *corev1.Namespace {
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "pi-team-a-one-0123456789", Labels: labels, Annotations: annotations}}
	if deleting {
		now := metav1.Now()
		ns.DeletionTimestamp = &now
	}
	return ns
}

// A host namespace that starts terminating, or is gone, wakes the instance its owner annotation
// names (#490); other namespaces and other events don't.
func TestHostNamespaceEventsWakeTheirInstance(t *testing.T) {
	labels := map[string]string{vcluster.HostNamespaceLabel: "true"}
	owner := map[string]string{vcluster.OwnerAnnotation: "team-a/one"}
	live, going := hostNS(false, labels, owner), hostNS(true, labels, owner)
	other := hostNS(true, nil, owner)

	if !hostNamespaceGoing.Update(event.UpdateEvent{ObjectOld: live, ObjectNew: going}) {
		t.Error("terminating host namespace filtered out")
	}
	if !hostNamespaceGoing.Delete(event.DeleteEvent{Object: live}) {
		t.Error("deleted host namespace filtered out")
	}
	for name, ok := range map[string]bool{
		"update of a live host namespace": hostNamespaceGoing.Update(event.UpdateEvent{ObjectOld: live, ObjectNew: live}),
		"create":                          hostNamespaceGoing.Create(event.CreateEvent{Object: live}),
		"unlabelled namespace":            hostNamespaceGoing.Update(event.UpdateEvent{ObjectOld: other, ObjectNew: other}),
		"unlabelled namespace delete":     hostNamespaceGoing.Delete(event.DeleteEvent{Object: other}),
	} {
		if ok {
			t.Errorf("%s passed", name)
		}
	}

	want := []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: "team-a", Name: "one"}}}
	if got := hostNamespaceOwner(context.Background(), going); !reflect.DeepEqual(got, want) {
		t.Fatalf("mapped to %v, want %v", got, want)
	}
	for _, a := range []string{"", "team-a", "/one", "team-a/"} {
		if got := hostNamespaceOwner(context.Background(), hostNS(true, labels, map[string]string{vcluster.OwnerAnnotation: a})); got != nil {
			t.Errorf("owner %q mapped to %v", a, got)
		}
	}
}
