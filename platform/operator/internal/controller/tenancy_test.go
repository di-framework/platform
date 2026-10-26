package controller

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

const (
	testAuthImage = "ghcr.io/di-framework/tenant-auth@sha256:455af084f57e60a54b16b6f5c4f39fcafb0593612fb036e1b099b88423147a30"
	testRegistry  = "ghcr.io/di-framework/oci-registry@sha256:" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func tenancySpec() v1alpha1.PlatformSettings {
	pod := int32(8080)
	return v1alpha1.PlatformSettings{
		Tenants: []v1alpha1.Tenant{{Name: "acme", Runtime: &v1alpha1.TenantRuntime{CoreInstances: &pod}}},
		Users: []v1alpha1.User{{Name: "dev", Memberships: []v1alpha1.Membership{
			{Tenant: "acme", Role: "developer"},
		}}},
		TenantHostImagePullPolicy: "IfNotPresent",
		TenantAuth: &v1alpha1.TenantAuth{
			Image: testAuthImage, Issuer: "http://stub-oidc.pg-stub-oidc.svc.cluster.local", ClientID: "pgprove-console",
			ClientSecretRef: &v1alpha1.SecretKeyReference{Name: "oauth", Key: "clientSecret"},
			IssuerUpstream:  "stub-oidc.pg-stub-oidc.svc.cluster.local:80", IssuerUpstreamPodPort: 8080,
			Registry: &v1alpha1.TenantRegistry{Component: testRegistry},
		},
	}
}

// tenancyHarness is an instance with tenancySpec, before its first reconcile.
func tenancyHarness(t *testing.T, withSecret bool) *harness {
	t.Helper()
	h := newHarness(t, "")
	inst := h.get()
	inst.Spec.Platform = tenancySpec()
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	if withSecret {
		if err := h.c.Create(context.Background(), &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: "oauth"},
			Data:       map[string][]byte{"clientSecret": []byte("s3cret")},
		}); err != nil {
			t.Fatal(err)
		}
	}
	h.readyTarget()
	return h
}

func TestTenancyConfigMapping(t *testing.T) {
	h := tenancyHarness(t, true)
	h.reconcile()
	h.reconcile()
	if len(h.in.installs) != 1 {
		t.Fatalf("installs %d", len(h.in.installs))
	}
	req := h.in.installs[0]
	got := map[string]string{}
	for _, k := range []string{"tenants", "users", "tenantAuth", "tenantHostImage", "tenantHostImagePullPolicy"} {
		b, err := json.Marshal(req.Settings[k])
		if err != nil {
			t.Fatal(err)
		}
		got[k] = string(b)
	}
	want := map[string]string{
		"tenants":                   `[{"name":"acme","runtime":{"coreInstances":8080}}]`,
		"users":                     `[{"name":"dev","memberships":[{"tenant":"acme","role":"developer"}]}]`,
		"tenantHostImage":           `"` + DefaultTenantHostImage + `"`,
		"tenantHostImagePullPolicy": `"IfNotPresent"`,
		"tenantAuth": `{"image":"` + testAuthImage + `","issuer":"http://stub-oidc.pg-stub-oidc.svc.cluster.local",` +
			`"oauthClient":{"id":"pgprove-console","secretName":"platform-operator-tenant-auth"},` +
			`"issuerUpstream":"stub-oidc.pg-stub-oidc.svc.cluster.local:80","issuerUpstreamPodPort":8080,` +
			`"registry":{"component":"` + testRegistry + `"}}`,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s:\n got %s\nwant %s", k, got[k], v)
		}
	}
	if req.SecretSettings["tenantAuthClientSecret"] != "s3cret" || strings.Contains(got["tenantAuth"], "s3cret") {
		t.Fatalf("client secret: secret settings %v, tenantAuth %s", req.SecretSettings, got["tenantAuth"])
	}

	s := h.get().Status
	want2 := v1alpha1.AppliedConfig{Generation: 1, Tenants: 1, Users: 1,
		TenantAuthIssuer: "http://stub-oidc.pg-stub-oidc.svc.cluster.local", TenantHostImage: DefaultTenantHostImage}
	if s.Applied == nil || *s.Applied != want2 {
		t.Fatalf("applied %+v", s.Applied)
	}
	c := meta.FindStatusCondition(s.Conditions, v1alpha1.ConditionConfigApplied)
	if c == nil || c.Status != metav1.ConditionTrue || !strings.Contains(c.Message, "generation 1: 1 tenant(s), 1 user(s)") {
		t.Fatalf("ConfigApplied %+v", c)
	}
}

