package controller

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/installer"
)

// DefaultTenantHostImage is the tenant host image of an instance whose spec.platform.tenantHostImage
// is empty: the platform's exclusive host variant (patches 0001-0003), which the PGlite
// exclusive-PGDATA workloads need. scripts/pin-artifact.ts moves it with the
// wash-wasi-tls-exclusive pin.
const DefaultTenantHostImage = "ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:6fea016378c3c6313427f2d6df0fed5ca369ab8f5676eb49d99844625312bb80"

// TenantAuthSecretName is the Secret, in the target's platform namespace, that holds the copy of
// spec.platform.tenantAuth.clientSecretRef the install writes (key clientSecret).
const TenantAuthSecretName = "platform-operator-tenant-auth"

// errTenantAuthSecret marks a clientSecretRef that can't be read.
var errTenantAuthSecret = errors.New("tenantAuth client secret unavailable")

// tenantAuthConfig is the platform's tenantAuth config shape.
type tenantAuthConfig struct {
	Image                 string                   `json:"image"`
	Issuer                string                   `json:"issuer"`
	OAuthClient           oauthClientConfig        `json:"oauthClient"`
	IssuerUpstream        string                   `json:"issuerUpstream,omitempty"`
	IssuerUpstreamPodPort int32                    `json:"issuerUpstreamPodPort,omitempty"`
	IssuerIP              string                   `json:"issuerIp,omitempty"`
	ConsolePublicURL      string                   `json:"consolePublicUrl,omitempty"`
	ControllerPublicURL   string                   `json:"controllerPublicUrl,omitempty"`
	Registry              *v1alpha1.TenantRegistry `json:"registry,omitempty"`
}

type oauthClientConfig struct {
	ID         string `json:"id"`
	SecretName string `json:"secretName"`
}

// tenancyUnset are the optional config keys the operator owns: dropped from the spec, they are
// removed from the install state.
var tenancyUnset = []string{"tenantAuth", installer.TenantAuthClientSecretKey, "tenantHostImage", "tenantHostImagePullPolicy"}

// tenantHostImage is the image an install of inst applies, empty for the platform's own default:
// the spec's; else the one the last install recorded; else, for an instance installed before the
// operator recorded it, the platform default it was installed with; else (a new instance) the
// operator's DefaultTenantHostImage, with fromDefault set.
func tenantHostImage(inst *v1alpha1.PlatformInstance) (image string, fromDefault bool) {
	switch {
	case inst.Spec.Platform.TenantHostImage != "":
		return inst.Spec.Platform.TenantHostImage, false
	case inst.Status.Applied != nil:
		return inst.Status.Applied.TenantHostImage, false
	case inst.Status.InstalledVersion != "":
		return "", false
	}
	return DefaultTenantHostImage, true
}

// tenancy adds the platform's tenants, users, tenantHostImage(PullPolicy) and tenantAuth config to
// req and returns the tenant host image it applies. The tenantAuth client secret is read from the
// Secret clientSecretRef names, in the instance's namespace, and passed as an encrypted setting;
// it is never part of tenantAuth.
func (r *Reconciler) tenancy(ctx context.Context, inst *v1alpha1.PlatformInstance, req *installer.Request) (string, error) {
	p := inst.Spec.Platform
	tenants := p.Tenants
	if tenants == nil {
		tenants = []v1alpha1.Tenant{}
	}
	users := p.Users
	if users == nil {
		users = []v1alpha1.User{}
	}
	req.Settings["tenants"] = tenants
	req.Settings["users"] = users
	image, fromDefault := tenantHostImage(inst)
	if fromDefault {
		// The installer refuses it unless spec.version's package lists it as an approved host build.
		req.ApprovedHostImage = image
	}
	if image != "" {
		req.Settings["tenantHostImage"] = image
	}
	if p.TenantHostImagePullPolicy != "" {
		req.Settings["tenantHostImagePullPolicy"] = p.TenantHostImagePullPolicy
	}
	req.Unset = tenancyUnset
	a := p.TenantAuth
	if a == nil {
		return image, nil
	}
	if a.ClientSecretRef == nil {
		// The CRD requires it with issuer and clientId; an object from before that rule isn't
		// installed with a console that can't start.
		return "", fmt.Errorf("%w: spec.platform.tenantAuth.clientSecretRef is unset", errTenantAuthSecret)
	}
	ref := *a.ClientSecretRef
	var secret corev1.Secret
	if err := r.Get(ctx, client.ObjectKey{Namespace: inst.Namespace, Name: ref.Name}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return "", fmt.Errorf("%w: Secret %s/%s (spec.platform.tenantAuth.clientSecretRef) not found", errTenantAuthSecret, inst.Namespace, ref.Name)
		}
		return "", fmt.Errorf("%w: read Secret %s/%s: %v", errTenantAuthSecret, inst.Namespace, ref.Name, err)
	}
	value, ok := secret.Data[ref.Key]
	if !ok || len(value) == 0 {
		return "", fmt.Errorf("%w: Secret %s/%s has no key %q (spec.platform.tenantAuth.clientSecretRef)", errTenantAuthSecret, inst.Namespace, ref.Name, ref.Key)
	}
	req.Settings["tenantAuth"] = tenantAuthConfig{
		Image:                 a.Image,
		Issuer:                a.Issuer,
		OAuthClient:           oauthClientConfig{ID: a.ClientID, SecretName: TenantAuthSecretName},
		IssuerUpstream:        a.IssuerUpstream,
		IssuerUpstreamPodPort: a.IssuerUpstreamPodPort,
		IssuerIP:              a.IssuerIP,
		ConsolePublicURL:      a.ConsolePublicURL,
		ControllerPublicURL:   a.ControllerPublicURL,
		Registry:              a.Registry,
	}
	req.SecretSettings = map[string]string{installer.TenantAuthClientSecretKey: string(value)}
	return image, nil
}

// applied summarizes what an install of inst applies.
func applied(inst *v1alpha1.PlatformInstance, image string) *v1alpha1.AppliedConfig {
	a := &v1alpha1.AppliedConfig{
		Generation:      inst.Generation,
		Tenants:         int32(len(inst.Spec.Platform.Tenants)),
		Users:           int32(len(inst.Spec.Platform.Users)),
		TenantHostImage: image,
	}
	if inst.Spec.Platform.TenantAuth != nil {
		a.TenantAuthIssuer = inst.Spec.Platform.TenantAuth.Issuer
	}
	return a
}
