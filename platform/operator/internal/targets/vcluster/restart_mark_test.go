package vcluster

import (
	"context"
	"errors"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
)

// restartPod stands in for the StatefulSet, which creates vcluster-0 again after a delete; the
// API server gives the new pod a new uid.
func restartPod(t *testing.T, c client.Client, ns, uid string) {
	t.Helper()
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName + "-0", UID: types.UID(uid)}}
	if err := c.Create(context.Background(), pod); err != nil {
		t.Fatal(err)
	}
}

// markOf returns the host namespace's RestartAnnotation.
func markOf(t *testing.T, c client.Client, ns string) (string, bool) {
	t.Helper()
	var namespace corev1.Namespace
	if err := c.Get(context.Background(), client.ObjectKey{Name: ns}, &namespace); err != nil {
		t.Fatal(err)
	}
	v, ok := namespace.Annotations[RestartAnnotation]
	return v, ok
}

// podUID returns the uid of vcluster-0.
func podUID(t *testing.T, c client.Client, ns string) string {
	t.Helper()
	var pod corev1.Pod
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: ReleaseName + "-0"}, &pod); err != nil {
		t.Fatal(err)
	}
	return string(pod.UID)
}

// A resync whose start the controller failed to record (#503): Ensure deleted the pod, the
// status patch failed, and the next rounds read an instance without the resync marker. They
// report the same resync without deleting the pod again, before the StatefulSet recreates it and
// after. Once the status records the resync, the mark is cleared and the resync goes on as
// before.
func TestUnrecordedResyncRestartsThePodOnce(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	inst.Status.Target.ServiceUID = "old-uid"
	inst.Status.InstalledVersion = "6.0.20"

	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Reason != ReasonResyncing || st.ResyncStarted != uid || podExists(t, tg.Client, ns) {
		t.Fatalf("resync start: %+v %v", st, err)
	}
	if mark, _ := markOf(t, tg.Client, ns); mark != uid+"/pod-uid-1" {
		t.Fatalf("restart mark %q", mark)
	}

	// The status patch failed: the instance still has no resync marker.
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Reason != ReasonResyncing || st.ResyncStarted != uid {
		t.Fatalf("pod not back yet: %+v %v", st, err)
	}
	restartPod(t, tg.Client, ns, "pod-uid-2")
	for range 2 {
		if st, err = tg.Ensure(ctx, inst); err != nil || st.Reason != ReasonResyncing || st.ResyncStarted != uid {
			t.Fatalf("restarted pod: %+v %v", st, err)
		}
		if !podExists(t, tg.Client, ns) || podUID(t, tg.Client, ns) != "pod-uid-2" {
			t.Fatal("the restarted vcluster pod was deleted a second time")
		}
	}

	// The status records the resync, which guards it from here: the mark goes.
	inst.Status.Target.ResyncServiceUID = uid
	if st, err = tg.Ensure(ctx, inst); err != nil || !st.Ready || !st.Resynced || st.ServiceUID != uid || podUID(t, tg.Client, ns) != "pod-uid-2" {
		t.Fatalf("recorded resync: %+v %v", st, err)
	}
	if mark, ok := markOf(t, tg.Client, ns); ok {
		t.Fatalf("restart mark kept after the resync was recorded: %q", mark)
	}
}

// A deleted kubeconfig Secret restarts the pod once while the resync goes unrecorded. Once the
// restarted syncer writes the Secret the mark is cleared, so a later loss of the Secret, under
// the same owner Service, restarts the pod again.
func TestUnrecordedKubeconfigResyncRestartsOnce(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	inst.Status.Target.ServiceUID = uid
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName}}
	deleteSecret := func() {
		t.Helper()
		if err := tg.Client.Delete(ctx, secret.DeepCopy()); err != nil {
			t.Fatal(err)
		}
	}
	deleteSecret()

	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Reason != ReasonKubeconfigMissing || st.ResyncStarted != uid || podExists(t, tg.Client, ns) {
		t.Fatalf("missing Secret: %+v %v", st, err)
	}
	restartPod(t, tg.Client, ns, "pod-uid-2")
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Reason != ReasonKubeconfigMissing || st.ResyncStarted != uid ||
		!podExists(t, tg.Client, ns) {
		t.Fatalf("unrecorded resync restarted the pod again: %+v %v", st, err)
	}

	// The restarted syncer writes its Secret: the restart took effect and the mark goes.
	if err := tg.Client.Create(ctx, &corev1.Secret{ObjectMeta: secret.ObjectMeta, Data: map[string][]byte{"config": []byte(vclusterKubeconfig)}}); err != nil {
		t.Fatal(err)
	}
	if st, err = tg.Ensure(ctx, inst); err != nil || !st.Ready {
		t.Fatalf("Secret back: %+v %v", st, err)
	}
	if mark, ok := markOf(t, tg.Client, ns); ok {
		t.Fatalf("restart mark kept once the Secret was back: %q", mark)
	}

	// A later loss is a new resync.
	deleteSecret()
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Reason != ReasonKubeconfigMissing || podExists(t, tg.Client, ns) {
		t.Fatalf("second loss did not restart the pod: %+v %v", st, err)
	}
	if mark, _ := markOf(t, tg.Client, ns); mark != uid+"/pod-uid-2" {
		t.Fatalf("restart mark %q", mark)
	}
}

// A restart whose delete failed is tried again: the mark names the pod that is still running.
func TestRestartMarkRetriesAFailedDelete(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	inst.Status.Target.ServiceUID = "old-uid"
	live := interceptDeletes(tg, func(client.WithWatch, client.Object, *client.DeleteOptions) error {
		return errors.New("forbidden")
	})
	if _, err := tg.Ensure(ctx, inst); err == nil || !podExists(t, live, ns) {
		t.Fatalf("failed delete: %v", err)
	}
	tg.Client = live
	if st, err := tg.Ensure(ctx, inst); err != nil || st.ResyncStarted != uid || podExists(t, live, ns) {
		t.Fatalf("retry: %+v %v", st, err)
	}
}

