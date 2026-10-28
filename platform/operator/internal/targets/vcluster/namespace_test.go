package vcluster

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// terminate marks the host namespace deleted while a finalizer holds it, as the namespace
// controller does while it removes the namespace's contents.
func terminate(t *testing.T, c client.Client, ns string) {
	t.Helper()
	ctx := context.Background()
	var namespace corev1.Namespace
	if err := c.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil {
		t.Fatal(err)
	}
	namespace.Finalizers = append(namespace.Finalizers, "test.di-framework.dev/hold")
	if err := c.Update(ctx, &namespace); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, &namespace); err != nil {
		t.Fatal(err)
	}
}

// finishTermination lets the terminating namespace go with everything in it: the fake client
// doesn't remove a namespace's contents, the namespace controller does.
func finishTermination(t *testing.T, tg *Target, helm *fakeHelm, ns string) {
	t.Helper()
	ctx := context.Background()
	var namespace corev1.Namespace
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil {
		t.Fatal(err)
	}
	namespace.Finalizers = nil
	if err := tg.Client.Update(ctx, &namespace); err != nil {
		t.Fatal(err)
	}
	objs := append(releaseObjects(ns),
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName + "-0"}})
	for _, obj := range objs {
		if err := tg.Client.Delete(ctx, obj); client.IgnoreNotFound(err) != nil {
			t.Fatal(err)
		}
	}
	delete(helm.installed, ns)
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &namespace); !apierrors.IsNotFound(err) {
		t.Fatalf("namespace still there: %v", err)
	}
}

// installedOnTarget is a ready instance with its owner Service uid recorded and a platform
// installed.
func installedOnTarget(t *testing.T) (*Target, *fakeHelm, *v1alpha1.PlatformInstance) {
	t.Helper()
	tg, inst, _, uid := resyncInstance(t)
	inst.Status.Target.ServiceUID = uid
	inst.Status.InstalledVersion = "6.0.22"
	tg.Values = func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{}, nil
	}
	return tg, tg.Helm.(*fakeHelm), inst
}

// A host namespace deleted under an installed instance (#490) is a resync, like an owner-Service
// delete: not Ready at once, with the target reported lost; nothing is created while the
// namespace terminates; once it is gone the namespace and a new vCluster are created, and the
// resync goes on under the new Service's uid without restarting the new control plane, until the
// new vCluster answers Ready and Resynced.
func TestEnsureResyncsWhenTheHostNamespaceWasDeleted(t *testing.T) {
	tg, helm, inst := installedOnTarget(t)
	ns := HostNamespace(inst)
	ctx := context.Background()

	terminate(t, tg.Client, ns)
	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Ready || !st.TargetLost || st.Reason != ReasonHostNamespaceDeleted || st.ResyncStarted != ResyncHostNamespace {
		t.Fatalf("terminating namespace: %+v %v", st, err)
	}
	if !podExists(t, tg.Client, ns) || len(helm.uninstalled) != 0 || len(helm.repaired) != 0 {
		t.Fatalf("touched the terminating namespace: uninstalled %v repaired %v", helm.uninstalled, helm.repaired)
	}

	// The controller records the resync; while the namespace terminates it waits.
	started := metav1.NewTime(time.Date(2026, 10, 27, 18, 0, 0, 0, time.UTC))
	tg.Now = func() time.Time { return started.Add(time.Second) }
	inst.Status.Target.ResyncServiceUID, inst.Status.Target.ResyncStarted = st.ResyncStarted, &started
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Ready || st.TargetLost || st.Reason != ReasonResyncing || st.ResyncStarted != "" {
		t.Fatalf("still terminating: %+v %v", st, err)
	}
	// A namespace stuck terminating past the resync timeout is reported.
	tg.ResyncTimeout = time.Minute
	tg.Now = func() time.Time { return started.Add(2 * time.Minute) }
	if st, _ = tg.Ensure(ctx, inst); st.Reason != "TargetUnreachable" || st.Ready {
		t.Fatalf("stuck terminating: %+v", st)
	}
	tg.Now = func() time.Time { return started.Add(time.Second) }

	// Gone: the namespace and a new vCluster are created.
	finishTermination(t, tg, helm, ns)
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Ready || st.Reason != ReasonResyncing || st.ResyncStarted != "" {
		t.Fatalf("namespace gone: %+v %v", st, err)
	}
	var namespace corev1.Namespace
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil ||
		namespace.Annotations[OwnerAnnotation] != "team-a/one" || namespace.Labels[HostNamespaceLabel] != "true" {
		t.Fatalf("namespace not created again: %+v %v", namespace.ObjectMeta, err)
	}
	if _, ok := helm.installed[ns]; !ok {
		t.Fatal("vcluster not installed again")
	}

	// The new release's objects, with a new owner Service.
	sts := createReleaseObjects(t, tg.Client, ns)
	var svc corev1.Service
	if err := tg.Client.Get(ctx, client.ObjectKey{Namespace: ns, Name: ReleaseName}, &svc); err != nil {
		t.Fatal(err)
	}
	svc.UID = "svc-uid-3"
	if err := tg.Client.Update(ctx, &svc); err != nil {
		t.Fatal(err)
	}
	if err := tg.Client.Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName + "-0"}}); err != nil {
		t.Fatal(err)
	}
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Ready || st.Reason != ReasonResyncing || st.ResyncStarted != "svc-uid-3" || !podExists(t, tg.Client, ns) {
		t.Fatalf("new vcluster: %+v %v", st, err)
	}
	inst.Status.Target.ResyncServiceUID = st.ResyncStarted

	// Control plane, then kubeconfig Secret: waiting, never a restart of the new control plane.
	if st, _ = tg.Ensure(ctx, inst); st.Reason != ReasonResyncing || st.Ready {
		t.Fatalf("control plane starting: %+v", st)
	}
	sts.Status.ReadyReplicas = 1
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != ReasonResyncing || st.Ready || st.ResyncStarted != "" || !podExists(t, tg.Client, ns) {
		t.Fatalf("Secret not written yet: %+v", st)
	}
	if err := tg.Client.Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName},
		Data: map[string][]byte{"config": []byte(vclusterKubeconfig)}}); err != nil {
		t.Fatal(err)
	}
	if st, err = tg.Ensure(ctx, inst); err != nil || !st.Ready || !st.Resynced || st.ServiceUID != "svc-uid-3" || st.TargetLost {
		t.Fatalf("resynced: %+v %v", st, err)
	}
	if !podExists(t, tg.Client, ns) {
		t.Fatal("restarted the new control plane")
	}
}

