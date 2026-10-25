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
}

// Target creates, reports and deletes one instance's cluster.
type Target interface {
	// Ensure creates the cluster if it doesn't exist and reports whether it is ready.
	Ensure(ctx context.Context, inst *v1alpha1.PlatformInstance) (State, error)
	// Delete removes the cluster and its data. It returns done once nothing is left.
	Delete(ctx context.Context, inst *v1alpha1.PlatformInstance) (done bool, err error)
}
