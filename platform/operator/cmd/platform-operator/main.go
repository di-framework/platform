// Command platform-operator reconciles PlatformInstances into running platform instances.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/controller"
	"github.com/di-framework/platform/operator/internal/installer"
	"github.com/di-framework/platform/operator/internal/plan"
	"github.com/di-framework/platform/operator/internal/target/vcluster"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "platform-operator:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		stateDir        = flag.String("state-dir", "/var/lib/platform-operator", "directory (the operator's PVC) for per-instance install projects and state")
		passphraseFile  = flag.String("passphrase-file", "/etc/platform-operator/passphrase", "file holding the passphrase that encrypts install state secrets")
		storageRootBase = flag.String("storage-root-base", "/var/lib/kubesolo/instances", "node directory under which each instance gets its own storageRoot")
		repairInterval  = flag.Duration("repair-interval", 30*time.Minute, "how often a ready instance gets a refresh and up to repair drift")
		targetPoll      = flag.Duration("target-poll", 10*time.Second, "how often to check a target that is still coming up")
		concurrency     = flag.Int("max-concurrent-installs", 2, "instances reconciled in parallel")
		leaderElect     = flag.Bool("leader-elect", true, "run one active operator through a Lease")
		metricsAddr     = flag.String("metrics-bind-address", ":8080", "metrics endpoint")
		probeAddr       = flag.String("health-probe-bind-address", ":8081", "health and readiness endpoints")
	)
	opts := zap.Options{}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	passphrase, err := os.ReadFile(*passphraseFile)
	if err != nil {
		return fmt.Errorf("read passphrase: %w", err)
	}
	if strings.TrimSpace(string(passphrase)) == "" {
		return errors.New("passphrase file is empty")
	}

	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{clientgoscheme.AddToScheme, v1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			return err
		}
	}
	cfg := ctrl.GetConfigOrDie()
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: *metricsAddr},
		HealthProbeBindAddress: *probeAddr,
		LeaderElection:         *leaderElect,
		LeaderElectionID:       "platform-operator.platform.di-framework.dev",
	})
	if err != nil {
		return err
	}
	if _, err := vcluster.Chart(); err != nil {
		return err
	}
	r := &controller.Reconciler{
		Client: mgr.GetClient(),
		Target: &vcluster.Target{
			Client: mgr.GetClient(),
			Helm:   &vcluster.Helm{Config: cfg, Log: slog.Default()},
		},
		Installer: &installer.Pulumi{
			StateDir:   *stateDir,
			Passphrase: strings.TrimSpace(string(passphrase)),
			Log:        os.Stderr,
		},
		Plan:            plan.Config{RepairInterval: *repairInterval, TargetPoll: *targetPoll},
		StorageRootBase: *storageRootBase,
		MaxConcurrent:   *concurrency,
	}
	if err := r.SetupWithManager(mgr); err != nil {
		return err
	}
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return err
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return err
	}
	return mgr.Start(ctrl.SetupSignalHandler())
}
