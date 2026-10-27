// Package targets provisions the cluster a PlatformInstance runs in. A target only has to yield
// an admin kubeconfig; the installer does the rest.
package targets

import (
	"context"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// State is a target's readiness this round.
type State struct {
	// Ready is true once the target cluster answers and Kubeconfig is set.
	Ready bool
	// Kubeconfig is the target's admin kubeconfig, addressed for use from inside the operator's
	// cluster.
	Kubeconfig []byte
	// Server is the API server URL in Kubeconfig.
	Server string
	// Reason is a short CamelCase reason when not Ready.
	Reason string
	// Message is a readable detail when not Ready.
	Message string
	// ServiceUID identifies the target's API Service when Ready. The controller records it in
	// status.target.serviceUID once the platform is installed on it.
	ServiceUID string
	// ResyncStarted is set when the target restarted its control plane to resync it; the
	// controller records it in status.target.resyncServiceUID.
	ResyncStarted string
	// Resynced is true when Ready after a resync: the controller then runs a full install with
	// a refresh, so the platform's objects lost before the resync are created again.
	Resynced bool
}

// Target creates, reports and deletes one instance's cluster.
type Target interface {
	// Ensure creates the cluster if it doesn't exist and reports whether it is ready.
	Ensure(ctx context.Context, inst *v1alpha1.PlatformInstance) (State, error)
	// Delete removes the cluster and its data. It returns done once nothing is left.
	Delete(ctx context.Context, inst *v1alpha1.PlatformInstance) (done bool, err error)
}
