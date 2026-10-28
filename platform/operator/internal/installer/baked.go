package installer

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
)

// The operator image bakes one install project (#431): project/package.json and
// project/package-lock.json installed with `npm ci` at DefaultBakedProject, and the Pulumi resource
// plugins its packages need, listed with their sha256 in project/plugins.txt, at
// DefaultBakedPlugins. An instance at DefaultVersion then installs with neither npm nor the Pulumi
// plugin host reachable; any other version runs `npm install` as before.
//
// project/package.json is the single source of the install project's dependencies: every
// instance's package.json is it with @di-framework/platform set to spec.version, and the image bakes
// it as is. The release PR moves its @di-framework/platform pin to the newest published release
// (scripts/operator-project.ts bump).

// PlatformPackage is the npm package an install runs.
const PlatformPackage = "@di-framework/platform"

const (
	// DefaultBakedProject is where the operator image bakes the install project for DefaultVersion.
	DefaultBakedProject = "/opt/platform-operator/project"
	// DefaultBakedPlugins is where the operator image bakes the project's Pulumi resource plugins,
	// one <kind>-<name>-v<version> directory each, the layout of Pulumi's plugin cache.
	DefaultBakedPlugins = "/opt/platform-operator/pulumi-plugins"
)

//go:embed project/package.json
var projectManifest []byte

// manifest is the part of a project's package.json the installer writes and compares.
type manifest struct {
	Private      bool              `json:"private"`
	Main         string            `json:"main"`
	Dependencies map[string]string `json:"dependencies"`
}

// DefaultVersion is the @di-framework/platform version the operator image bakes: the
// project/package.json pin.
var DefaultVersion = mustDefaultVersion()

func mustDefaultVersion() string {
	var m manifest
	if err := json.Unmarshal(projectManifest, &m); err != nil {
		panic(fmt.Sprintf("installer: project/package.json: %v", err))
	}
	v := m.Dependencies[PlatformPackage]
	if !versionPattern.MatchString(v) {
		panic(fmt.Sprintf("installer: project/package.json pins %s to %q, not an exact version", PlatformPackage, v))
	}
	return v
}

// projectDependencies are the project's dependencies for an install of version.
func projectDependencies(version string) map[string]string {
	var m manifest
	if err := json.Unmarshal(projectManifest, &m); err != nil {
		panic(err) // checked by mustDefaultVersion
	}
	m.Dependencies[PlatformPackage] = version
	return m.Dependencies
}

// projectPackageJSON is an instance's package.json for version.
func projectPackageJSON(version string) ([]byte, error) {
	pkg, err := json.MarshalIndent(map[string]any{
		"private":      true,
		"main":         "index.ts",
		"dependencies": projectDependencies(version),
	}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(pkg, '\n'), nil
}

// bakedProject returns the baked project directory when it was installed for version with exactly
// the dependencies an install of version needs, or "" and why not.
func (p *Pulumi) bakedProject(version string) (string, string) {
	dir := p.BakedProject
	if dir == "" {
		dir = DefaultBakedProject
	}
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return "", fmt.Sprintf("no baked project (%v)", err)
	}
	var m manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return "", fmt.Sprintf("baked project package.json: %v", err)
	}
	if m.Dependencies[PlatformPackage] != version {
		return "", fmt.Sprintf("the image bakes %s@%s", PlatformPackage, m.Dependencies[PlatformPackage])
	}
	if !maps.Equal(m.Dependencies, projectDependencies(version)) {
		return "", "the baked project's dependencies differ from the operator's"
	}
	installed, err := installedVersion(dir)
	if err != nil {
		return "", fmt.Sprintf("baked project not installed (%v)", err)
	}
	if installed != version {
		return "", fmt.Sprintf("the baked node_modules hold %s@%s", PlatformPackage, installed)
	}
	return dir, ""
}

// installedVersion is the version of the platform package installed in a project directory.
func installedVersion(projectDir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(projectDir, "node_modules", "@di-framework", "platform", "package.json"))
	if err != nil {
		return "", err
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(b, &pkg); err != nil {
		return "", err
	}
	return pkg.Version, nil
}

// copyBakedProject replaces projectDir's node_modules and package-lock.json with the baked ones.
func copyBakedProject(baked, projectDir string) error {
	dst := filepath.Join(projectDir, "node_modules")
	if err := os.RemoveAll(dst); err != nil {
		return err
	}
	if err := copyTree(filepath.Join(baked, "node_modules"), dst); err != nil {
		return err
	}
	return copyFile(filepath.Join(baked, "package-lock.json"), filepath.Join(projectDir, "package-lock.json"), 0o600)
}

// copyTree copies a directory of regular files, directories and symlinks (node_modules/.bin).
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o700)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			return copyFile(path, target, info.Mode().Perm()|0o600)
		default:
			return fmt.Errorf("copy %s: unsupported file type %v", path, d.Type())
		}
	})
}

func copyFile(src, dst string, perm fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// pluginDirName matches a plugin directory in Pulumi's plugin cache: <kind>-<name>-v<version>.
var pluginDirName = regexp.MustCompile(`^(resource|language|analyzer|converter|tool)-[a-zA-Z0-9][a-zA-Z0-9-_.]*-v[0-9]+\.[0-9]+\.[0-9]+$`)

// linkBakedPlugins makes each baked plugin an installed plugin in Pulumi's plugin cache, so Pulumi
// downloads none of them. The cache stays writable (Pulumi installs other versions there): each
// plugin gets a real directory whose files are symlinks into the read-only baked copy. Pulumi
// lists only real directories, and skips one with a <dir>.partial marker, which is held while the
// links are made, so an interrupted link is redone instead of used. Plugins already in the cache
// are left alone.
func linkBakedPlugins(baked, cache string) ([]string, error) {
	entries, err := os.ReadDir(baked)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var linked []string
	for _, e := range entries {
		if !e.IsDir() || !pluginDirName.MatchString(e.Name()) {
			continue
		}
		files, err := os.ReadDir(filepath.Join(baked, e.Name()))
		if err != nil {
			return linked, err
		}
		dir := filepath.Join(cache, e.Name())
		partial := dir + ".partial"
		if pluginInstalled(dir, files) {
			continue
		}
		if err := os.MkdirAll(cache, 0o755); err != nil {
			return linked, err
		}
		if err := os.WriteFile(partial, nil, 0o600); err != nil {
			return linked, err
		}
		if err := os.RemoveAll(dir); err != nil {
			return linked, err
		}
		if err := os.Mkdir(dir, 0o755); err != nil {
			return linked, err
		}
		for _, f := range files {
			if err := os.Symlink(filepath.Join(baked, e.Name(), f.Name()), filepath.Join(dir, f.Name())); err != nil {
				return linked, err
			}
		}
		if err := os.Remove(partial); err != nil {
			return linked, err
		}
		linked = append(linked, e.Name())
	}
	return linked, nil
}

// pluginInstalled reports whether the cache holds the plugin at dir, complete (no .partial
// marker) and with every baked file resolvable (no link left dangling by an older image).
func pluginInstalled(dir string, files []fs.DirEntry) bool {
	if _, err := os.Stat(dir + ".partial"); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() {
		return false
	}
	for _, f := range files {
		if _, err := os.Stat(filepath.Join(dir, f.Name())); err != nil {
			return false
		}
	}
	return true
}
