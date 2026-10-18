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

// Exists reports whether a deployed (or failed) release named name exists in namespace.
func (h *Helm) Exists(_ context.Context, namespace, name string) (bool, error) {
	cfg, err := h.configuration(namespace)
	if err != nil {
		return false, err
	}
	if _, err := action.NewGet(cfg).Run(name); errors.Is(err, driver.ErrReleaseNotFound) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return true, nil
}

// Install installs chart as name in namespace without waiting; Ensure polls readiness.
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
	install.CreateNamespace = true
	_, err = install.RunWithContext(ctx, ch, values)
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
