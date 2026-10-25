package plan

import (
	"testing"
	"time"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

var (
	now = time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	cfg = Config{RepairInterval: 30 * time.Minute, TargetPoll: 10 * time.Second}
)

// ready is an installed, repaired instance at generation 3, version 6.0.17.
func ready() Observation {
	return Observation{
		HasFinalizer: true, TargetReady: true,
		Generation: 3, InstalledGeneration: 3,
		DesiredVersion: "6.0.17", InstalledVersion: "6.0.17", Installed: true,
		LastRepair: now.Add(-10 * time.Minute), Now: now,
	}
}

func TestNext(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Observation)
		want   Action
		reason string
		after  time.Duration
	}{
		{"new instance registers its finalizer first", func(o *Observation) { *o = Observation{Now: now} }, AddFinalizer, "Registering", 0},
		{"target not answering yet", func(o *Observation) { o.TargetReady = false }, EnsureTarget, "TargetPending", 10 * time.Second},
		{"first install", func(o *Observation) {
			o.Installed, o.InstalledVersion, o.InstalledGeneration, o.LastRepair = false, "", 0, time.Time{}
		}, Install, "FirstInstall", 0},
		{"version bump upgrades in place", func(o *Observation) { o.DesiredVersion, o.Generation = "6.0.18", 4 }, Install, "VersionChanged", 0},
		{"settings change reinstalls", func(o *Observation) { o.Generation = 4 }, Install, "SpecChanged", 0},
		{"failed install is retried", func(o *Observation) { o.Installed = false }, Install, ReasonRetry, 0},
		{"failed first install is retried", func(o *Observation) {
			o.Installed, o.InstalledVersion, o.InstallAttempted = false, "", true
		}, Install, ReasonRetry, 0},
		{"ready and recently repaired waits for the next repair", func(o *Observation) {}, Wait, "Ready", 20 * time.Minute},
		{"repair is due", func(o *Observation) { o.LastRepair = now.Add(-30 * time.Minute) }, Repair, "RepairDue", 0},
		{"never repaired", func(o *Observation) { o.LastRepair = time.Time{} }, Repair, "RepairDue", 0},
		{"target loss outranks repair", func(o *Observation) { o.TargetReady, o.LastRepair = false, time.Time{} }, EnsureTarget, "TargetPending", 10 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := ready()
			tt.mutate(&o)
			got := Next(o, cfg)
			if got.Action != tt.want || got.Reason != tt.reason || got.RequeueAfter != tt.after {
				t.Fatalf("Next() = %+v, want action %s reason %s after %s", got, tt.want, tt.reason, tt.after)
			}
		})
	}
}

func TestDeletionPolicy(t *testing.T) {
	tests := []struct {
		name          string
		policy        v1alpha1.DeletionPolicy
		finalizer     bool
		uninstallDone bool
		mutate        func(*Observation)
		want          Action
		reason        string
		after         time.Duration
	}{
		{"unset policy defaults to Delete", "", true, false, nil, Uninstall, "Deleting", 0},
		{"Delete uninstalls first", v1alpha1.DeletionDelete, true, false, nil, Uninstall, "Deleting", 0},
		{"Delete cleans the default storageRoot once uninstalled", v1alpha1.DeletionDelete, true, true, nil, CleanStorage, "CleaningStorage", 10 * time.Second},
		{"unset policy cleans storage too", "", true, true, nil, CleanStorage, "CleaningStorage", 10 * time.Second},
		{"storage cleanup waits for the uninstall", v1alpha1.DeletionDelete, true, false, func(o *Observation) { o.StorageCleaned = true }, Uninstall, "Deleting", 0},
		{"Delete releases once storage is cleaned", v1alpha1.DeletionDelete, true, true, func(o *Observation) { o.StorageCleaned = true }, Release, "Uninstalled", 0},
		{"a custom storageRoot is never cleaned", v1alpha1.DeletionDelete, true, true, func(o *Observation) { o.CustomStorageRoot = true }, Release, "CustomStorageKept", 0},
		{"the skip annotation releases without cleaning", v1alpha1.DeletionDelete, true, true, func(o *Observation) { o.SkipStorageCleanup = true }, Release, "StorageCleanupSkipped", 0},
		{"Retain never uninstalls", v1alpha1.DeletionRetain, true, false, nil, Release, "Retained", 0},
		{"Retain never cleans storage", v1alpha1.DeletionRetain, true, true, nil, Release, "Retained", 0},
		{"already released", v1alpha1.DeletionDelete, false, true, nil, Wait, "Deleted", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := ready()
			o.Deleting, o.Policy, o.HasFinalizer, o.UninstallDone = true, tt.policy, tt.finalizer, tt.uninstallDone
			// Deletion wins even while the target is down or an upgrade is pending.
			o.TargetReady, o.DesiredVersion = false, "6.0.18"
			if tt.mutate != nil {
				tt.mutate(&o)
			}
			got := Next(o, cfg)
			if got.Action != tt.want || got.Reason != tt.reason || got.RequeueAfter != tt.after {
				t.Fatalf("Next() = %+v, want %s/%s after %s", got, tt.want, tt.reason, tt.after)
			}
		})
	}
}
