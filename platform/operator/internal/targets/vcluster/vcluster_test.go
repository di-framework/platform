package vcluster

import (
	"context"
	"errors"
	"net"
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
	"github.com/di-framework/platform/operator/internal/targets"
)

type fakeHelm struct {
	installed   map[string]map[string]any // namespace -> values
	status      map[string]string         // namespace -> release status; unset is deployed
	uninstalled []string
	revision    map[string]int // namespace -> latest revision; unset is 1
	repaired    []string
	repairErr   error
	onRepair    func(ns string)
	rolledBack  []string
	rollbackErr error
}

func (f *fakeHelm) Get(_ context.Context, ns, _ string) (*Release, error) {
	if _, ok := f.installed[ns]; !ok {
		return nil, nil
	}
	rev := 1
	if r, ok := f.revision[ns]; ok {
		rev = r
	}
	if st, ok := f.status[ns]; ok {
		return &Release{Status: st, Description: "boom", Revision: rev}, nil
	}
	return &Release{Status: "deployed", Revision: rev}, nil
}
func (f *fakeHelm) Install(_ context.Context, ns, name string, chart []byte, values map[string]any) error {
	if name != ReleaseName || len(chart) == 0 {
		panic("unexpected install")
	}
	f.installed[ns] = values
	return nil
}
func (f *fakeHelm) Repair(_ context.Context, ns, name string) error {
	if name != ReleaseName {
		panic("unexpected repair")
	}
	f.repaired = append(f.repaired, ns)
	if f.repairErr == nil && f.onRepair != nil {
		f.onRepair(ns)
	}
	return f.repairErr
}
func (f *fakeHelm) Rollback(_ context.Context, ns, name string) (int, error) {
	if name != ReleaseName {
		panic("unexpected rollback")
	}
	f.rolledBack = append(f.rolledBack, ns)
	return f.revision[ns] - 1, f.rollbackErr
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

// createReleaseObjects stands in for Helm, which creates the release's objects before Install
// returns.
func createReleaseObjects(t *testing.T, c client.Client, ns string) *appsv1.StatefulSet {
	t.Helper()
	for _, obj := range releaseObjects(ns) {
		if err := c.Create(context.Background(), obj); err != nil {
			t.Fatal(err)
		}
	}
	sts := &appsv1.StatefulSet{}
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: ReleaseName}, sts); err != nil {
		t.Fatal(err)
	}
	return sts
}

func answers(context.Context, string) error { return nil }

func TestEnsure(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{}}
	c := newClient(t)
	var dialed string
	tg := &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Values: func(_ context.Context, i *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{"marker": i.Name}, nil
	}, Dial: func(_ context.Context, address string) error { dialed = address; return nil }}
	ctx := context.Background()

	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Ready || st.Reason != "Creating" || helm.installed[ns]["marker"] != "one" {
		t.Fatalf("first Ensure: %+v %v (installed %v)", st, err, helm.installed)
	}
	sts := createReleaseObjects(t, c, ns)
	if st, _ = tg.Ensure(ctx, inst); st.Reason != "ControlPlanePending" {
		t.Fatalf("StatefulSet not ready: %+v", st)
	}
	sts.Status.ReadyReplicas = 1
	if err := c.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ = tg.Ensure(ctx, inst); st.Reason != "KubeconfigPending" || st.Message != "vcluster kubeconfig Secret not created yet" {
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
	if st.Server != want || cfg.Clusters["my-vcluster"].Server != want || dialed != "vcluster."+ns+".svc:443" {
		t.Fatalf("server %q / %q (dialed %q), want %q", st.Server, cfg.Clusters["my-vcluster"].Server, dialed, want)
	}
	if len(helm.installed) != 1 || len(helm.repaired) != 0 {
		t.Fatalf("installed more than once or upgraded: %v %v", helm.installed, helm.repaired)
	}
	var namespace corev1.Namespace
	if err := c.Get(ctx, client.ObjectKey{Name: ns}, &namespace); err != nil || namespace.Annotations[OwnerAnnotation] != "team-a/one" {
		t.Fatalf("host namespace not annotated with its owner: %v %v", namespace.Annotations, err)
	}
}

// readyInstance is an installed instance whose release objects and kubeconfig Secret exist.
func readyInstance(t *testing.T) (*Target, *fakeHelm, *v1alpha1.PlatformInstance, *appsv1.StatefulSet) {
	t.Helper()
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{ns: {}}}
	c := newClient(t, ownedNamespace(inst), &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: "vc-" + ReleaseName}, Data: map[string][]byte{"config": []byte(vclusterKubeconfig)}})
	sts := createReleaseObjects(t, c, ns)
	sts.Status.ReadyReplicas = 1
	if err := c.Status().Update(context.Background(), sts); err != nil {
		t.Fatal(err)
	}
	return &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Dial: answers}, helm, inst, sts
}

