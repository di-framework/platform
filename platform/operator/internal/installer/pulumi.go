package installer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/auto"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optdestroy"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optrefresh"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optremove"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/optup"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
	"helm.sh/helm/v3/pkg/storage/driver"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/di-framework/platform/operator/internal/targets/vcluster"
)

// DefaultNPM is npm in the operator image (node:22 alpine).
const DefaultNPM = "/usr/local/bin/npm"

const (
	// projectName is also the platform program's config namespace ("<project>:<key>").
	projectName = "platform-instance"
	stackName   = "instance"
)

// program is the whole Pulumi program: the platform's existing-cluster entrypoint, plus, with
// tenantAuth, the Secret in the platform namespace that tenantAuth.oauthClient.secretName names,
// holding the client secret from the encrypted config key tenantAuthClientSecret.
const program = `import { readFileSync } from 'node:fs';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { kubeconfig, namespace } from '@di-framework/platform/existing';

export { schemaVersion, kubeconfig, namespace, endpoints, tenants, users } from '@di-framework/platform/existing';

const config = new pulumi.Config();
const clientSecret = config.getSecret('` + TenantAuthClientSecretKey + `');
const tenantAuth = config.getObject<{ oauthClient?: { secretName?: string; secretKey?: string } }>('tenantAuth');
if (clientSecret !== undefined && tenantAuth?.oauthClient?.secretName) {
  const provider = new k8s.Provider('tenant-auth-oauth', {
    kubeconfig: pulumi.secret(readFileSync(kubeconfig, 'utf8')),
    enableServerSideApply: true,
  });
  new k8s.core.v1.Secret(
    'tenant-auth-oauth',
    {
      metadata: { name: tenantAuth.oauthClient.secretName, namespace },
      stringData: { [tenantAuth.oauthClient.secretKey ?? 'clientSecret']: clientSecret },
    },
    { provider },
  );
}
`

