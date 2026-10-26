package vcluster

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"

	"helm.sh/helm/v3/pkg/action"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/storage/driver"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// Helm runs Helm actions against the operator's own cluster.
type Helm struct {
	Config *rest.Config
	Log    *slog.Logger
}

var _ Releaser = (*Helm)(nil)

func (h *Helm) configuration(namespace string) (*action.Configuration, error) {
	cfg := new(action.Configuration)
	getter := &restGetter{config: h.Config, namespace: namespace}
	logf := func(format string, args ...any) {
		if h.Log != nil {
			h.Log.Debug(fmt.Sprintf(format, args...), "namespace", namespace)
		}
	}
	if err := cfg.Init(getter, namespace, "secret", logf); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Get returns the release named name in namespace, or nil when there is none.
func (h *Helm) Get(_ context.Context, namespace, name string) (*Release, error) {
	cfg, err := h.configuration(namespace)
	if err != nil {
		return nil, err
	}
	rel, err := action.NewGet(cfg).Run(name)
	if errors.Is(err, driver.ErrReleaseNotFound) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	out := &Release{}
	if rel.Info != nil {
		out.Status, out.Description = rel.Info.Status.String(), rel.Info.Description
	}
	return out, nil
}

// Install installs chart as name in namespace without waiting; Ensure polls readiness. The
// namespace must exist: Ensure creates it with its owner annotation.
func (h *Helm) Install(ctx context.Context, namespace, name string, chart []byte, values map[string]any) error {
	cfg, err := h.configuration(namespace)
	if err != nil {
		return err
	}
	ch, err := loader.LoadArchive(bytes.NewReader(chart))
	if err != nil {
		return fmt.Errorf("load chart: %w", err)
	}
	install := action.NewInstall(cfg)
	install.ReleaseName = name
	install.Namespace = namespace
	_, err = install.RunWithContext(ctx, ch, values)
	return err
}

// releaseHistory caps the revisions an Upgrade keeps, so repeated repairs don't pile up release
// Secrets.
const releaseHistory = 5

// Upgrade re-applies chart to the release with the values it was installed with. Helm's
// three-way merge creates objects missing from the cluster and leaves unchanged ones alone.
func (h *Helm) Upgrade(ctx context.Context, namespace, name string, chart []byte) error {
	cfg, err := h.configuration(namespace)
	if err != nil {
		return err
	}
	ch, err := loader.LoadArchive(bytes.NewReader(chart))
	if err != nil {
		return fmt.Errorf("load chart: %w", err)
	}
	upgrade := action.NewUpgrade(cfg)
	upgrade.Namespace = namespace
	upgrade.ReuseValues = true
	upgrade.MaxHistory = releaseHistory
	_, err = upgrade.RunWithContext(ctx, name, ch, nil)
	return err
}

// Uninstall removes the release; a missing release is not an error.
func (h *Helm) Uninstall(_ context.Context, namespace, name string) error {
	cfg, err := h.configuration(namespace)
	if err != nil {
		return err
	}
	uninstall := action.NewUninstall(cfg)
	uninstall.IgnoreNotFound = true
	_, err = uninstall.Run(name)
	return err
}

// restGetter is a genericclioptions.RESTClientGetter over a rest.Config.
type restGetter struct {
	config    *rest.Config
	namespace string
}

func (g *restGetter) ToRESTConfig() (*rest.Config, error) { return rest.CopyConfig(g.config), nil }

func (g *restGetter) ToDiscoveryClient() (discovery.CachedDiscoveryInterface, error) {
	dc, err := discovery.NewDiscoveryClientForConfig(g.config)
	if err != nil {
		return nil, err
	}
	return memory.NewMemCacheClient(dc), nil
}

func (g *restGetter) ToRESTMapper() (meta.RESTMapper, error) {
	dc, err := g.ToDiscoveryClient()
	if err != nil {
		return nil, err
	}
	return restmapper.NewDeferredDiscoveryRESTMapper(dc), nil
}

func (g *restGetter) ToRawKubeConfigLoader() clientcmd.ClientConfig {
	return clientcmd.NewDefaultClientConfig(*clientcmdapi.NewConfig(), &clientcmd.ConfigOverrides{
		Context: clientcmdapi.Context{Namespace: g.namespace},
	})
}