func TestCustomTenantHostImage(t *testing.T) {
	h := newHarness(t, "")
	inst := h.get()
	inst.Spec.Platform.TenantHostImage = "localhost/wash:dev"
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.readyTarget()
	h.reconcile()
	h.reconcile()
	if got := h.in.installs[0].Settings["tenantHostImage"]; got != "localhost/wash:dev" {
		t.Fatalf("tenantHostImage %v", got)
	}
	if _, set := h.in.installs[0].Settings["tenantHostImagePullPolicy"]; set {
		t.Fatal("an unset pull policy must not be set")
	}
}

func TestTenantAuthSecretUnavailable(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate func(*harness)
		want   string
	}{
		"missing Secret": {func(*harness) {}, `Secret team-a/oauth (spec.platform.tenantAuth.clientSecretRef) not found`},
		"missing key": {func(h *harness) {
			if err := h.c.Create(context.Background(), &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Namespace: key.Namespace, Name: "oauth"},
				Data:       map[string][]byte{"other": []byte("x")},
			}); err != nil {
				t.Fatal(err)
			}
		}, `Secret team-a/oauth has no key "clientSecret"`},
		"no ref": {func(h *harness) {
			inst := h.get()
			inst.Spec.Platform.TenantAuth.ClientSecretRef = nil
			if err := h.c.Update(context.Background(), inst); err != nil {
				t.Fatal(err)
			}
		}, "clientSecretRef is unset"},
		"read error": {func(h *harness) {
			h.r.Client = interceptorClient(h.c.(client.WithWatch))
		}, "read Secret team-a/oauth: boom"},
	} {
		t.Run(name, func(t *testing.T) {
			h := tenancyHarness(t, false)
			tc.mutate(h)
			h.reconcile()
			if _, err := h.r.Reconcile(context.Background(), ctrl.Request{NamespacedName: key}); !errors.Is(err, errTenantAuthSecret) {
				t.Fatalf("err %v, want errTenantAuthSecret", err)
			}
			if len(h.in.installs) != 0 {
				t.Fatal("installed without the client secret")
			}
			inst := h.get()
			c := meta.FindStatusCondition(inst.Status.Conditions, v1alpha1.ConditionInstalled)
			if c == nil || c.Status != metav1.ConditionFalse || c.Reason != v1alpha1.ReasonTenantAuthSecret || !strings.Contains(c.Message, tc.want) {
				t.Fatalf("Installed %+v, want message with %q", c, tc.want)
			}
			if inst.Status.Phase != v1alpha1.PhaseFailed {
				t.Fatalf("phase %s", inst.Status.Phase)
			}
		})
	}
}

// interceptorClient fails Secret reads other than the kubeconfig Secret.
func interceptorClient(c client.WithWatch) client.WithWatch {
	return interceptor.NewClient(c, interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, k client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*corev1.Secret); ok && k.Name == "oauth" {
				return errors.New("boom")
			}
			return c.Get(ctx, k, obj, opts...)
		},
	})
}

// A spec change on a Ready instance (a tenant added) starts an install with the new config; an
// unchanged spec only repairs on the interval, with the same settings.
func TestTenancyChangeOnReadyInstanceInstalls(t *testing.T) {
	h := tenancyHarness(t, true)
	h.reconcile()
	h.reconcile()
	inst := h.get()
	inst.Spec.Platform.Tenants = append(inst.Spec.Platform.Tenants, v1alpha1.Tenant{Name: "beta"})
	inst.Generation = 2
	if err := h.c.Update(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	h.reconcile()
	if len(h.in.installs) != 2 || conditionReason(h.get(), v1alpha1.ConditionInstalled) != "SpecChanged" {
		t.Fatalf("installs %d reason %q", len(h.in.installs), conditionReason(h.get(), v1alpha1.ConditionInstalled))
	}
	if n := len(h.in.installs[1].Settings["tenants"].([]v1alpha1.Tenant)); n != 2 {
		t.Fatalf("tenants %d", n)
	}
	if a := h.get().Status.Applied; a.Generation != 2 || a.Tenants != 2 {
		t.Fatalf("applied %+v", a)
	}
	if res := h.reconcile(); len(h.in.installs) != 2 || res.RequeueAfter <= 0 {
		t.Fatalf("unchanged spec installed again: %d", len(h.in.installs))
	}
}

// The default host image follows the wash-wasi-tls-exclusive pin in the tenant host README, which
// scripts/pin-artifact.ts moves together with this constant.
func TestDefaultTenantHostImageMatchesThePublishedExclusiveVariant(t *testing.T) {
	readme, err := os.ReadFile(filepath.Join("..", "..", "..", "tenant-host", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile("(?m)^\\| `wasi-tls-exclusive` \\| `([^`]+)`").FindSubmatch(readme)
	if m == nil || string(m[1]) != DefaultTenantHostImage {
		t.Fatalf("README pins %q, DefaultTenantHostImage is %q", m, DefaultTenantHostImage)
	}
}
