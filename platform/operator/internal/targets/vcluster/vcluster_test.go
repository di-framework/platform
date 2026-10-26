package vcluster

import (
	"context"
	"errors"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

type fakeHelm struct {
	installed   map[string]map[string]any // namespace -> values
	status      map[string]string         // namespace -> release status; unset is deployed
	uninstalled []string
}

func (f *fakeHelm) Get(_ context.Context, ns, _ string) (*Release, error) {
	if _, ok := f.installed[ns]; !ok {
		return nil, nil
	}
	if st, ok := f.status[ns]; ok {
		return &Release{Status: st, Description: "boom"}, nil
	}
	return &Release{Status: "deployed"}, nil
}
func (f *fakeHelm) Install(_ context.Context, ns, name string, chart []byte, values map[string]any) error {
	if name != ReleaseName || len(chart) == 0 {
		panic("unexpected install")
	}
	f.installed[ns] = values
	return nil
}
func (f *fakeHelm) Uninstall(_ context.Context, ns, _ string) error {
	f.uninstalled = append(f.uninstalled, ns)
	delete(f.installed, ns)
	return nil
}

func ownedNamespace(inst *v1alpha1.PlatformInstance) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: HostNamespace(inst), Annotations: map[string]string{OwnerAnnotation: inst.Namespace + "/" + inst.Name}}}
}

func instance(ns, name string) *v1alpha1.PlatformInstance {
	return &v1alpha1.PlatformInstance{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}
}

func newClient(t *testing.T, objs ...client.Object) client.Client {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	return fake.NewClientBuilder().WithScheme(s).WithObjects(objs...).Build()
}

const vclusterKubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: my-vcluster
  cluster:
    server: https://localhost:8443
    certificate-authority-data: Y2E=
contexts:
- name: my-vcluster
  context: {cluster: my-vcluster, user: my-vcluster}
current-context: my-vcluster
users:
- name: my-vcluster
  user: {client-certificate-data: Y2VydA==, client-key-data: a2V5}