var (
	idPattern      = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`)
	versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)
)

// Pulumi installs through the Pulumi Automation API with a local workspace per instance:
//
//	<StateDir>/<id>/project   Pulumi.yaml, package.json, index.ts, node_modules, kubeconfig
//	<StateDir>/<id>/state     the file backend (one per instance, so locks never cross instances)
//
// StateDir is the operator's PVC. Passphrase encrypts the state's secrets.
type Pulumi struct {
	StateDir   string
	Passphrase string
	// Log receives Pulumi and npm output.
	Log io.Writer
	// NPM is the absolute path of npm; empty uses DefaultNPM.
	NPM string

	// npmInstall installs the project's dependencies; nil runs `npm install`.
	npmInstall func(ctx context.Context, dir string) error
	// uninstallRelease uninstalls a Helm release in the target; nil uses Helm.
	uninstallRelease func(ctx context.Context, kubeconfig []byte, namespace, name string) error
	// open opens the instance's stack; nil uses the Automation API.
	open func(ctx context.Context, p *Pulumi, id, projectDir, stateDir string) (stack, error)
	// locked reports a stack-lock conflict; nil uses auto.IsConcurrentUpdateError, which matches
	// both the service's 409 and the file backend's "the stack is currently locked by".
	locked func(error) bool
}

// stack is the part of auto.Stack the installer uses, so lock recovery is testable.
type stack interface {
	SetAllConfig(ctx context.Context, c auto.ConfigMap) error
	GetAllConfig(ctx context.Context) (auto.ConfigMap, error)
	RemoveAllConfig(ctx context.Context, keys []string) error
	Up(ctx context.Context) error
	// Export returns the stack's state.
	Export(ctx context.Context) (apitype.UntypedDeployment, error)
	Refresh(ctx context.Context) error
	Cancel(ctx context.Context) error
	Destroy(ctx context.Context) error
	Outputs(ctx context.Context) (auto.OutputMap, error)
	Remove(ctx context.Context) error
}

var _ Installer = (*Pulumi)(nil)

// Install writes the instance's project, installs @di-framework/platform@Version, sets config and
// runs up (after a refresh when opts.Refresh). A stale lock left by a crash mid-update is
// cleared, followed by a refresh, and the update is retried once.
func (p *Pulumi) Install(ctx context.Context, req Request, opts Options) (Result, error) {
	if err := validate(req); err != nil {
		return Result{}, err
	}
	projectDir, stateDir := p.dirs(req.ID)
	if err := p.writeProject(ctx, req, projectDir, stateDir); err != nil {
		return Result{}, err
	}
	if req.ApprovedHostImage != "" {
		if err := checkApprovedHostImage(projectDir, req.Version, req.ApprovedHostImage); err != nil {
			return Result{}, err
		}
	}
	s, err := p.openStack(ctx, req.ID, projectDir, stateDir)
	if err != nil {
		return Result{}, err
	}
	config, err := configMap(req, filepath.Join(projectDir, "kubeconfig"))
	if err != nil {
		return Result{}, err
	}
	if err := s.SetAllConfig(ctx, config); err != nil {
		return Result{}, fmt.Errorf("set config: %w", err)
	}
	if err := unset(ctx, s, req, config); err != nil {
		return Result{}, err
	}
	if opts.ReinstallRelease {
		if err := p.uninstallPlatformRelease(ctx, s, req); err != nil {
			return Result{}, err
		}
	}
	// The refresh after the uninstall drops the Release from the state, so the up creates it.
	if opts.Refresh || opts.ReinstallRelease {
		if err := p.withLockRecovery(ctx, s, stateDir, "refresh", s.Refresh); err != nil {
			return Result{}, err
		}
	}
	if err := p.withLockRecovery(ctx, s, stateDir, "up", s.Up); err != nil {
		return Result{}, err
	}
	if opts.ReinstallRelease {
		// The up must have installed the Release again; a program without it would leave the
		// chart's lost objects missing.
		rel, err := p.stateRelease(ctx, s)
		if err != nil {
			return Result{}, err
		}
		if rel == nil {
			return Result{}, fmt.Errorf("reinstall: no Helm Release %q in the install state after up", PlatformRelease)
		}
	}
	return result(ctx, s)
}

func (p *Pulumi) stateRelease(ctx context.Context, s stack) (*helmRelease, error) {
	dep, err := s.Export(ctx)
	if err != nil {
		return nil, fmt.Errorf("export state: %w", err)
	}
	return platformRelease(dep)
}

// uninstallPlatformRelease removes the platform Release, named in the state, from the target.
// A Release already gone is fine. One already missing from the state was uninstalled by an
// earlier round whose up failed: there is nothing to uninstall, and the up installs it.
func (p *Pulumi) uninstallPlatformRelease(ctx context.Context, s stack, req Request) error {
	rel, err := p.stateRelease(ctx, s)
	if err != nil {
		return err
	}
	if rel == nil {
		p.logf("reinstall: no %s Release in the state (an earlier round uninstalled it); skipping the uninstall\n", PlatformRelease)
		return nil
	}
	p.logf("reinstall: helm uninstall %s -n %s\n", rel.Name, rel.Namespace)
	uninstall := p.uninstallRelease
	if uninstall == nil {
		uninstall = helmUninstall
	}
	if err := uninstall(ctx, req.Kubeconfig, rel.Namespace, rel.Name); err != nil && !errors.Is(err, driver.ErrReleaseNotFound) {
		return fmt.Errorf("reinstall: helm uninstall %s/%s: %w", rel.Namespace, rel.Name, err)
	}
	return nil
}

// helmUninstall uninstalls a release in the cluster kubeconfig addresses.
func helmUninstall(ctx context.Context, kubeconfig []byte, namespace, name string) error {
	cfg, err := clientcmd.RESTConfigFromKubeConfig(kubeconfig)
	if err != nil {
		return err
	}
	return (&vcluster.Helm{Config: cfg}).Uninstall(ctx, namespace, name)
}

// PlatformRelease is the Pulumi name of the platform's Helm Release (the runtime-operator chart).
const PlatformRelease = "wasmcloud"

const releaseType = "kubernetes:helm.sh/v3:Release"

// helmRelease is a Helm release's name and namespace.
type helmRelease struct{ Name, Namespace string }

// platformRelease finds the platform Release in the state, or nil.
func platformRelease(dep apitype.UntypedDeployment) (*helmRelease, error) {
	var state struct {
		Resources []struct {
			URN     string `json:"urn"`
			Type    string `json:"type"`
			Outputs struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"outputs"`
		} `json:"resources"`
	}
	if len(dep.Deployment) > 0 {
		if err := json.Unmarshal(dep.Deployment, &state); err != nil {
			return nil, fmt.Errorf("read state: %w", err)
		}
	}
	for _, r := range state.Resources {
		if r.Type == releaseType && strings.HasSuffix(r.URN, "::"+PlatformRelease) && r.Outputs.Name != "" {
			return &helmRelease{Name: r.Outputs.Name, Namespace: r.Outputs.Namespace}, nil
		}
	}
	return nil, nil
}

