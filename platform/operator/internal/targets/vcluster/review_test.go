package vcluster

import (
	"context"
	"strings"
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// The policy and binding aren't rewritten while unchanged.
func TestAdmissionPolicyIsStableAcrossReconciles(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	ctx := context.Background()
	versions := func() (string, string) {
		var p admissionregistrationv1.ValidatingAdmissionPolicy
		var b admissionregistrationv1.ValidatingAdmissionPolicyBinding
		if err := tg.Client.Get(ctx, client.ObjectKey{Name: AdmissionPolicyName}, &p); err != nil {
			t.Fatal(err)
		}
		if err := tg.Client.Get(ctx, client.ObjectKey{Name: AdmissionPolicyName}, &b); err != nil {
			t.Fatal(err)
		}
		return p.ResourceVersion, b.ResourceVersion
	}
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	p1, b1 := versions()
	for range 3 {
		if _, err := tg.Ensure(ctx, inst); err != nil {
			t.Fatal(err)
		}
	}
	if p2, b2 := versions(); p1 != p2 || b1 != b2 {
		t.Fatalf("rewritten: policy %s -> %s, binding %s -> %s", p1, p2, b1, b2)
	}
}

// Without admission policies in the API server, Ensure reports it and carries on.
func TestEnsureWithoutAdmissionPolicies(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	tg.Client = interceptor.NewClient(tg.Client.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*admissionregistrationv1.ValidatingAdmissionPolicy); ok {
				return &apimeta.NoKindMatchError{GroupKind: schema.GroupKind{Group: "admissionregistration.k8s.io", Kind: "ValidatingAdmissionPolicy"}, SearchedVersions: []string{"v1"}}
			}
			return cl.Get(ctx, key, obj, opts...)
		},
	})
	st, err := tg.Ensure(context.Background(), inst)
	if err != nil || !st.Ready || !strings.Contains(st.Unprotected, "Kubernetes 1.30") {
		t.Fatalf("no admission policies: %q %v", st.Unprotected, err)
	}
}

// A deleted owner Service on an instance with a recorded uid: the release is re-applied and the
// control plane restarted in the same round.
func TestEnsureRepairsAndResyncsInOneRound(t *testing.T) {
	tg, helm, inst, _ := readyInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	if err := tg.Client.Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName + "-0"}}); err != nil {
		t.Fatal(err)
	}
	helm.onRepair = func(ns string) {
		if err := tg.Client.Create(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName, UID: "svc-uid-3"}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tg.Client.Delete(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}}); err != nil {
		t.Fatal(err)
	}
	inst.Status.Target.ServiceUID = "svc-uid-2"
	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Reason != ReasonResyncing || st.ResyncStarted != "svc-uid-3" || len(helm.repaired) != 1 || podExists(t, tg.Client, ns) {
		t.Fatalf("repair and resync: %+v %v", st, err)
	}

	helm.onRepair = nil
	if err := tg.Client.Delete(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}}); err != nil {
		t.Fatal(err)
	}
	if _, err := tg.Ensure(ctx, inst); err == nil {
		t.Fatal("a Service still missing after the repair must be an error")
	}
}

// A resync waiting past ResyncTimeout reports TargetUnreachable with the stage.
func TestStuckResyncIsUnreachable(t *testing.T) {
	tg, inst, sts, uid := resyncInstance(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	tg.Now = func() time.Time { return now }
	tg.ResyncTimeout = 90 * time.Minute
	started := metav1.NewTime(now.Add(-time.Hour))
	inst.Status.Target = v1alpha1.TargetStatus{ServiceUID: "old-uid", ResyncServiceUID: uid, ResyncStarted: &started}
	sts.Status.ReadyReplicas = 0
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ := tg.Ensure(ctx, inst); st.Reason != ReasonResyncing {
		t.Fatalf("within the bound: %+v", st)
	}
	now = now.Add(time.Hour)
	if st, _ := tg.Ensure(ctx, inst); st.Reason != "TargetUnreachable" || st.Message != "resync started 2h0m0s ago is stuck: vcluster control plane not ready" {
		t.Fatalf("stuck: %+v", st)
	}
	tg.Now = nil
	if st, _ := tg.Ensure(ctx, inst); st.Reason != "TargetUnreachable" {
		t.Fatalf("stuck with the real clock: %+v", st)
	}
}
