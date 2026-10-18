// Package installer installs the platform package into a target cluster. The interface leaves
// room for a server-side-apply implementation later; v1 runs the platform's existing Pulumi
// program (@di-framework/platform/existing) through the Pulumi Automation API.
package installer

import (
	"context"
	"errors"
)

// Request is one instance's install input.
type Request struct {
	// ID names the instance's install state: unique per PlatformInstance, stable across restarts
	// (namespace and name).
	ID string
	// Version is the exact @di-framework/platform version.
	Version string
	// Kubeconfig is the target cluster's admin kubeconfig.
	Kubeconfig []byte
	// Settings are the platform's existing-entrypoint config keys (networkPolicyEngine,
	// storageRoot, httpNodePort, namespace, ...), already defaulted by the caller.
	Settings map[string]any
}

// Result is what a finished install reports.
type Result struct {
	KubernetesEndpoint string
	HTTPEndpoint       string
}

// Options change how Install runs.
type Options struct {
	// Refresh reads the live cluster into the state before the up, so the up repairs drift
	// (hand-deleted or edited resources). The periodic repair sets it.
	Refresh bool
}

// State is the installer's view of an instance without running an update.
type State struct {
	// Exists is true when install state is present.
	Exists bool
	Result Result
}

// UninstallOptions change how Uninstall runs.
type UninstallOptions struct {
	// Destroy deletes the platform's resources from the target before dropping the install
	// state. Targets that are deleted wholesale (a vCluster and its namespace) don't need it, and
	// skipping it lets a broken or unreachable instance still be deleted.
	Destroy bool
}

// Installer installs, reports and removes one platform install per Request.ID. Callers run at
// most one operation per ID at a time; implementations may rely on that.
type Installer interface {
	Install(ctx context.Context, req Request, opts Options) (Result, error)
	Status(ctx context.Context, req Request) (State, error)
	Uninstall(ctx context.Context, req Request, opts UninstallOptions) error
}

// ErrInvalidRequest marks a Request the installer refuses without touching any state.
var ErrInvalidRequest = errors.New("invalid install request")