// Status reports whether install state exists and the last outputs, without an update.
func (p *Pulumi) Status(ctx context.Context, req Request) (State, error) {
	if !idPattern.MatchString(req.ID) {
		return State{}, fmt.Errorf("%w: id %q", ErrInvalidRequest, req.ID)
	}
	projectDir, stateDir := p.dirs(req.ID)
	if _, err := os.Stat(filepath.Join(stateDir, ".pulumi", "stacks", projectName, stackName+".json")); errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	} else if err != nil {
		return State{}, err
	}
	s, err := p.openStack(ctx, req.ID, projectDir, stateDir)
	if err != nil {
		return State{}, err
	}
	r, err := result(ctx, s)
	if err != nil {
		return State{}, err
	}
	return State{Exists: true, Result: r}, nil
}

// Uninstall removes the instance's project and state, after destroying the platform's resources
// when opts.Destroy. Without state it only removes what's left of the project.
func (p *Pulumi) Uninstall(ctx context.Context, req Request, opts UninstallOptions) error {
	if !idPattern.MatchString(req.ID) {
		return fmt.Errorf("%w: id %q", ErrInvalidRequest, req.ID)
	}
	root := filepath.Join(p.StateDir, req.ID)
	if !opts.Destroy {
		return os.RemoveAll(root)
	}
	st, err := p.Status(ctx, req)
	if err != nil {
		return err
	}
	if !st.Exists {
		return os.RemoveAll(root)
	}
	projectDir, stateDir := p.dirs(req.ID)
	if len(req.Kubeconfig) > 0 {
		if err := os.WriteFile(filepath.Join(projectDir, "kubeconfig"), req.Kubeconfig, 0o600); err != nil {
			return err
		}
	}
	s, err := p.openStack(ctx, req.ID, projectDir, stateDir)
	if err != nil {
		return err
	}
	if err := p.withLockRecovery(ctx, s, stateDir, "destroy", s.Destroy); err != nil {
		return err
	}
	if err := s.Remove(ctx); err != nil {
		return fmt.Errorf("remove stack: %w", err)
	}
	return os.RemoveAll(root)
}

// withLockRecovery runs op. If another update holds the stack's lock, that update is from a
// crashed operator: the controller runs one operation per instance and leader election runs one
// operator, so nothing live can hold it. It cancels (or, where the file backend can't cancel,
// removes the lock files), refreshes, and retries op once.
func (p *Pulumi) withLockRecovery(ctx context.Context, s stack, stateDir, name string, op func(context.Context) error) error {
	locked := p.locked
	if locked == nil {
		locked = auto.IsConcurrentUpdateError
	}
	err := op(ctx)
	if err == nil || !locked(err) {
		return wrap(name, err)
	}
	p.logf("%s: stack locked by an interrupted update; clearing the stale lock\n", name)
	if cerr := s.Cancel(ctx); cerr != nil {
		p.logf("%s: cancel failed (%v); removing the lock files\n", name, cerr)
		if rerr := removeLocks(stateDir); rerr != nil {
			return fmt.Errorf("%s: clear stale lock: %w", name, errors.Join(cerr, rerr))
		}
	}
	if err := s.Refresh(ctx); err != nil {
		return wrap("refresh after lock recovery", err)
	}
	return wrap(name, op(ctx))
}

// removeLocks deletes the stack's lock files from its file backend.
func removeLocks(stateDir string) error {
	dir := filepath.Join(stateDir, ".pulumi", "locks", "organization", projectName, stackName)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *Pulumi) dirs(id string) (projectDir, stateDir string) {
	root := filepath.Join(p.StateDir, id)
	return filepath.Join(root, "project"), filepath.Join(root, "state")
}

