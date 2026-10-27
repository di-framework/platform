package installer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/auto"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

var errLocked = errors.New("the stack is currently locked by 1 lock(s)")

// fakeStack records calls and fails each operation a scripted number of times.
type fakeStack struct {
	calls     []string
	fail      map[string][]error // per operation, one error per call (nil = success)
	config    auto.ConfigMap
	held      auto.ConfigMap // what GetAllConfig returns
	removed   []string
	outputs   auto.OutputMap
	cancelErr error
	state     apitype.UntypedDeployment
	replaced  []string
}

func (f *fakeStack) next(op string) error {
	f.calls = append(f.calls, op)
	if errs := f.fail[op]; len(errs) > 0 {
		f.fail[op] = errs[1:]
		return errs[0]
	}
	return nil
}
func (f *fakeStack) SetAllConfig(_ context.Context, c auto.ConfigMap) error {
	f.config = c
	return f.next("config")
}
func (f *fakeStack) GetAllConfig(context.Context) (auto.ConfigMap, error) {
	return f.held, f.next("getconfig")
}
func (f *fakeStack) RemoveAllConfig(_ context.Context, keys []string) error {
	f.removed = append(f.removed, keys...)
	return f.next("rmconfig")
}
func (f *fakeStack) Up(context.Context) error      { return f.next("up") }
func (f *fakeStack) Refresh(context.Context) error { return f.next("refresh") }
func (f *fakeStack) UpReplacing(_ context.Context, urns []string) error {
	f.replaced = urns
	return f.next("up-replace")
}
func (f *fakeStack) Export(context.Context) (apitype.UntypedDeployment, error) {
	return f.state, f.next("export")
}
func (f *fakeStack) Cancel(context.Context) error {
	f.calls = append(f.calls, "cancel")
	return f.cancelErr
}
func (f *fakeStack) Destroy(context.Context) error { return f.next("destroy") }
func (f *fakeStack) Outputs(context.Context) (auto.OutputMap, error) {
	return f.outputs, f.next("outputs")
}
func (f *fakeStack) Remove(context.Context) error { return f.next("remove") }

func newTestPulumi(t *testing.T, s *fakeStack) (*Pulumi, *int) {
	t.Helper()
	npm := 0
	return &Pulumi{
		StateDir: t.TempDir(),
		npmInstall: func(_ context.Context, dir string) error {
			npm++
			pkg := filepath.Join(dir, "node_modules", "@di-framework", "platform")
			if err := os.MkdirAll(pkg, 0o700); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(pkg, "package.json"), []byte("{}"), 0o600)
		},
		open: func(context.Context, *Pulumi, string, string, string) (stack, error) {
			return s, nil
		},
		locked: func(err error) bool { return errors.Is(err, errLocked) },
	}, &npm
}

func request() Request {
	return Request{
		ID: "team-a.pi-one", Version: "6.0.17", Kubeconfig: []byte("apiVersion: v1\n"),
		Settings: map[string]any{"networkPolicyEngine": "existing", "httpNodePort": 0, "kubernetesEndpoint": "https://pi-one.example:443"},
	}
}

func TestInstallRunsUpAndReadsEndpoints(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}, outputs: auto.OutputMap{
		"endpoints": {Value: map[string]any{"kubernetes": "https://pi-one.example:443", "http": "http://gw"}},
	}}
	p, npm := newTestPulumi(t, s)
	r, err := p.Install(context.Background(), request(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"config", "up", "outputs"}; !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("calls %v, want %v", s.calls, want)
	}
	if r != (Result{KubernetesEndpoint: "https://pi-one.example:443", HTTPEndpoint: "http://gw"}) {
		t.Fatalf("result %+v", r)
	}
	projectDir := filepath.Join(p.StateDir, "team-a.pi-one", "project")
	if got := s.config["platform-instance:kubeconfig"]; got.Value != filepath.Join(projectDir, "kubeconfig") || !got.Secret {
		t.Fatalf("kubeconfig config %+v", got)
	}
	if got := s.config["platform-instance:httpNodePort"].Value; got != "0" {
		t.Fatalf("httpNodePort config %q, want JSON 0", got)
	}
	if got := s.config["platform-instance:networkPolicyEngine"].Value; got != "existing" {
		t.Fatalf("networkPolicyEngine config %q", got)
	}
	pkg, _ := os.ReadFile(filepath.Join(projectDir, "package.json"))
	if !strings.Contains(string(pkg), `"@di-framework/platform": "6.0.17"`) {
		t.Fatalf("package.json pins:\n%s", pkg)
	}
	info, _ := os.Stat(filepath.Join(projectDir, "kubeconfig"))
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("kubeconfig mode %v", info.Mode())
	}

	// Same version again: no second npm install. A new version installs again.
	s.calls = nil
	if _, err := p.Install(context.Background(), request(), Options{}); err != nil {
		t.Fatal(err)
	}
	next := request()
	next.Version = "6.0.18"
	if _, err := p.Install(context.Background(), next, Options{}); err != nil {
		t.Fatal(err)
	}
	if *npm != 2 {
		t.Fatalf("npm installs %d, want 2 (6.0.17 once, 6.0.18 once)", *npm)
	}

	// node_modules lost under a matching stamp (a partial volume restore): install again.
	projectDir, _ = p.dirs(next.ID)
	if err := os.RemoveAll(filepath.Join(projectDir, "node_modules")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Install(context.Background(), next, Options{}); err != nil {
		t.Fatal(err)
	}
	if *npm != 3 {
		t.Fatalf("npm installs %d, want 3 after node_modules went missing", *npm)
	}
}

