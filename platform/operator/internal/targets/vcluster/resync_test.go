package vcluster

import (
	"context"
	"errors"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// resyncInstance is a ready instance with its vcluster-0 pod and the uid of its service/vcluster.
func resyncInstance(t *testing.T) (*Target, *v1alpha1.PlatformInstance, *appsv1.StatefulSet, string) {
	t.Helper()
	tg, _, inst, sts := readyInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	if err := tg.Client.Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName + "-0"}}); err != nil {
		t.Fatal(err)
	}
	// The fake client sets no uids; the API server does.
	var svc corev1.Service
	if err := tg.Client.Get(ctx, client.ObjectKey{Namespace: ns, Name: ReleaseName}, &svc); err != nil {
		t.Fatal(err)
	}
	svc.UID = "svc-uid-2"
	if err := tg.Client.Update(ctx, &svc); err != nil {
		t.Fatal(err)
	}
	st, err := tg.Ensure(ctx, inst)
	if err != nil || !st.Ready || st.ServiceUID == "" || st.Resynced {
		t.Fatalf("ready Ensure: %+v %v", st, err)
	}
	return tg, inst, sts, st.ServiceUID
}

func podExists(t *testing.T, c client.Client, ns string) bool {
	t.Helper()
	err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: ReleaseName + "-0"}, &corev1.Pod{})
	if err != nil && !apierrors.IsNotFound(err) {
		t.Fatal(err)
	}
	return err == nil
}

// An unchanged service/vcluster leaves the instance alone (gate 4.7).
func TestEnsureDoesNothingWhileTheOwnerServiceIsUnchanged(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	inst.Status.Target.ServiceUID = uid
	inst.Status.InstalledVersion = "6.0.20"
	st, err := tg.Ensure(context.Background(), inst)
	if err != nil || !st.Ready || st.Resynced || st.ResyncStarted != "" || st.ServiceUID != uid || !podExists(t, tg.Client, HostNamespace(inst)) {
		t.Fatalf("unchanged: %+v %v", st, err)
	}
}

// A replaced service/vcluster (#466) restarts the vCluster pod and reports Resyncing until the
// control plane, its kubeconfig Secret and its API are back; then it is Ready and Resynced.
func TestEnsureResyncsWhenTheOwnerServiceWasReplaced(t *testing.T) {
	tg, inst, sts, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	inst.Status.Target.ServiceUID = "old-uid"
	inst.Status.InstalledVersion = "6.0.20"

	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Ready || st.Reason != ReasonResyncing || st.ResyncStarted != uid || podExists(t, tg.Client, ns) {
		t.Fatalf("replaced Service: %+v %v", st, err)
	}
	inst.Status.Target.ResyncServiceUID = st.ResyncStarted

	// The pod restarts: control plane down, then the Secret pending, then the API.
	sts.Status.ReadyReplicas = 0
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != ReasonResyncing || st.Ready {
		t.Fatalf("control plane restarting: %+v", st)
	}
	sts.Status.ReadyReplicas = 1
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName}}
	if err := tg.Client.Delete(ctx, secret); err != nil {
		t.Fatal(err)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != ReasonResyncing || st.Ready || st.ResyncStarted != "" {
		t.Fatalf("Secret not back yet: %+v", st)
	}
	secret.Data = map[string][]byte{"config": []byte(vclusterKubeconfig)}
	secret.ResourceVersion = ""
	if err := tg.Client.Create(ctx, secret); err != nil {
		t.Fatal(err)
	}
	tg.Dial = func(context.Context, string) error { return errors.New("refused") }
	if st, _ = tg.Ensure(ctx, inst); st.Reason != ReasonResyncing || st.Ready {
		t.Fatalf("API not answering yet: %+v", st)
	}
	tg.Dial = answers
	if st, err = tg.Ensure(ctx, inst); err != nil || !st.Ready || !st.Resynced || st.ServiceUID != uid {
		t.Fatalf("resynced: %+v %v", st, err)
	}
}

// A deleted kubeconfig Secret on an instance that had one is KubeconfigMissing, not pending,
// and restarts the pod, which writes it again.
func TestEnsureReportsAMissingKubeconfig(t *testing.T) {
	tg, inst, _, uid := resyncInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	inst.Status.Target.ServiceUID = uid
	if err := tg.Client.Delete(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName}}); err != nil {
		t.Fatal(err)
	}
	st, err := tg.Ensure(ctx, inst)
	want := "vcluster kubeconfig Secret " + ns + "/vc-vcluster is missing; resync pending"
	if err != nil || st.Ready || st.Reason != ReasonKubeconfigMissing || st.Message != want || st.ResyncStarted != uid || podExists(t, tg.Client, ns) {
		t.Fatalf("missing Secret: %+v %v", st, err)
	}
	// The pod is already gone (restarted): a second resync doesn't fail on it.
	inst.Status.Target = v1alpha1.TargetStatus{}
	inst.Status.InstalledVersion = "6.0.20"
	if st, err = tg.Ensure(ctx, inst); err != nil || st.Reason != ReasonKubeconfigMissing {
		t.Fatalf("installed before the uid was recorded: %+v %v", st, err)
	}
}

func TestEnsureReportsAFailedRestart(t *testing.T) {
	tg, inst, _, _ := resyncInstance(t)
	inst.Status.Target.ServiceUID = "old-uid"
	tg.Client = interceptor.NewClient(tg.Client.(client.WithWatch), interceptor.Funcs{
		Delete: func(context.Context, client.WithWatch, client.Object, ...client.DeleteOption) error {
			return errors.New("forbidden")
		},
	})
	if _, err := tg.Ensure(context.Background(), inst); err == nil || err.Error() != "restart "+HostNamespace(inst)+"/vcluster-0 to resync: forbidden" {
		t.Fatalf("restart error: %v", err)
	}
}
