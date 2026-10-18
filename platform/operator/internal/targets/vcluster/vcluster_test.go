package vcluster

import (
	"context"
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

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

type fakeHelm struct {
	installed   map[string]map[string]any // namespace -> values
	uninstalled []string
}

func (f *fakeHelm) Exists(_ context.Context, ns, _ string) (bool, error) {
	_, ok := f.installed[ns]
	return ok, nil
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
	tg := &Target{Client: c, Helm: helm, Values: func(_ context.Context, i *v1alpha1.PlatformInstance) (map[string]any, error) {
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
}

func TestDelete(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{ns: {}}}
	c := newClient(t, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}})
	tg := &Target{Client: c, Helm: helm}

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
	if got := HostNamespace(instance("team-a", "one")); got != "pi-team-a-one" {
		t.Fatalf("short name %q", got)
	}
	long := HostNamespace(instance(strings.Repeat("n", 40), strings.Repeat("m", 40)))
	other := HostNamespace(instance(strings.Repeat("n", 40), strings.Repeat("m", 39)+"x"))
	if len(long) > 63 || long == other || !strings.HasPrefix(long, "pi-") {
		t.Fatalf("long names %q / %q", long, other)
	}
}
