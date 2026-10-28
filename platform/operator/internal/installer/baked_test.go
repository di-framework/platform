package installer

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/auto"
)

var errNoRegistry = errors.New("npm: getaddrinfo ENOTFOUND registry.npmjs.org")

// bake lays out what the image bakes: the install project for version (package.json as the operator
// writes it, a lockfile, node_modules with the platform package and a .bin symlink) and one Pulumi
// plugin.
func bake(t *testing.T, version string) (project, plugins string) {
	t.Helper()
	root := t.TempDir()
	project, plugins = filepath.Join(root, "project"), filepath.Join(root, "pulumi-plugins")
	pkg, err := projectPackageJSON(version)
	if err != nil {
		t.Fatal(err)
	}
	platform := filepath.Join(project, "node_modules", "@di-framework", "platform")
	bin := filepath.Join(project, "node_modules", ".bin")
	plugin := filepath.Join(plugins, "resource-kubernetes-v4.34.2")
	for _, d := range []string{platform, bin, plugin, filepath.Join(plugins, "not-a-plugin")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		filepath.Join(project, "package.json"):              string(pkg),
		filepath.Join(project, "package-lock.json"):         `{"lockfileVersion":3}`,
		filepath.Join(platform, "package.json"):             `{"name":"@di-framework/platform","version":"` + version + `"}`,
		filepath.Join(platform, "index.js"):                 "module.exports = {};\n",
		filepath.Join(plugin, "pulumi-resource-kubernetes"): "#!/bin/sh\n",
	}
	for path, data := range files {
		if err := os.WriteFile(path, []byte(data), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("../@di-framework/platform/index.js", filepath.Join(bin, "platform")); err != nil {
		t.Fatal(err)
	}
	return project, plugins
}

// offlinePulumi is an installer whose npm registry is unreachable, with the image's bake.
func offlinePulumi(t *testing.T, s *fakeStack, project, plugins string) (*Pulumi, *int, string) {
	t.Helper()
	p, npm := newTestPulumi(t, s)
	install := p.npmInstall
	p.npmInstall = func(ctx context.Context, dir string) error {
		if err := install(ctx, dir); err != nil {
			return err
		}
		return errNoRegistry
	}
	cache := filepath.Join(t.TempDir(), ".pulumi", "plugins")
	p.BakedProject, p.BakedPlugins = project, plugins
	p.pluginCache = func() (string, error) { return cache, nil }
	return p, npm, cache
}

func TestInstallAtTheDefaultVersionNeedsNoNPM(t *testing.T) {
	project, plugins := bake(t, DefaultVersion)
	s := &fakeStack{fail: map[string][]error{}, outputs: auto.OutputMap{}}
	p, npm, cache := offlinePulumi(t, s, project, plugins)
	req := request()
	req.Version = DefaultVersion
	if _, err := p.Install(context.Background(), req, Options{}); err != nil {
		t.Fatalf("install at the default version with npm unreachable: %v", err)
	}
	if *npm != 0 {
		t.Fatalf("npm ran %d times, want 0", *npm)
	}
	projectDir, _ := p.dirs(req.ID)
	if got, err := installedVersion(projectDir); err != nil || got != DefaultVersion {
		t.Fatalf("installed %q (%v), want the baked %s", got, err, DefaultVersion)
	}
	if link, err := os.Readlink(filepath.Join(projectDir, "node_modules", ".bin", "platform")); err != nil || link != "../@di-framework/platform/index.js" {
		t.Fatalf(".bin link %q (%v)", link, err)
	}
	if _, err := os.Stat(filepath.Join(projectDir, "package-lock.json")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(projectDir, ".installed-version")); string(b) != DefaultVersion {
		t.Fatalf("stamp %q", b)
	}
	// The copy is the project's own: writable, independent of the baked tree.
	if err := os.WriteFile(filepath.Join(projectDir, "node_modules", "@di-framework", "platform", "index.js"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(project, "node_modules", "@di-framework", "platform", "index.js")); len(b) == 0 {
		t.Fatal("writing the instance's copy changed the baked project")
	}

	// The plugin host is not needed either: the baked plugin is installed in Pulumi's cache.
	plugin := filepath.Join(cache, "resource-kubernetes-v4.34.2")
	if info, err := os.Lstat(plugin); err != nil || !info.IsDir() {
		t.Fatalf("plugin dir %v (%v), want a real directory (Pulumi skips symlinked ones)", info, err)
	}
	if target, err := os.Readlink(filepath.Join(plugin, "pulumi-resource-kubernetes")); err != nil || target != filepath.Join(plugins, "resource-kubernetes-v4.34.2", "pulumi-resource-kubernetes") {
		t.Fatalf("plugin binary link %q (%v)", target, err)
	}
	if _, err := os.Stat(filepath.Join(cache, "not-a-plugin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("non-plugin directory linked: %v", err)
	}
	if _, err := os.Stat(plugin + ".partial"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial marker left: %v", err)
	}

	// Lost node_modules under the stamp (a partial volume restore) come back from the image too.
	if err := os.RemoveAll(filepath.Join(projectDir, "node_modules")); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Install(context.Background(), req, Options{}); err != nil {
		t.Fatal(err)
	}
	if *npm != 0 {
		t.Fatalf("npm ran %d times after node_modules went missing, want 0", *npm)
	}
}

func TestInstallAtAnotherVersionRunsNPM(t *testing.T) {
	project, plugins := bake(t, DefaultVersion)
	s := &fakeStack{fail: map[string][]error{}, outputs: auto.OutputMap{}}
	p, npm, _ := offlinePulumi(t, s, project, plugins)
	req := request()
	req.Version = "6.0.17"
	if req.Version == DefaultVersion {
		t.Fatal("the test needs a version the image does not bake")
	}
	_, err := p.Install(context.Background(), req, Options{})
	if !errors.Is(err, errNoRegistry) || *npm != 1 {
		t.Fatalf("install at %s: npm ran %d times, err %v; want npm install (unreachable)", req.Version, *npm, err)
	}
	if len(s.calls) != 0 {
		t.Fatalf("stack calls %v after a failed npm install", s.calls)
	}
}

func TestBakedProjectChoice(t *testing.T) {
	cases := []struct {
		name    string
		version string
		mutate  func(t *testing.T, project string)
		want    string // "" = baked; otherwise a substring of why not
	}{
		{name: "default version", version: DefaultVersion},
		{name: "other version", version: "6.0.17", want: "the image bakes @di-framework/platform@" + DefaultVersion},
		{name: "no bake", version: DefaultVersion, want: "no baked project", mutate: func(t *testing.T, project string) {
			rm(t, project)
		}},
		{name: "other dependencies", version: DefaultVersion, want: "dependencies differ", mutate: func(t *testing.T, project string) {
			deps := projectDependencies(DefaultVersion)
			deps["typescript"] = "0.0.1"
			b, _ := json.Marshal(map[string]any{"dependencies": deps})
			write(t, filepath.Join(project, "package.json"), string(b))
		}},
		{name: "not installed", version: DefaultVersion, want: "not installed", mutate: func(t *testing.T, project string) {
			rm(t, filepath.Join(project, "node_modules"))
		}},
		{name: "installed another version", version: DefaultVersion, want: "node_modules hold @di-framework/platform@9.9.9", mutate: func(t *testing.T, project string) {
			write(t, filepath.Join(project, "node_modules", "@di-framework", "platform", "package.json"), `{"version":"9.9.9"}`)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			project, _ := bake(t, DefaultVersion)
			if tc.mutate != nil {
				tc.mutate(t, project)
			}
			dir, why := (&Pulumi{BakedProject: project}).bakedProject(tc.version)
			switch {
			case tc.want == "" && dir != project:
				t.Fatalf("not baked (%s), want %s", why, project)
			case tc.want != "" && (dir != "" || !strings.Contains(why, tc.want)):
				t.Fatalf("dir %q, why %q; want npm because %q", dir, why, tc.want)
			}
		})
	}
	if dir, _ := (&Pulumi{}).bakedProject(DefaultVersion); dir != "" && dir != DefaultBakedProject {
		t.Fatalf("empty BakedProject resolved to %q", dir)
	}
}

func TestLinkBakedPlugins(t *testing.T) {
	_, plugins := bake(t, DefaultVersion)
	cache := filepath.Join(t.TempDir(), "plugins")
	name := "resource-kubernetes-v4.34.2"
	if got, err := linkBakedPlugins(plugins, cache); err != nil || !slices.Equal(got, []string{name}) {
		t.Fatalf("linked %v (%v)", got, err)
	}
	// Idempotent.
	if got, err := linkBakedPlugins(plugins, cache); err != nil || len(got) != 0 {
		t.Fatalf("relinked %v (%v)", got, err)
	}
	// An interrupted link (the .partial marker) is redone.
	write(t, filepath.Join(cache, name+".partial"), "")
	if got, err := linkBakedPlugins(plugins, cache); err != nil || len(got) != 1 {
		t.Fatalf("after an interrupted link: %v (%v)", got, err)
	}
	// So is a link left dangling by an older image's bake.
	bin := filepath.Join(cache, name, "pulumi-resource-kubernetes")
	rm(t, bin)
	if err := os.Symlink(filepath.Join(t.TempDir(), "gone"), bin); err != nil {
		t.Fatal(err)
	}
	if got, err := linkBakedPlugins(plugins, cache); err != nil || len(got) != 1 {
		t.Fatalf("after a dangling link: %v (%v)", got, err)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatal(err)
	}
	// A plugin Pulumi downloaded itself (a real file) is left alone.
	other := filepath.Join(cache, "resource-command-v1.2.1")
	write(t, filepath.Join(other, "pulumi-resource-command"), "downloaded")
	if got, err := linkBakedPlugins(plugins, cache); err != nil || len(got) != 0 {
		t.Fatalf("relinked %v (%v)", got, err)
	}
	// No bake (a dev build of the operator): nothing to link.
	if got, err := linkBakedPlugins(filepath.Join(t.TempDir(), "none"), cache); err != nil || got != nil {
		t.Fatalf("%v (%v)", got, err)
	}
}

// Concurrent reconciles link into one empty cache (pod start with several instances): no caller
// fails, exactly one links each plugin, and the cache ends complete. Run with -race.
func TestLinkBakedPluginsConcurrent(t *testing.T) {
	_, plugins := bake(t, DefaultVersion)
	name := "resource-kubernetes-v4.34.2"
	for round := 0; round < 50; round++ {
		cache := filepath.Join(t.TempDir(), "plugins")
		var wg sync.WaitGroup
		var linked atomic.Int32
		errs := make(chan error, 16)
		for range 16 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				got, err := linkBakedPlugins(plugins, cache)
				if err != nil {
					errs <- err
				}
				linked.Add(int32(len(got)))
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatalf("round %d: %v", round, err)
		}
		if n := linked.Load(); n != 1 {
			t.Fatalf("round %d: linked %d times", round, n)
		}
		if _, err := os.Stat(filepath.Join(cache, name+".partial")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("round %d: .partial left (%v)", round, err)
		}
		if _, err := os.Stat(filepath.Join(cache, name, "pulumi-resource-kubernetes")); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
	}
}

func TestPluginLinkFailureIsOnlyLogged(t *testing.T) {
	_, plugins := bake(t, DefaultVersion)
	var log bytes.Buffer
	p := &Pulumi{BakedPlugins: plugins, Log: &log, pluginCache: func() (string, error) { return "", errors.New("no home") }}
	p.linkPlugins()
	if !strings.Contains(log.String(), "baked Pulumi plugins not linked (Pulumi downloads what it needs): no home") {
		t.Fatalf("log %q", log.String())
	}
}

func rm(t *testing.T, path string) {
	t.Helper()
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The committed project the image bakes is consistent: the lockfile is for package.json, and
// plugins.txt bakes the plugin of every Pulumi provider package in it, for both image arches.
func TestBakedProjectFiles(t *testing.T) {
	var lock struct {
		Packages map[string]struct {
			Version      string            `json:"version"`
			Dependencies map[string]string `json:"dependencies"`
			Integrity    string            `json:"integrity"`
		} `json:"packages"`
	}
	b, err := os.ReadFile(filepath.Join("project", "package-lock.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &lock); err != nil {
		t.Fatal(err)
	}
	if got := lock.Packages[""].Dependencies; !maps.Equal(got, projectDependencies(DefaultVersion)) {
		t.Fatalf("package-lock.json is for %v, package.json pins %v: run `bun scripts/operator-project.ts bump %s`", got, projectDependencies(DefaultVersion), DefaultVersion)
	}
	for name, version := range projectDependencies(DefaultVersion) {
		if got := lock.Packages["node_modules/"+name]; got.Version != version || !strings.HasPrefix(got.Integrity, "sha512-") {
			t.Fatalf("package-lock.json installs %s@%s (integrity %q), want %s", name, got.Version, got.Integrity, version)
		}
	}

	want := map[string]string{} // "<name> <arch>" -> version
	for path, pkg := range lock.Packages {
		if name, ok := strings.CutPrefix(path, "node_modules/@pulumi/"); ok && !strings.Contains(name, "/") && name != "pulumi" {
			for _, arch := range []string{"amd64", "arm64"} {
				want[name+" "+arch] = pkg.Version
			}
		}
	}
	if len(want) == 0 {
		t.Fatal("no Pulumi provider packages in package-lock.json")
	}
	got := map[string]string{}
	f, err := os.Open(filepath.Join("project", "plugins.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	line := regexp.MustCompile(`^([a-z0-9-]+) ([0-9]+\.[0-9]+\.[0-9]+) (amd64|arm64) [0-9a-f]{64}$`)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if sc.Text() == "" || strings.HasPrefix(sc.Text(), "#") {
			continue
		}
		m := line.FindStringSubmatch(sc.Text())
		if m == nil {
			t.Fatalf("plugins.txt: malformed line %q", sc.Text())
		}
		if _, dup := got[m[1]+" "+m[3]]; dup {
			t.Fatalf("plugins.txt: %s %s listed twice", m[1], m[3])
		}
		got[m[1]+" "+m[3]] = m[2]
	}
	if !maps.Equal(got, want) {
		t.Fatalf("plugins.txt bakes %v, package-lock.json needs %v", got, want)
	}
}

// The image bakes the files this package embeds and checks, where the installer looks for them.
func TestDockerfileBakesTheProject(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	dockerfile := string(b)
	for _, want := range []string{
		"COPY internal/installer/project/package.json internal/installer/project/package-lock.json ./",
		"RUN npm ci --ignore-scripts",
		"internal/installer/project/plugins.txt",
		`echo "$sum  /tmp/$tgz" | sha256sum -c -`,
		"WORKDIR " + DefaultBakedProject,
		"COPY --from=project " + DefaultBakedProject + " " + DefaultBakedProject,
		"COPY --from=plugins " + DefaultBakedPlugins + " " + DefaultBakedPlugins,
	} {
		if !strings.Contains(dockerfile, want) {
			t.Errorf("Dockerfile lacks %q", want)
		}
	}
}

// entries lists a directory's names; a missing directory has none.
func entries(t *testing.T, dir string) []string {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	names := []string{}
	for _, d := range des {
		names = append(names, d.Name())
	}
	return names
}

func TestCopyBakedProjectIsAtomic(t *testing.T) {
	baked := t.TempDir()
	write(t, filepath.Join(baked, "node_modules", "a", "index.js"), "new")
	write(t, filepath.Join(baked, "node_modules", "b", "index.js"), "new")
	write(t, filepath.Join(baked, "package-lock.json"), "{}")

	orig := copyTreeFn
	t.Cleanup(func() { copyTreeFn = orig })
	// Copy part of the tree, then fail as a full disk would.
	copyTreeFn = func(src, dst string) error {
		if err := copyTree(filepath.Join(src, "a"), filepath.Join(dst, "a")); err != nil {
			return err
		}
		return errors.New("no space left on device")
	}

	for _, previous := range []bool{true, false} {
		project := t.TempDir()
		want := []string{}
		if previous {
			write(t, filepath.Join(project, "node_modules", "old", "index.js"), "old")
			want = []string{"node_modules"}
		}
		if err := copyBakedProject(baked, project); err == nil {
			t.Fatal("copyBakedProject succeeded despite the injected failure")
		}
		if got := entries(t, project); !slices.Equal(got, want) {
			t.Errorf("previous=%v: project holds %v, want %v (no temp dir, no lockfile)", previous, got, want)
		}
		if previous {
			if got := entries(t, filepath.Join(project, "node_modules")); !slices.Equal(got, []string{"old"}) {
				t.Errorf("previous node_modules changed: %v", got)
			}
		}
	}

	copyTreeFn = orig
	project := t.TempDir()
	write(t, filepath.Join(project, "node_modules", "old", "index.js"), "old")
	if err := copyBakedProject(baked, project); err != nil {
		t.Fatal(err)
	}
	if got := entries(t, filepath.Join(project, "node_modules")); !slices.Equal(got, []string{"a", "b"}) {
		t.Errorf("node_modules holds %v, want [a b]", got)
	}
	if got := entries(t, project); !slices.Equal(got, []string{"node_modules", "package-lock.json"}) {
		t.Errorf("project holds %v", got)
	}
}