// A hand-deleted release object (Layer 4 deleted service/vcluster) is recreated by re-applying
// the release; an intact release is not touched (#453).
func TestEnsureReappliesTheReleaseWhenAnObjectIsMissing(t *testing.T) {
	tg, helm, inst, sts := readyInstance(t)
	ns := HostNamespace(inst)
	ctx := context.Background()
	if st, err := tg.Ensure(ctx, inst); err != nil || !st.Ready || len(helm.repaired) != 0 {
		t.Fatalf("intact release: %+v %v (upgraded %v)", st, err, helm.repaired)
	}
	var after appsv1.StatefulSet
	if err := tg.Client.Get(ctx, client.ObjectKeyFromObject(sts), &after); err != nil || after.ResourceVersion != sts.ResourceVersion {
		t.Fatalf("StatefulSet touched: %s -> %s %v", sts.ResourceVersion, after.ResourceVersion, err)
	}

	for _, obj := range []client.Object{
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}},
		&appsv1.StatefulSet{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: ReleaseName}},
	} {
		if err := tg.Client.Delete(ctx, obj); err != nil {
			t.Fatal(err)
		}
	}
	st, err := tg.Ensure(ctx, inst)
	if err != nil || st.Ready || st.Reason != "Repairing" || len(helm.repaired) != 1 || helm.repaired[0] != ns ||
		!strings.Contains(st.Message, "statefulset/vcluster, service/vcluster") {
		t.Fatalf("missing objects: %+v %v (upgraded %v)", st, err, helm.repaired)
	}

	helm.repairErr = errors.New("boom")
	if _, err := tg.Ensure(ctx, inst); err == nil || !strings.Contains(err.Error(), "recreate statefulset/vcluster, service/vcluster: boom") {
		t.Fatalf("failed upgrade: %v", err)
	}
}

func TestEnsureReportsAReadErrorOnAReleaseObject(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	tg.Client = interceptor.NewClient(tg.Client.(client.WithWatch), interceptor.Funcs{
		Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*corev1.Service); ok {
				return errors.New("read failed")
			}
			return cl.Get(ctx, key, obj, opts...)
		},
	})
	if _, err := tg.Ensure(context.Background(), inst); err == nil || err.Error() != "read failed" {
		t.Fatalf("read error: %v", err)
	}
}

// With the Secret in place but the API not answering, the reason says so and names the endpoint
// instead of blaming the Secret (#453), but only after UnreachableAfter consecutive failed checks;
// a check that answers again resets the count.
func TestEnsureReportsAnUnreachableAPI(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	down := true
	tg.Dial = func(context.Context, string) error {
		if down {
			return errors.New("connection refused")
		}
		return nil
	}
	ctx := context.Background()
	ensure := func() targets.State {
		t.Helper()
		st, err := tg.Ensure(ctx, inst)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	for i := 1; i < UnreachableAfter; i++ {
		if st := ensure(); !st.Ready {
			t.Fatalf("failed check %d already reports %+v", i, st)
		}
	}
	st := ensure()
	want := "vcluster API https://vcluster." + HostNamespace(inst) + ".svc:443 (service " + HostNamespace(inst) + "/vcluster) is unreachable (3 consecutive checks): connection refused"
	if st.Ready || st.Reason != "TargetUnreachable" || st.Message != want {
		t.Fatalf("unreachable API: %+v", st)
	}
	down = false
	if st := ensure(); !st.Ready {
		t.Fatalf("answering again: %+v", st)
	}
	down = true
	if st := ensure(); !st.Ready {
		t.Fatalf("one failure after a success: %+v", st)
	}
}

// A repair that failed or was interrupted (revision > 1) is rolled back, never uninstalled; an
// install that failed or was interrupted is still removed and installed again.
func TestEnsureRollsBackAFailedRepair(t *testing.T) {
	for _, status := range []string{"failed", "pending-upgrade"} {
		tg, helm, inst, _ := readyInstance(t)
		ns := HostNamespace(inst)
		helm.status = map[string]string{ns: status}
		helm.revision = map[string]int{ns: 2}
		st, err := tg.Ensure(context.Background(), inst)
		want := "vcluster release revision 2 was " + status + " (boom); rolled back to revision 1"
		// An error as well, so a repair that fails every time backs off (review S8).
		if !errors.Is(err, ErrRolledBack) || !strings.Contains(err.Error(), want) || st.Ready || st.Reason != "RolledBack" || st.Message != want || len(helm.uninstalled) != 0 || len(helm.rolledBack) != 1 {
			t.Fatalf("%s repair: %+v %v (uninstalled %v, rolled back %v)", status, st, err, helm.uninstalled, helm.rolledBack)
		}
		helm.rollbackErr = errors.New("no deployed revision")
		if _, err := tg.Ensure(context.Background(), inst); err == nil || !strings.Contains(err.Error(), "roll back "+status+" vcluster release revision 2: no deployed revision") || len(helm.uninstalled) != 0 {
			t.Fatalf("%s repair, failed rollback: %v (uninstalled %v)", status, err, helm.uninstalled)
		}
	}

	tg, helm, inst, _ := readyInstance(t)
	ns := HostNamespace(inst)
	helm.status = map[string]string{ns: "pending-install"}
	helm.revision = map[string]int{ns: 2}
	if _, err := tg.Ensure(context.Background(), inst); !errors.Is(err, ErrReinstalling) || len(helm.uninstalled) != 1 || len(helm.rolledBack) != 0 {
		t.Fatalf("pending-install: %v (uninstalled %v, rolled back %v)", err, helm.uninstalled, helm.rolledBack)
	}
}

// The Layer 4 4.10 case: only service/vcluster (or the headless Service) is deleted. Repair
// re-applies the release once, names only that object, the StatefulSet is untouched, and the
// next round is ready without another repair.
func TestEnsureRecreatesADeletedService(t *testing.T) {
	for _, name := range []string{ReleaseName, ReleaseName + "-headless"} {
		tg, helm, inst, sts := readyInstance(t)
		ns := HostNamespace(inst)
		ctx := context.Background()
		helm.onRepair = func(ns string) {
			if err := tg.Client.Create(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}); err != nil {
				t.Fatal(err)
			}
		}
		if err := tg.Client.Delete(ctx, &corev1.Service{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}); err != nil {
			t.Fatal(err)
		}
		st, err := tg.Ensure(ctx, inst)
		want := "re-applied the vcluster release in namespace " + ns + " to recreate service/" + name
		if err != nil || st.Reason != "Repairing" || st.Message != want || len(helm.repaired) != 1 {
			t.Fatalf("deleted %s: %+v %v (repaired %v)", name, st, err, helm.repaired)
		}
		if st, err = tg.Ensure(ctx, inst); err != nil || !st.Ready || len(helm.repaired) != 1 {
			t.Fatalf("after repairing %s: %+v %v (repaired %v)", name, st, err, helm.repaired)
		}
		var after appsv1.StatefulSet
		if err := tg.Client.Get(ctx, client.ObjectKeyFromObject(sts), &after); err != nil || after.ResourceVersion != sts.ResourceVersion {
			t.Fatalf("StatefulSet touched repairing %s: %s -> %s %v", name, sts.ResourceVersion, after.ResourceVersion, err)
		}
	}
}

