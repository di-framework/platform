package controller

import (
	"context"
	"errors"
	"fmt"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets/vcluster"
)

// The status patch that records a resync start fails once, after the vCluster target deleted
// the vcluster-0 pod (#503). The next round reads an instance without the resync marker, and
// the real target answers it from its restart mark: the restarted pod is not deleted again, the
// resync is recorded, and it goes on to one reinstall.
func TestResyncStartPatchFailureRestartsOnce(t *testing.T) {
	h := newNSHarness(t, "")
	h.installed()
	ns := h.ns()
	ctx := context.Background()
	podKey := client.ObjectKey{Namespace: ns, Name: vcluster.ReleaseName + "-0"}
	var pod corev1.Pod
	if err := h.c.Get(ctx, podKey, &pod); err != nil {
		t.Fatal(err)
	}
	pod.UID = "pod-uid-1"
	if err := h.c.Update(ctx, &pod); err != nil {
		t.Fatal(err)
	}

	// The StatefulSet recreates the pod, with a new uid, after each delete; the status patch
	// after the first delete fails.
	restarts, failPatch := 0, false
	c := interceptor.NewClient(h.c.(client.WithWatch), interceptor.Funcs{
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if err := c.Delete(ctx, obj, opts...); err != nil {
				return err
			}
			if _, ok := obj.(*corev1.Pod); ok {
				restarts++
				failPatch = restarts == 1
				return c.Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
					Namespace: podKey.Namespace, Name: podKey.Name, UID: types.UID(fmt.Sprintf("pod-uid-%d", restarts+1))}})
			}
			return nil
		},
		SubResourcePatch: func(ctx context.Context, c client.Client, sub string, obj client.Object, p client.Patch, opts ...client.SubResourcePatchOption) error {
			if failPatch && sub == "status" {
				failPatch = false
				return errors.New("etcdserver: request timed out")
			}
			return c.SubResource(sub).Patch(ctx, obj, p, opts...)
		},
	})
	h.r.Client, h.r.APIReader = c, c
	h.r.Target.(*vcluster.Target).Client = c

	// Replace service/vcluster, which garbage-collects what vCluster synced (#466).
	var svc corev1.Service
	if err := h.c.Get(ctx, client.ObjectKey{Namespace: ns, Name: vcluster.ReleaseName}, &svc); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Delete(ctx, &svc); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Create(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: vcluster.ReleaseName, UID: "svc-uid-new"}}); err != nil {
		t.Fatal(err)
	}

	h.step()
	if restarts != 1 || len(h.errs) != 1 || h.get().Status.Target.ResyncServiceUID != "" {
		t.Fatalf("resync start with a failed status patch: %d restarts, errors %v, target %+v", restarts, h.errs, h.get().Status.Target)
	}
	h.step()
	inst := h.get()
	if restarts != 1 {
		t.Fatalf("the unrecorded resync restarted the vcluster control plane %d times", restarts)
	}
	if inst.Status.Target.ResyncServiceUID != "svc-uid-new" || conditionReason(inst, v1alpha1.ConditionTargetReady) != "Resyncing" {
		t.Fatalf("resync not recorded on the retry: %+v", inst.Status)
	}

	for range 4 {
		h.step()
	}
	inst = h.get()
	if restarts != 1 || len(h.errs) != 1 || len(h.in.installs) != 2 || !h.in.installs[1].ReinstallRelease ||
		conditionReason(inst, v1alpha1.ConditionInstalled) != ReasonResync ||
		!meta.IsStatusConditionTrue(inst.Status.Conditions, v1alpha1.ConditionReady) ||
		inst.Status.Target != (v1alpha1.TargetStatus{ServiceUID: "svc-uid-new"}) {
		t.Fatalf("after the resync: %d restarts, %d installs, errors %v, status %+v", restarts, len(h.in.installs), h.errs, inst.Status)
	}
	if n := h.namespace(ns); n.Annotations[vcluster.RestartAnnotation] != "" {
		t.Fatalf("restart mark left after the resync: %q", n.Annotations[vcluster.RestartAnnotation])
	}
}