func TestRepairRefreshesBeforeUp(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}}
	p, _ := newTestPulumi(t, s)
	if _, err := p.Install(context.Background(), request(), Options{Refresh: true}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"config", "refresh", "up", "outputs"}; !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("calls %v, want %v", s.calls, want)
	}
}

const releaseState = `{"resources":[
 {"urn":"urn:pulumi:instance::platform-instance::pulumi:pulumi:Stack::platform-instance-instance","type":"pulumi:pulumi:Stack"},
 {"urn":"urn:pulumi:instance::platform-instance::kubernetes:helm.sh/v3:Release::wasmcloud","type":"kubernetes:helm.sh/v3:Release"},
 {"urn":"urn:pulumi:instance::platform-instance::kubernetes:helm.sh/v3:Release::other","type":"kubernetes:helm.sh/v3:Release"},
 {"urn":"urn:pulumi:instance::platform-instance::kubernetes:core/v1:Secret::wasmcloud","type":"kubernetes:core/v1:Secret"}]}`

// A resync (#466) replaces the platform Release, found in the state, after the refresh.
func TestResyncReplacesThePlatformRelease(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}, state: apitype.UntypedDeployment{Deployment: json.RawMessage(releaseState)}}
	p, _ := newTestPulumi(t, s)
	if _, err := p.Install(context.Background(), request(), Options{Refresh: true, ReplaceRelease: true}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"config", "refresh", "export", "up-replace", "outputs"}; !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("calls %v, want %v", s.calls, want)
	}
	if want := []string{"urn:pulumi:instance::platform-instance::kubernetes:helm.sh/v3:Release::wasmcloud"}; !reflect.DeepEqual(s.replaced, want) {
		t.Fatalf("replaced %v, want %v", s.replaced, want)
	}
}

func TestResyncReplaceErrors(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{"export": {errors.New("no state")}}}
	p, _ := newTestPulumi(t, s)
	if _, err := p.Install(context.Background(), request(), Options{ReplaceRelease: true}); err == nil || err.Error() != "export state: no state" {
		t.Fatalf("export error: %v", err)
	}
	s = &fakeStack{fail: map[string][]error{}, state: apitype.UntypedDeployment{Deployment: json.RawMessage("[")}}
	p, _ = newTestPulumi(t, s)
	if _, err := p.Install(context.Background(), request(), Options{ReplaceRelease: true}); err == nil || !strings.Contains(err.Error(), "read state") {
		t.Fatalf("bad state: %v", err)
	}
	if urns, err := releaseURNs(apitype.UntypedDeployment{}); err != nil || urns != nil {
		t.Fatalf("empty state: %v %v", urns, err)
	}
}

func TestLockRecovery(t *testing.T) {
	unreachable := errors.New("kubernetes API unreachable")
	refreshFailed := errors.New("refresh failed")
	tests := []struct {
		name      string
		fail      map[string][]error
		refresh   bool
		wantCalls []string
		wantErr   error
	}{
		{
			name:      "cancel clears the stale lock, then refresh and one retry",
			fail:      map[string][]error{"up": {errLocked, nil}},
			wantCalls: []string{"config", "up", "cancel", "refresh", "up", "outputs"},
		},
		{
			name:      "a lock during the repair refresh is recovered too",
			fail:      map[string][]error{"refresh": {errLocked, nil, nil}},
			refresh:   true,
			wantCalls: []string{"config", "refresh", "cancel", "refresh", "refresh", "up", "outputs"},
		},
		{
			name:      "retries once only",
			fail:      map[string][]error{"up": {errLocked, errLocked}},
			wantCalls: []string{"config", "up", "cancel", "refresh", "up"},
			wantErr:   errLocked,
		},
		{
			name:      "other errors are not retried",
			fail:      map[string][]error{"up": {unreachable}},
			wantCalls: []string{"config", "up"},
			wantErr:   unreachable,
		},
		{
			name:      "a failed refresh after recovery stops the retry",
			fail:      map[string][]error{"up": {errLocked}, "refresh": {refreshFailed}},
			wantCalls: []string{"config", "up", "cancel", "refresh"},
			wantErr:   refreshFailed,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &fakeStack{fail: tt.fail}
			p, _ := newTestPulumi(t, s)
			_, err := p.Install(context.Background(), request(), Options{Refresh: tt.refresh})
			if !errors.Is(err, tt.wantErr) || (tt.wantErr == nil && err != nil) {
				t.Fatalf("err %v, want %v", err, tt.wantErr)
			}
			if !reflect.DeepEqual(s.calls, tt.wantCalls) {
				t.Fatalf("calls %v, want %v", s.calls, tt.wantCalls)
			}
		})
	}
}

