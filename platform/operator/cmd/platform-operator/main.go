// Command platform-operator reconciles PlatformInstances into running platform instances.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	authenticationv1 "k8s.io/api/authentication/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/controller"
	"github.com/di-framework/platform/operator/internal/installer"
	"github.com/di-framework/platform/operator/internal/plan"
	"github.com/di-framework/platform/operator/internal/targets/vcluster"
)

// serviceAccountNamespace holds the namespace of an in-cluster pod.
const serviceAccountNamespace = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"

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
		npm             = flag.String("npm", installer.DefaultNPM, "absolute path of npm")
		storageRootBase = flag.String("storage-root-base", "/var/lib/kubesolo/instances", "node directory under which each instance gets its own storageRoot")
		cleanupNS       = flag.String("cleanup-namespace", "", "namespace for the Jobs that remove a deleted instance's default storageRoot (default: the operator's own namespace)")
		repairInterval  = flag.Duration("repair-interval", 30*time.Minute, "how often a ready instance gets a refresh and up to repair drift")
		targetPoll      = flag.Duration("target-poll", 10*time.Second, "how often to check a target that is still coming up")
		installTimeout  = flag.Duration("install-timeout", 30*time.Minute, "longest one install or repair may run before it is cancelled and retried")
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

	// Every default storageRoot sits under the base, so a bad one fails here, not at the first Delete.
	if err := controller.CheckStorageBase(*storageRootBase); err != nil {
		return fmt.Errorf("--storage-root-base: %w", err)
	}
	// The operator's own namespace, which every instance host namespace admits to the vCluster
	// API. Outside a cluster there is no service account, so it falls back to --cleanup-namespace.
	operatorNS := ""
	if ns, err := os.ReadFile(serviceAccountNamespace); err == nil {
		operatorNS = strings.TrimSpace(string(ns))
	}
	if *cleanupNS == "" {
		if operatorNS == "" {
			return errors.New("--cleanup-namespace is unset and the operator's namespace is unknown")
		}
		*cleanupNS = operatorNS
	}
	if operatorNS == "" {
		operatorNS = *cleanupNS
	}

	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{clientgoscheme.AddToScheme, v1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			return err
		}
	}
	cfg := ctrl.GetConfigOrDie()
	// The admission policy that protects service/vcluster (#466) lets the operator's own user
	// delete it; ask the API server who that is.
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return err
	}
	reviewCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	review, err := clientset.AuthenticationV1().SelfSubjectReviews().Create(reviewCtx, &authenticationv1.SelfSubjectReview{}, metav1.CreateOptions{})
	cancel()
	if err != nil {
		return fmt.Errorf("look up the operator's username: %w", err)
	}
	operatorUser := review.Status.UserInfo.Username
	slog.Info("operator user, allowed to delete service/vcluster", "username", operatorUser)
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: *metricsAddr},
		HealthProbeBindAddress: *probeAddr,
		LeaderElection:         *leaderElect,
		LeaderElectionID:       "platform-operator.platform.di-framework.dev",
		// The watch on owned Secrets sees only the operator's kubeconfig Secrets, and Secret and
		// Service reads (vCluster's kubeconfig, the host DNS Service) go to the API server, so
		// the operator never caches the cluster's other Secrets, Helm releases among them.
		// Namespace reads go there too, so the host namespace owner check never sees a stale copy,
		// and so do the storage cleanup Job reads, which the operator polls instead of watching,
		// and the host-namespace NetworkPolicy reads, so the cache never holds every policy.
		Cache: cache.Options{ByObject: map[client.Object]cache.ByObject{
			&corev1.Secret{}: {Label: labels.SelectorFromSet(controller.ManagedLabels)},
		}},
		Client: client.Options{Cache: &client.CacheOptions{DisableFor: []client.Object{&corev1.Secret{}, &corev1.Service{}, &corev1.Namespace{}, &batchv1.Job{}, &corev1.Pod{}, &networkingv1.NetworkPolicy{},
			&admissionregistrationv1.ValidatingAdmissionPolicy{}, &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}}}},
	})
	if err != nil {
		return err
	}
	if _, err := vcluster.Chart(); err != nil {
		return err
	}
	r := &controller.Reconciler{
		Client:    mgr.GetClient(),
		APIReader: mgr.GetAPIReader(),
		Target: &vcluster.Target{
			Client:            mgr.GetClient(),
			Helm:              &vcluster.Helm{Config: cfg, Log: slog.Default()},
			OperatorNamespace: operatorNS,
			OperatorUsername:  operatorUser,
			// A resync waiting longer than three repair intervals is reported unreachable.
			ResyncTimeout: 3 * *repairInterval,
		},
		Recorder: mgr.GetEventRecorder("platform-operator"),
		Installer: &installer.Pulumi{
			StateDir:   *stateDir,
			Passphrase: strings.TrimSpace(string(passphrase)),
			Log:        os.Stderr,
			NPM:        *npm,
		},
		Plan:             plan.Config{RepairInterval: *repairInterval, TargetPoll: *targetPoll},
		StorageRootBase:  *storageRootBase,
		CleanupNamespace: *cleanupNS,
		MaxConcurrent:    *concurrency,
		InstallTimeout:   *installTimeout,
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