`

func TestChartDigest(t *testing.T) {
	b, err := Chart()
	if err != nil || len(b) == 0 {
		t.Fatalf("Chart() = %d bytes, %v", len(b), err)
	}
}

func TestEnsure(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{}}
	c := newClient(t)
	tg := &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS, Values: func(_ context.Context, i *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{"marker": i.Name}, nil
	}}
	ctx := context.Background()

	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Ready || st.Reason != "Creating" || helm.installed[ns]["marker"] != "one" {
		t.Fatalf("first Ensure: %+v %v (installed %v)", st, err, helm.installed)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != "ControlPlanePending" {
		t.Fatalf("no StatefulSet yet: %+v", st)
	}

	sts := &appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}}
	if err := c.Create(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != "ControlPlanePending" {
		t.Fatalf("StatefulSet not ready: %+v", st)
	}
	sts.Status.ReadyReplicas = 1
	if err := c.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != "KubeconfigPending" {
		t.Fatalf("no Secret yet: %+v", st)
	}

	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName}, Data: map[string][]byte{"config": []byte(vclusterKubeconfig)}}
	if err := c.Create(ctx, secret); err != nil {
		t.Fatal(err)
	}
	st, err = tg.Ensure(ctx, inst)
	if err != nil || !st.Ready {
		t.Fatalf("ready Ensure: %+v %v", st, err)
	}
	want := "https://vcluster." + ns + ".svc:443"
	cfg, err := clientcmd.Load(st.Kubeconfig)
	if err != nil {
		t.Fatal(err)
	}
	if st.Server != want || cfg.Clusters["my-vcluster"].Server != want {
		t.Fatalf("server %q / %q, want %q", st.Server, cfg.Clusters["my-vcluster"].Server, want)
	}
	if len(helm.installed) != 1 {
		t.Fatalf("installed more than once: %v", helm.installed)
	}
	var namespace corev1.Namespace
	if err := c.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil || namespace.Annotations[OwnerAnnotation] != "team-a/one" {
		t.Fatalf("host namespace not annotated with its owner: %v %v", namespace.Annotations, err)
	}
}

func TestEnsureReinstallsAFailedRelease(t *testing.T) {
	for _, status := range []string{"failed", "pending-install"} {
		inst := instance("team-a", "one")
		ns := HostNamespace(inst)
		helm := &fakeHelm{installed: map[string]map[string]any{ns: {}}, status: map[string]string{ns: status}}
		tg := &Target{Client: newClient(t, ownedNamespace(inst)), Helm: helm, OperatorNamespace: operatorNS, Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
			return map[string]any{}, nil
		}}
		// An error, so a release that fails every time backs off instead of cycling every poll.
		st, err := tg.Ensure(context.Background(), inst)
		if !errors.Is(err, ErrReinstalling) || !strings.Contains(err.Error(), status) || st.Ready || len(helm.uninstalled) != 1 {
			t.Fatalf("%s release: %+v %v (uninstalled %v)", status, st, err, helm.uninstalled)
		}
		delete(helm.status, ns)
		if st, err = tg.Ensure(context.Background(), inst); err != nil || st.Reason != "Creating" {
			t.Fatalf("%s release, second Ensure: %+v %v", status, st, err)
		}
	}
}

// team-a/one and team/a-one join to the same string; they must get different host namespaces,
// and neither may touch a namespace the other owns.
func TestInstancesNeverShareAHostNamespace(t *testing.T) {
	a, b := instance("team-a", "one"), instance("team", "a-one")
	if HostNamespace(a) == HostNamespace(b) {
		t.Fatalf("both instances map to %s", HostNamespace(a))
	}

	// A namespace claimed by another instance (as a name collision would produce) is refused.
	theirs := ownedNamespace(b)
	theirs.Name = HostNamespace(a)
	helm := &fakeHelm{installed: map[string]map[string]any{theirs.Name: {}}}
	tg := &Target{Client: newClient(t, theirs), Helm: helm, OperatorNamespace: operatorNS}
	if _, err := tg.Ensure(context.Background(), a); err == nil || !strings.Contains(err.Error(), "team/a-one") {
		t.Fatalf("Ensure into another instance's namespace: %v", err)
	}
	// Delete leaves it alone and is done, so the finalizer is released.
	if done, err := tg.Delete(context.Background(), a); err != nil || !done || len(helm.uninstalled) != 0 {
		t.Fatalf("Delete of another instance's namespace: done=%v %v (uninstalled %v)", done, err, helm.uninstalled)
	}
	var ns corev1.Namespace
	if err := tg.Client.Get(context.Background(), client.ObjectKey{Name: theirs.Name}, &ns); err != nil {
		t.Fatalf("the other namespace was deleted: %v", err)
	}
}

// A namespace that appears between the read and the create is checked like any other.
func TestClaimChecksANamespaceCreatedInTheRace(t *testing.T) {
	a := instance("team-a", "one")
	c := newClient(t)
	racy := interceptor.NewClient(c.(client.WithWatch), interceptor.Funcs{
		Create: func(ctx context.Context, cl client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			if _, ok := obj.(*corev1.Namespace); ok {
				other := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: obj.GetName(), Annotations: map[string]string{OwnerAnnotation: "someone/else"}}}
				if err := cl.Create(ctx, other); err != nil {
					return err
				}
			}
			return cl.Create(ctx, obj, opts...)
		},
	})
	helm := &fakeHelm{installed: map[string]map[string]any{}}
	tg := &Target{Client: racy, Helm: helm, OperatorNamespace: operatorNS, Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{}, nil
	}}
	if _, err := tg.Ensure(context.Background(), a); err == nil || !strings.Contains(err.Error(), "someone/else") || len(helm.installed) != 0 {
		t.Fatalf("Ensure after the race: %v (installed %v)", err, helm.installed)
	}
}

func TestDelete(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{ns: {}}}
	c := newClient(t, ownedNamespace(inst))
	tg := &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS}

	done, err := tg.Delete(context.Background(), inst)
	if err != nil || done {
		t.Fatalf("first Delete: done=%v %v", done, err)
	}
	if len(helm.uninstalled) != 1 {
		t.Fatalf("uninstalled %v", helm.uninstalled)
	}
	// The fake client deletes the namespace at once; a real one finishes asynchronously.
	if done, err = tg.Delete(context.Background(), inst); err != nil || !done {
		t.Fatalf("second Delete: done=%v %v", done, err)
	}
}

func TestHostNamespace(t *testing.T) {
	if got := HostNamespace(instance("team-a", "one")); !strings.HasPrefix(got, "pi-team-a-one-") || len(got) != len("pi-team-a-one-")+10 {
		t.Fatalf("short name %q", got)
	}
	if got := HostNamespace(instance("team-a", "web.v2")); !strings.HasPrefix(got, "pi-team-a-web-v2-") {
		t.Fatalf("dotted name %q", got)
	}
	long := HostNamespace(instance(strings.Repeat("n", 40), strings.Repeat("m", 40)))
	other := HostNamespace(instance(strings.Repeat("n", 40), strings.Repeat("m", 39)+"x"))
	if len(long) > 63 || long == other || !strings.HasPrefix(long, "pi-") {
		t.Fatalf("long names %q / %q", long, other)
	}
	// Cutting at a dash must not leave a double dash before the hash.
	dash := HostNamespace(instance(strings.Repeat("n", 48), "m"))
	if strings.Contains(dash, "--") || len(dash) > 63 {
		t.Fatalf("cut at a dash: %q", dash)
	}
}