// interceptDeletes routes the target's deletes to del, with their options applied, and returns
// the client underneath.
func interceptDeletes(tg *Target, del func(client.WithWatch, client.Object, *client.DeleteOptions) error) client.Client {
	live := tg.Client
	tg.Client = interceptor.NewClient(live.(client.WithWatch), interceptor.Funcs{
		Delete: func(_ context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			return del(c, obj, (&client.DeleteOptions{}).ApplyOptions(opts))
		},
	})
	return live
}

// The restart deletes only the pod the mark names (#503): the Delete carries that pod's uid as a
// precondition. A Conflict means the StatefulSet already replaced it, which is the restart: the
// resync goes on without an error, and the next round leaves the new pod alone.
func TestRestartDeleteIsPreconditionedOnTheMarkedPod(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	inst.Status.Target.ServiceUID = "old-uid"
	var preconditions []*metav1.Preconditions
	live := interceptDeletes(tg, func(c client.WithWatch, obj client.Object, opts *client.DeleteOptions) error {
		preconditions = append(preconditions, opts.Preconditions)
		// The StatefulSet replaced the pod between the read and the delete.
		if err := c.Delete(ctx, obj); err != nil {
			t.Fatal(err)
		}
		restartPod(t, c, ns, "pod-uid-2")
		return apierrors.NewConflict(corev1.Resource("pods"), obj.GetName(),
			errors.New("Precondition failed: UID in precondition: pod-uid-1, UID in object meta: pod-uid-2"))
	})

	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Reason != ReasonResyncing || st.ResyncStarted != uid {
		t.Fatalf("conflict on the restart: %+v %v", st, err)
	}
	if len(preconditions) != 1 || preconditions[0] == nil || preconditions[0].UID == nil || *preconditions[0].UID != "pod-uid-1" {
		t.Fatalf("pod delete preconditions %+v, want uid pod-uid-1", preconditions)
	}
	if mark, _ := markOf(t, live, ns); mark != uid+"/pod-uid-1" {
		t.Fatalf("restart mark %q", mark)
	}
	if st, err = tg.Ensure(ctx, inst); err != nil || st.ResyncStarted != uid || len(preconditions) != 1 || podUID(t, live, ns) != "pod-uid-2" {
		t.Fatalf("after the conflict: %+v %v, %d deletes", st, err, len(preconditions))
	}
}

// A mark for another owner Service (a replaced one) doesn't stop the restart for this one.
func TestRestartMarkForAnotherServiceRestarts(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	var namespace corev1.Namespace
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil {
		t.Fatal(err)
	}
	if err := tg.setRestartMark(ctx, &namespace, "svc-uid-1", "pod-uid-0"); err != nil {
		t.Fatal(err)
	}
	inst.Status.Target.ServiceUID = "svc-uid-1"
	if st, err := tg.Ensure(ctx, inst); err != nil || st.ResyncStarted != uid || podExists(t, tg.Client, ns) {
		t.Fatalf("replaced Service: %+v %v", st, err)
	}
	if mark, _ := markOf(t, tg.Client, ns); mark != uid+"/pod-uid-1" {
		t.Fatalf("restart mark %q", mark)
	}
}

// After a host-namespace delete (#490) the namespace is created again without the lost one's
// mark, and the new vCluster's Service has a new uid: the resync goes on without a restart.
func TestHostNamespaceResyncStartsWithoutAMark(t *testing.T) {
	tg, helm, inst := installedOnTarget(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	var namespace corev1.Namespace
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil {
		t.Fatal(err)
	}
	if err := tg.setRestartMark(ctx, &namespace, inst.Status.Target.ServiceUID, "pod-uid-1"); err != nil {
		t.Fatal(err)
	}

	terminate(t, tg.Client, ns)
	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.ResyncStarted != ResyncHostNamespace {
		t.Fatalf("terminating: %+v %v", st, err)
	}
	inst.Status.Target.ResyncServiceUID = st.ResyncStarted
	finishTermination(t, tg, helm, ns)
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	if mark, ok := markOf(t, tg.Client, ns); ok {
		t.Fatalf("namespace created again with a restart mark %q", mark)
	}
	sts := createReleaseObjects(t, tg.Client, ns)
	sts.Status.ReadyReplicas = 1
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	var svc corev1.Service
	if err := tg.Client.Get(ctx, client.ObjectKey{Namespace: ns, Name: ReleaseName}, &svc); err != nil {
		t.Fatal(err)
	}
	svc.UID = "svc-uid-3"
	if err := tg.Client.Update(ctx, &svc); err != nil {
		t.Fatal(err)
	}
	restartPod(t, tg.Client, ns, "pod-uid-3")
	if st, err = tg.Ensure(ctx, inst); err != nil || st.ResyncStarted != "svc-uid-3" || !podExists(t, tg.Client, ns) {
		t.Fatalf("new vcluster: %+v %v", st, err)
	}
	// The status write of that round is lost (the instance keeps the host-namespace marker):
	// the next round still doesn't restart the new control plane.
	if st, err = tg.Ensure(ctx, inst); err != nil || st.ResyncStarted != "svc-uid-3" || podUID(t, tg.Client, ns) != "pod-uid-3" {
		t.Fatalf("unrecorded host resync: %+v %v", st, err)
	}
	if _, ok := markOf(t, tg.Client, ns); ok {
		t.Fatal("host resync left a restart mark")
	}
}