// A host namespace already gone when the operator looks (it was down while the namespace went)
// starts the same resync, and isn't created before the resync is recorded.
func TestEnsureResyncsWhenTheHostNamespaceIsGone(t *testing.T) {
	tg, _, inst := installedOnTarget(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	if err := tg.Client.Delete(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
		t.Fatal(err)
	}
	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Ready || !st.TargetLost || st.Reason != ReasonHostNamespaceDeleted || st.ResyncStarted != ResyncHostNamespace {
		t.Fatalf("namespace gone: %+v %v", st, err)
	}
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &corev1.Namespace{}); !apierrors.IsNotFound(err) {
		t.Fatalf("namespace created before the resync was recorded: %v", err)
	}
}

// The host namespace of an instance that never had a vCluster terminating: wait; nothing is lost
// and nothing is created in it.
func TestEnsureWaitsForATerminatingNamespaceOfANewInstance(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{}}
	c := newClient(t, ownedNamespace(inst))
	tg := &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Dial: answers}
	terminate(t, c, ns)
	st, err := tg.Ensure(context.Background(), inst)
	if err != nil || st.Ready || st.TargetLost || st.ResyncStarted != "" || st.Reason != ReasonHostNamespaceTerminating || len(helm.installed) != 0 {
		t.Fatalf("terminating namespace of a new instance: %+v %v (installed %v)", st, err, helm.installed)
	}
}

// A terminating namespace that isn't the instance's is refused as before, never resynced.
func TestEnsureRefusesATerminatingNamespaceItDoesNotOwn(t *testing.T) {
	tg, _, inst := installedOnTarget(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	var namespace corev1.Namespace
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil {
		t.Fatal(err)
	}
	namespace.Annotations[OwnerAnnotation] = "team-b/two"
	if err := tg.Client.Update(ctx, &namespace); err != nil {
		t.Fatal(err)
	}
	terminate(t, tg.Client, ns)
	if st, err := tg.Ensure(ctx, inst); err == nil || st.TargetLost || st.ResyncStarted != "" {
		t.Fatalf("someone else's terminating namespace: %+v %v", st, err)
	}
}