// writeProject writes the project files and the kubeconfig, and installs dependencies when the
// pinned platform version changed.
func (p *Pulumi) writeProject(ctx context.Context, req Request, projectDir, stateDir string) error {
	for _, d := range []string{projectDir, stateDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	pkg, err := json.MarshalIndent(map[string]any{
		"private": true,
		"main":    "index.ts",
		"dependencies": map[string]string{
			"@di-framework/platform": req.Version,
			"typescript":             "5.9.3",
			"@types/node":            "22.18.0",
		},
	}, "", "  ")
	if err != nil {
		return err
	}
	tsconfig := `{"compilerOptions":{"target":"ES2022","module":"commonjs","moduleResolution":"node","strict":true,"skipLibCheck":true,"esModuleInterop":true},"include":["index.ts"]}` + "\n"
	files := map[string][]byte{
		"package.json":  append(pkg, '\n'),
		"index.ts":      []byte(program),
		"tsconfig.json": []byte(tsconfig),
		"kubeconfig":    req.Kubeconfig,
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(projectDir, name), data, 0o600); err != nil {
			return err
		}
	}
	// The stamp alone isn't enough: node_modules can go missing under it (a partial restore of
	// the state volume), and Pulumi would then fail on a missing module every round.
	stamp := filepath.Join(projectDir, ".installed-version")
	installed := filepath.Join(projectDir, "node_modules", "@di-framework", "platform", "package.json")
	if b, err := os.ReadFile(stamp); err == nil && string(b) == req.Version {
		if _, err := os.Stat(installed); err == nil {
			return nil
		}
	}
	install := p.npmInstall
	if install == nil {
		install = p.runNPM
	}
	if err := install(ctx, projectDir); err != nil {
		return fmt.Errorf("install @di-framework/platform@%s: %w", req.Version, err)
	}
	return os.WriteFile(stamp, []byte(req.Version), 0o600)
}

func (p *Pulumi) runNPM(ctx context.Context, dir string) error {
	npm := p.NPM
	if npm == "" {
		npm = DefaultNPM
	}
	if !filepath.IsAbs(npm) {
		return fmt.Errorf("npm path %q is not absolute", npm)
	}
	cmd := exec.CommandContext(ctx, npm, "install", "--no-audit", "--no-fund")
	cmd.Dir = dir
	cmd.Stdout, cmd.Stderr = p.log(), p.log()
	return cmd.Run()
}

func (p *Pulumi) openStack(ctx context.Context, id, projectDir, stateDir string) (stack, error) {
	if p.open != nil {
		return p.open(ctx, p, id, projectDir, stateDir)
	}
	return openAutoStack(ctx, p, projectDir, stateDir)
}

