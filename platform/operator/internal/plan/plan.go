// Package plan decides the next reconcile step for a PlatformInstance from what the controller
// observed. It has no I/O, so every decision is unit-testable.
package plan

import (
	"time"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

// Action is the one step the controller takes next.
type Action string

const (
	// AddFinalizer registers the finalizer before anything is created, so a delete can't orphan
	// the target.
	AddFinalizer Action = "AddFinalizer"
	// EnsureTarget creates the target cluster, or waits for it to answer with a kubeconfig.
	EnsureTarget Action = "EnsureTarget"
	// Install runs the installer for spec.version and settings.
	Install Action = "Install"
	// Repair runs the periodic refresh and up that repairs drift.
	Repair Action = "Repair"
	// Uninstall removes the platform and the target cluster (DeletionPolicy Delete).
	Uninstall Action = "Uninstall"
	// Release removes the finalizer and leaves the target cluster, its data and the install state
	// in place (DeletionPolicy Retain, or after Uninstall finished).
	Release Action = "Release"
	// Wait does nothing now and checks again after RequeueAfter.
	Wait Action = "Wait"
)

// Observation is what the controller saw this round.
type Observation struct {
	Deleting     bool
	HasFinalizer bool
	Policy       v1alpha1.DeletionPolicy

	// UninstallDone is true once Uninstall has removed the platform and the target.
	UninstallDone bool

	// TargetReady is true when the target answered with a kubeconfig this round.
	TargetReady bool

	// Generation is metadata.generation; InstalledGeneration is the generation the last
	// successful install applied (status.observedGeneration while Installed is True).
	Generation          int64
	InstalledGeneration int64
	DesiredVersion      string
	InstalledVersion    string
	Installed           bool
	// InstallAttempted is true once an install has run, whether or not it succeeded (the
	// Installed condition is present).
	InstallAttempted bool

	// LastRepair is when the last install or repair finished; zero if never.
	LastRepair time.Time
	Now        time.Time
}

// Config tunes the timing of decisions.
type Config struct {
	// RepairInterval is how long a Ready instance goes without a refresh and up.
	RepairInterval time.Duration
	// TargetPoll is how soon to look again while the target comes up.
	TargetPoll time.Duration
}

// ReasonRetry is the Install reason after a failed install, first or later. The controller
// refreshes before retrying: the failed run (or a timeout) may have created resources.
const ReasonRetry = "Retry"

// Decision is the next action and, for Wait, when to look again.
type Decision struct {
	Action       Action
	RequeueAfter time.Duration
	// Reason is a short CamelCase reason for status conditions and logs.
	Reason string
}

// Next returns the next step. Deletion wins over everything; otherwise the instance moves
// target, then install, then periodic repair.
func Next(o Observation, c Config) Decision {
	if o.Deleting {
		switch {
		case !o.HasFinalizer:
			return Decision{Action: Wait, Reason: "Deleted"}
		case policy(o.Policy) == v1alpha1.DeletionRetain:
			return Decision{Action: Release, Reason: "Retained"}
		case o.UninstallDone:
			return Decision{Action: Release, Reason: "Uninstalled"}
		default:
			return Decision{Action: Uninstall, Reason: "Deleting"}
		}
	}
	if !o.HasFinalizer {
		return Decision{Action: AddFinalizer, Reason: "Registering"}
	}
	if !o.TargetReady {
		return Decision{Action: EnsureTarget, RequeueAfter: c.TargetPoll, Reason: "TargetPending"}
	}
	if !o.Installed || o.InstalledGeneration != o.Generation || o.InstalledVersion != o.DesiredVersion {
		return Decision{Action: Install, Reason: installReason(o)}
	}
	if due := o.LastRepair.Add(c.RepairInterval); o.LastRepair.IsZero() || !o.Now.Before(due) {
		return Decision{Action: Repair, Reason: "RepairDue"}
	}
	return Decision{Action: Wait, RequeueAfter: o.LastRepair.Add(c.RepairInterval).Sub(o.Now), Reason: "Ready"}
}

func installReason(o Observation) string {
	switch {
	case !o.Installed && o.InstalledVersion == "" && !o.InstallAttempted:
		return "FirstInstall"
	case !o.Installed:
		return ReasonRetry
	case o.InstalledVersion != o.DesiredVersion:
		return "VersionChanged"
	default: // Next only installs when something differs; here it is the generation.
		return "SpecChanged"
	}
}

// policy applies the API default for an unset deletionPolicy.
func policy(p v1alpha1.DeletionPolicy) v1alpha1.DeletionPolicy {
	if p == "" {
		return v1alpha1.DeletionDelete
	}
	return p
}