func TestLockFilesRemovedWhenCancelFails(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{"up": {errLocked, nil}}, cancelErr: errors.New("cancel not supported")}
	p, _ := newTestPulumi(t, s)
	locks := filepath.Join(p.StateDir, "team-a.pi-one", "state", ".pulumi", "locks", "organization", projectName, stackName)
	lock, keep := filepath.Join(locks, "a1b2.json"), filepath.Join(locks, "README")
	writeFiles(t, lock, keep)
	if _, err := p.Install(context.Background(), request(), Options{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(lock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale lock still present: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("non-lock file removed: %v", err)
	}
}

// writeFiles creates each file (and its directory) with "{}".
func writeFiles(t *testing.T, files ...string) {
	t.Helper()
	for _, f := range files {
		if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInvalidRequests(t *testing.T) {
	for name, mutate := range map[string]func(*Request){
		"path traversal id":    func(r *Request) { r.ID = "../other" },
		"version range":        func(r *Request) { r.Version = "^6.0.17" },
		"no kubeconfig":        func(r *Request) { r.Kubeconfig = nil },
		"kubeconfig overrides": func(r *Request) { r.Settings["kubeconfig"] = "/etc/passwd" },
	} {
		t.Run(name, func(t *testing.T) {
			s := &fakeStack{fail: map[string][]error{}}
			p, _ := newTestPulumi(t, s)
			r := request()
			mutate(&r)
			if _, err := p.Install(context.Background(), r, Options{}); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("err %v, want ErrInvalidRequest", err)
			}
			if len(s.calls) != 0 {
				t.Fatalf("touched the stack: %v", s.calls)
			}
		})
	}
}

func TestStatusAndUninstall(t *testing.T) {
	s := &fakeStack{fail: map[string][]error{}}
	p, _ := newTestPulumi(t, s)
	req := request()

	st, err := p.Status(context.Background(), req)
	if err != nil || st.Exists {
		t.Fatalf("status before install %+v %v", st, err)
	}
	if err := p.Uninstall(context.Background(), req, UninstallOptions{Destroy: true}); err != nil || len(s.calls) != 0 {
		t.Fatalf("uninstall without state: %v, calls %v", err, s.calls)
	}

	if _, err := p.Install(context.Background(), req, Options{}); err != nil {
		t.Fatal(err)
	}
	// The file backend writes the stack checkpoint; simulate it.
	stacks := filepath.Join(p.StateDir, req.ID, "state", ".pulumi", "stacks", projectName)
	if err := os.MkdirAll(stacks, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stacks, stackName+".json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if st, err := p.Status(context.Background(), req); err != nil || !st.Exists {
		t.Fatalf("status after install %+v %v", st, err)
	}

	s.calls = nil
	if err := p.Uninstall(context.Background(), req, UninstallOptions{Destroy: true}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"outputs", "destroy", "remove"}; !reflect.DeepEqual(s.calls, want) {
		t.Fatalf("calls %v, want %v", s.calls, want)
	}
	if _, err := os.Stat(filepath.Join(p.StateDir, req.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("instance directory left behind: %v", err)
	}
}

func TestUninstallWithoutDestroyOnlyDropsState(t *testing.T) {
	// A broken instance: its stack can't even be opened. Dropping the state must still work.
	p, _ := newTestPulumi(t, nil)
	p.open = func(context.Context, *Pulumi, string, string, string) (stack, error) {
		return nil, errors.New("target unreachable")
	}
	root := filepath.Join(p.StateDir, "team-a.pi-one", "state", ".pulumi", "stacks", projectName)
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, stackName+".json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := p.Uninstall(context.Background(), request(), UninstallOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(p.StateDir, "team-a.pi-one")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("state left behind: %v", err)
	}
}
