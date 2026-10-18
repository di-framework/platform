// Package vcluster is the vCluster target: one vCluster per PlatformInstance, in its own host
// namespace, installed from the operator's embedded, digest-pinned chart.
package vcluster

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/clientcmd"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets"
)

// ChartVersion is the embedded vCluster chart's version.
const ChartVersion = "0.37.3"

// chartSHA256 is the embedded archive's digest, as published in charts.loft.sh's index.yaml.
const chartSHA256 = "96ac5c5fb841c8708991b04382b81971405788378f7dbc413ec2fdb67f1d95dc"

//go:embed chart/vcluster-0.37.3.tgz
var chartArchive []byte

// ReleaseName is the Helm release in each instance's host namespace. vCluster names its
// StatefulSet and Service after it and its kubeconfig Secret "vc-<release>".
const ReleaseName = "vcluster"

// Chart returns the embedded chart archive after checking its digest.
func Chart() ([]byte, error) {
	sum := sha256.Sum256(chartArchive)
	if got := hex.EncodeToString(sum[:]); got != chartSHA256 {
		return nil, fmt.Errorf("embedded vcluster chart digest %s, want %s", got, chartSHA256)
	}
	return chartArchive, nil
}

// Releaser is the Helm surface the target uses.
type Releaser interface {
	// Exists reports whether the release is installed in namespace.
	Exists(ctx context.Context, namespace, name string) (bool, error)
	// Install installs the chart archive as name in namespace, creating the namespace.
	Install(ctx context.Context, namespace, name string, chart []byte, values map[string]any) error
	// Uninstall removes the release; a missing release is not an error.
	Uninstall(ctx context.Context, namespace, name string) error
}

// Target provisions vClusters on the operator's own cluster.
type Target struct {
	// Client reads and deletes objects in the host cluster.
	Client client.Client
	Helm   Releaser
	// HostDNS is the host cluster's DNS Service, which instance CoreDNS forwards to. Empty uses
	// kube-system/kube-dns.
	HostDNS types.NamespacedName
	// Values renders the chart values for an instance; nil uses InstanceValues with the host
	// DNS Service's ClusterIP.
	Values func(ctx context.Context, inst *v1alpha1.PlatformInstance) (map[string]any, error)
}

var _ targets.Target = (*Target)(nil)

// Ensure installs the vCluster once and reports it ready when its control plane is ready and
// its kubeconfig Secret exists. Values are applied at creation only (see InstanceValues).
func (t *Target) Ensure(ctx context.Context, inst *v1alpha1.PlatformInstance) (targets.State, error) {
	ns := HostNamespace(inst)
	exists, err := t.Helm.Exists(ctx, ns, ReleaseName)
	if err != nil {
		return targets.State{}, fmt.Errorf("look up vcluster release: %w", err)
	}
	if !exists {
		chart, err := Chart()
		if err != nil {
			return targets.State{}, err
		}
		values, err := t.values(ctx, inst)
		if err != nil {
			return targets.State{}, err
		}
		if err := t.Helm.Install(ctx, ns, ReleaseName, chart, values); err != nil {
			return targets.State{}, fmt.Errorf("install vcluster %s: %w", ChartVersion, err)
		}
		return targets.State{Reason: "Creating", Message: fmt.Sprintf("installed vcluster %s in namespace %s", ChartVersion, ns)}, nil
	}

	var sts appsv1.StatefulSet
	if err := t.Client.Get(ctx, types.NamespacedName{Namespace: ns, Name: ReleaseName}, &sts); apierrors.IsNotFound(err) {
		return targets.State{Reason: "ControlPlanePending", Message: "vcluster StatefulSet not created yet"}, nil
	} else if err != nil {
		return targets.State{}, err
	}
	if sts.Status.ReadyReplicas < 1 {
		return targets.State{Reason: "ControlPlanePending", Message: "vcluster control plane not ready"}, nil
	}

	var secret corev1.Secret
	if err := t.Client.Get(ctx, types.NamespacedName{Namespace: ns, Name: "vc-" + ReleaseName}, &secret); apierrors.IsNotFound(err) {
		return targets.State{Reason: "KubeconfigPending", Message: "vcluster kubeconfig Secret not created yet"}, nil
	} else if err != nil {
		return targets.State{}, err
	}
	raw := secret.Data["config"]
	if len(raw) == 0 {
		return targets.State{Reason: "KubeconfigPending", Message: "vcluster kubeconfig Secret has no config key"}, nil
	}
	server := fmt.Sprintf("https://%s.%s.svc:443", ReleaseName, ns)
	kubeconfig, err := withServer(raw, server)
	if err != nil {
		return targets.State{}, fmt.Errorf("vcluster kubeconfig: %w", err)
	}
	return targets.State{Ready: true, Kubeconfig: kubeconfig, Server: server}, nil
}

func (t *Target) values(ctx context.Context, inst *v1alpha1.PlatformInstance) (map[string]any, error) {
	if t.Values != nil {
		return t.Values(ctx, inst)
	}
	key := t.HostDNS
	if key.Name == "" {
		key = types.NamespacedName{Namespace: "kube-system", Name: "kube-dns"}
	}
	var svc corev1.Service
	if err := t.Client.Get(ctx, key, &svc); err != nil {
		return nil, fmt.Errorf("host DNS Service %s: %w", key, err)
	}
	return InstanceValues(svc.Spec.ClusterIP, HostNamespace(inst))
}

// Delete uninstalls the release and deletes the host namespace, which removes the vCluster's
// data volume. Done is true once the namespace is gone.
func (t *Target) Delete(ctx context.Context, inst *v1alpha1.PlatformInstance) (bool, error) {
	ns := HostNamespace(inst)
	var namespace corev1.Namespace
	if err := t.Client.Get(ctx, types.NamespacedName{Name: ns}, &namespace); apierrors.IsNotFound(err) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	if namespace.DeletionTimestamp == nil {
		if err := t.Helm.Uninstall(ctx, ns, ReleaseName); err != nil {
			return false, fmt.Errorf("uninstall vcluster: %w", err)
		}
		if err := t.Client.Delete(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); client.IgnoreNotFound(err) != nil {
			return false, err
		}
	}
	return false, nil
}

// HostNamespace is the instance's host namespace: pi-<namespace>-<name>, or a hashed form when
// that exceeds the 63-character limit.
func HostNamespace(inst *v1alpha1.PlatformInstance) string {
	name := "pi-" + inst.Namespace + "-" + inst.Name
	if len(name) <= 63 {
		return name
	}
	sum := sha256.Sum256([]byte(inst.Namespace + "/" + inst.Name))
	return name[:54] + "-" + hex.EncodeToString(sum[:])[:8]
}

// withServer points every cluster in a kubeconfig at server. vCluster's Secret addresses
// localhost:8443, which only works from inside its own pod.
func withServer(raw []byte, server string) ([]byte, error) {
	cfg, err := clientcmd.Load(raw)
	if err != nil {
		return nil, err
	}
	if len(cfg.Clusters) == 0 {
		return nil, fmt.Errorf("no clusters")
	}
	for _, c := range cfg.Clusters {
		c.Server = server
	}
	out, err := clientcmd.Write(*cfg)
	if err != nil {
		return nil, err
	}
	return bytes.TrimSpace(out), nil
}