// Failed checks count only when consecutive: a round that stops before the check, and Delete,
// start the count over (review S9).
func TestUnreachableCountStartsOverWhenTheCheckIsSkipped(t *testing.T) {
	tg, _, inst, sts := readyInstance(t)
	ns := HostNamespace(inst)
	tg.Dial = func(context.Context, string) error { return errors.New("connection refused") }
	ctx := context.Background()
	for i := 1; i < UnreachableAfter; i++ {
		if st, err := tg.Ensure(ctx, inst); err != nil || !st.Ready {
			t.Fatalf("failed check %d: %+v %v", i, st, err)
		}
	}
	sts.Status.ReadyReplicas = 0
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ := tg.Ensure(ctx, inst); st.Reason != "ControlPlanePending" || tg.failures[ns] != 0 {
		t.Fatalf("skipped check: %+v (failures %d)", st, tg.failures[ns])
	}
	sts.Status.ReadyReplicas = 1
	if err := tg.Client.Status().Update(ctx, sts); err != nil {
		t.Fatal(err)
	}
	if st, _ := tg.Ensure(ctx, inst); !st.Ready || tg.failures[ns] != 1 {
		t.Fatalf("first failure after the skip: %+v (failures %d)", st, tg.failures[ns])
	}
	if _, err := tg.Delete(ctx, inst); err != nil || tg.failures[ns] != 0 {
		t.Fatalf("Delete kept the count: %v (failures %d)", err, tg.failures[ns])
	}
}

func TestDefaultDial(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	tg := &Target{}
	if err := tg.dial(context.Background(), addr); err != nil {
		t.Fatalf("dial a listener: %v", err)
	}
	l.Close()
	if err := tg.dial(context.Background(), addr); err == nil {
		t.Fatal("dial a closed port succeeded")
	}
}

func TestEnsureReinstallsAFailedRelease(t *testing.T) {
	for _, status := range []string{"failed", "pending-install"} {
		inst := instance("team-a", "one")
		ns := HostNamespace(inst)
		helm := &fakeHelm{installed: map[string]map[string]any{ns: {}}, status: map[string]string{ns: status}}
		tg := &Target{Client: newClient(t, ownedNamespace(inst)), Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
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
	tg := &Target{Client: newClient(t, theirs), Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser}
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
	tg := &Target{Client: racy, Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
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
	tg := &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser}

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