func openAutoStack(ctx context.Context, p *Pulumi, projectDir, stateDir string) (stack, error) {
	backend := "file://" + stateDir
	s, err := auto.UpsertStackLocalSource(ctx, stackName, projectDir,
		auto.Project(workspace.Project{
			Name:    tokens.PackageName(projectName),
			Runtime: workspace.NewProjectRuntimeInfo("nodejs", map[string]any{"typescript": true}),
			Backend: &workspace.ProjectBackend{URL: backend},
		}),
		auto.EnvVars(map[string]string{
			"PULUMI_BACKEND_URL":       backend,
			"PULUMI_CONFIG_PASSPHRASE": p.Passphrase,
			"PULUMI_SKIP_UPDATE_CHECK": "true",
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("open stack: %w", err)
	}
	return &autoStack{s: s, log: p.log()}, nil
}

// autoStack adapts auto.Stack to stack.
type autoStack struct {
	s   auto.Stack
	log io.Writer
}

func (a *autoStack) SetAllConfig(ctx context.Context, c auto.ConfigMap) error {
	return a.s.SetAllConfig(ctx, c)
}
func (a *autoStack) GetAllConfig(ctx context.Context) (auto.ConfigMap, error) {
	return a.s.GetAllConfig(ctx)
}
func (a *autoStack) RemoveAllConfig(ctx context.Context, keys []string) error {
	return a.s.RemoveAllConfig(ctx, keys)
}
func (a *autoStack) Up(ctx context.Context) error {
	_, err := a.s.Up(ctx, optup.ProgressStreams(a.log), optup.ErrorProgressStreams(a.log))
	return err
}
func (a *autoStack) Export(ctx context.Context) (apitype.UntypedDeployment, error) {
	return a.s.Export(ctx)
}
func (a *autoStack) Refresh(ctx context.Context) error {
	_, err := a.s.Refresh(ctx, optrefresh.ProgressStreams(a.log), optrefresh.ErrorProgressStreams(a.log))
	return err
}
func (a *autoStack) Cancel(ctx context.Context) error { return a.s.Cancel(ctx) }
func (a *autoStack) Destroy(ctx context.Context) error {
	_, err := a.s.Destroy(ctx, optdestroy.ProgressStreams(a.log), optdestroy.ErrorProgressStreams(a.log))
	return err
}
func (a *autoStack) Outputs(ctx context.Context) (auto.OutputMap, error) { return a.s.Outputs(ctx) }
func (a *autoStack) Remove(ctx context.Context) error {
	return a.s.Workspace().RemoveStack(ctx, stackName, optremove.Force())
}

func validate(req Request) error {
	switch {
	case !idPattern.MatchString(req.ID):
		return fmt.Errorf("%w: id %q", ErrInvalidRequest, req.ID)
	case !versionPattern.MatchString(req.Version):
		return fmt.Errorf("%w: version %q is not an exact version", ErrInvalidRequest, req.Version)
	case len(req.Kubeconfig) == 0:
		return fmt.Errorf("%w: no kubeconfig", ErrInvalidRequest)
	}
	for key := range req.Settings {
		if key == "kubeconfig" {
			return fmt.Errorf("%w: settings must not set kubeconfig", ErrInvalidRequest)
		}
		if _, dup := req.SecretSettings[key]; dup {
			return fmt.Errorf("%w: %s is both a setting and a secret setting", ErrInvalidRequest, key)
		}
	}
	for key := range req.SecretSettings {
		if key == "kubeconfig" {
			return fmt.Errorf("%w: settings must not set kubeconfig", ErrInvalidRequest)
		}
	}
	for _, key := range req.Unset {
		if key == "kubeconfig" {
			return fmt.Errorf("%w: kubeconfig can't be unset", ErrInvalidRequest)
		}
	}
	return nil
}

// unset removes the req.Unset keys that the stack config holds and config doesn't set.
func unset(ctx context.Context, s stack, req Request, config auto.ConfigMap) error {
	if len(req.Unset) == 0 {
		return nil
	}
	current, err := s.GetAllConfig(ctx)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	var keys []string
	for _, k := range req.Unset {
		full := projectName + ":" + k
		if _, held := current[full]; held {
			if _, set := config[full]; !set {
				keys = append(keys, full)
			}
		}
	}
	if len(keys) == 0 {
		return nil
	}
	if err := s.RemoveAllConfig(ctx, keys); err != nil {
		return fmt.Errorf("unset config: %w", err)
	}
	return nil
}

// configMap is the stack config: Settings as JSON values plus the kubeconfig path (a secret, as
// the platform documents), in sorted key order.
func configMap(req Request, kubeconfigPath string) (auto.ConfigMap, error) {
	c := auto.ConfigMap{projectName + ":kubeconfig": {Value: kubeconfigPath, Secret: true}}
	keys := make([]string, 0, len(req.Settings))
	for k := range req.Settings {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := req.Settings[k]
		s, ok := v.(string)
		if !ok {
			b, err := json.Marshal(v)
			if err != nil {
				return nil, fmt.Errorf("setting %s: %w", k, err)
			}
			s = string(b)
		}
		c[projectName+":"+k] = auto.ConfigValue{Value: s}
	}
	for k, v := range req.SecretSettings {
		c[projectName+":"+k] = auto.ConfigValue{Value: v, Secret: true}
	}
	return c, nil
}

// result reads the endpoints output ({kubernetes, http}) the existing entrypoint exports.
func result(ctx context.Context, s stack) (Result, error) {
	out, err := s.Outputs(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("read outputs: %w", err)
	}
	var r Result
	if ep, ok := out["endpoints"].Value.(map[string]any); ok {
		r.KubernetesEndpoint, _ = ep["kubernetes"].(string)
		r.HTTPEndpoint, _ = ep["http"].(string)
	}
	return r, nil
}

func wrap(name string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", name, err)
}

func (p *Pulumi) log() io.Writer {
	if p.Log == nil {
		return io.Discard
	}
	return p.Log
}

func (p *Pulumi) logf(format string, args ...any) { fmt.Fprintf(p.log(), format, args...) }
