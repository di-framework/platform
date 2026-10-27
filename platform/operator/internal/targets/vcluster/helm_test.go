package vcluster

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/go-logr/logr/funcr"
	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chartutil"
	kubefake "helm.sh/helm/v3/pkg/kube/fake"
	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/storage"
	"helm.sh/helm/v3/pkg/storage/driver"

	"github.com/di-framework/platform/operator/internal/logging"
)

// memoryHelm is a Helm whose releases live in memory and whose cluster writes go nowhere.
func memoryHelm(t *testing.T) (*Helm, *action.Configuration) {
	t.Helper()
	cfg := &action.Configuration{
		Releases:     storage.Init(driver.NewMemory()),
		KubeClient:   &kubefake.PrintingKubeClient{Out: io.Discard},
		Capabilities: chartutil.DefaultCapabilities,
		Log:          func(string, ...any) {},
	}
	return &Helm{configure: func(string) (*action.Configuration, error) { return cfg, nil }}, cfg
}

// installedChart stands in for the chart a release was installed with, older than the embedded one.
var installedChart = &chart.Chart{
	Metadata: &chart.Metadata{APIVersion: "v2", Name: "vcluster", Version: "0.0.1-installed"},
	Templates: []*chart.File{{Name: "templates/svc.yaml", Data: []byte(
		"apiVersion: v1\nkind: Service\nmetadata: {name: vcluster, labels: {marker: \"{{ .Values.marker }}\"}}\nspec: {ports: [{port: 443}]}\n")}},
}

func seed(t *testing.T, cfg *action.Configuration, version int, status release.Status) {
	t.Helper()
	rel := &release.Release{
		Name: ReleaseName, Namespace: "pi-x", Version: version, Chart: installedChart,
		Config: map[string]any{"marker": "installed"},
		Info:   &release.Info{Status: status, Description: "seeded"},
	}
	if err := cfg.Releases.Create(rel); err != nil {
		t.Fatal(err)
	}
}

// Repair re-applies the stored release's own chart and values, so a repair after the operator's
// embedded chart moved on is not an upgrade.
func TestHelmRepairReappliesTheStoredRelease(t *testing.T) {
	h, cfg := memoryHelm(t)
	seed(t, cfg, 1, release.StatusDeployed)
	if err := h.Repair(context.Background(), "pi-x", ReleaseName); err != nil {
		t.Fatal(err)
	}
	last, err := cfg.Releases.Last(ReleaseName)
	if err != nil {
		t.Fatal(err)
	}
	if last.Version != 2 || last.Info.Status != release.StatusDeployed || last.Chart.Metadata.Version != "0.0.1-installed" ||
		last.Config["marker"] != "installed" || !strings.Contains(last.Manifest, "marker: \"installed\"") {
		t.Fatalf("repaired release: v%d %s chart %s config %v\n%s", last.Version, last.Info.Status, last.Chart.Metadata.Version, last.Config, last.Manifest)
	}
	if got, err := h.Get(context.Background(), "pi-x", ReleaseName); err != nil || got.Revision != 2 || got.Status != "deployed" {
		t.Fatalf("Get after repair: %+v %v", got, err)
	}
	if err := h.Repair(context.Background(), "pi-x", "missing"); err == nil {
		t.Fatal("repair of a missing release succeeded")
	}
}

func TestHelmRollbackGoesToTheLastDeployedRevision(t *testing.T) {
	h, cfg := memoryHelm(t)
	// A failed upgrade leaves the revision before it deployed; the one before the latest is
	// superseded here, so "the previous revision" would be the wrong target (review S7).
	seed(t, cfg, 1, release.StatusSuperseded)
	seed(t, cfg, 2, release.StatusDeployed)
	seed(t, cfg, 3, release.StatusSuperseded)
	seed(t, cfg, 4, release.StatusFailed)
	rev, err := h.Rollback(context.Background(), "pi-x", ReleaseName)
	if err != nil || rev != 2 {
		t.Fatalf("rollback: %d %v", rev, err)
	}
	last, err := cfg.Releases.Last(ReleaseName)
	if err != nil || last.Version != 5 || last.Info.Status != release.StatusDeployed || last.Chart.Metadata.Version != "0.0.1-installed" {
		t.Fatalf("after rollback: %+v %v", last, err)
	}

	// Without a deployed revision, the latest superseded one.
	h, cfg = memoryHelm(t)
	seed(t, cfg, 1, release.StatusSuperseded)
	seed(t, cfg, 2, release.StatusSuperseded)
	seed(t, cfg, 3, release.StatusFailed)
	if rev, err := h.Rollback(context.Background(), "pi-x", ReleaseName); err != nil || rev != 2 {
		t.Fatalf("rollback to superseded: %d %v", rev, err)
	}

	h, cfg = memoryHelm(t)
	seed(t, cfg, 1, release.StatusFailed)
	seed(t, cfg, 2, release.StatusPendingUpgrade)
	if _, err := h.Rollback(context.Background(), "pi-x", ReleaseName); err == nil || !strings.Contains(err.Error(), "no deployed revision before 2") {
		t.Fatalf("rollback without a deployed revision: %v", err)
	}
	if _, err := h.Rollback(context.Background(), "pi-x", "missing"); err == nil {
		t.Fatal("rollback of a missing release succeeded")
	}
}

// Helm's action lines go through the Helm wrapper's slog logger at Info, so with slog bridged
// into the operator's logr logger they reach the pod log at its default verbosity (#473).
func TestHelmLogReachesTheBridgedLogger(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	var lines []string
	logging.BridgeSlog(funcr.New(func(_, args string) { lines = append(lines, args) }, funcr.Options{}))

	h, cfg := memoryHelm(t)
	h.Log = slog.Default()
	cfg.Log = h.logf("pi-x")
	h.logf("pi-x")("performing update for %s", ReleaseName)
	seed(t, cfg, 1, release.StatusDeployed)
	if err := h.Repair(context.Background(), "pi-x", ReleaseName); err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{
		`"msg"="performing update for vcluster" "namespace"="pi-x"`,
		`"msg"="preparing upgrade for vcluster" "namespace"="pi-x"`,
	} {
		found := false
		for _, l := range lines {
			found = found || strings.Contains(l, want)
		}
		if !found {
			t.Errorf("no line contains %q in %q", want, lines)
		}
	}
}
