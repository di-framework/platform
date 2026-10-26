package v1alpha1_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/validation"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	"k8s.io/apimachinery/pkg/util/validation/field"
	celconfig "k8s.io/apiserver/pkg/apis/cel"
	"sigs.k8s.io/yaml"
)

// The CRD's CEL rules, run by the apiserver's own CEL validator against the generated schema.

const crdPath = "../../config/crd/platform.di-framework.dev_platforminstances.yaml"

func loadCRD(t *testing.T) *apiextensions.CustomResourceDefinition {
	t.Helper()
	data, err := os.ReadFile(crdPath)
	if err != nil {
		t.Fatal(err)
	}
	var v1 apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(data, &v1); err != nil {
		t.Fatal(err)
	}
	var crd apiextensions.CustomResourceDefinition
	if err := apiextensionsv1.Convert_v1_CustomResourceDefinition_To_apiextensions_CustomResourceDefinition(&v1, &crd, nil); err != nil {
		t.Fatal(err)
	}
	crd.Status.StoredVersions = []string{"v1alpha1"}
	return &crd
}

func validator(t *testing.T) (*cel.Validator, *structuralschema.Structural) {
	t.Helper()
	crd := loadCRD(t)
	// One version: the conversion hoists its schema to spec.validation.
	s, err := structuralschema.NewStructural(crd.Spec.Validation.OpenAPIV3Schema)
	if err != nil {
		t.Fatal(err)
	}
	return cel.NewValidator(s, true, celconfig.PerCallLimit), s
}

func object(t *testing.T, y string) map[string]any {
	t.Helper()
	var o map[string]any
	if err := yaml.Unmarshal([]byte(y), &o); err != nil {
		t.Fatal(err)
	}
	return o
}

func celErrors(t *testing.T, obj, old string) string {
	t.Helper()
	v, s := validator(t)
	var oldObj any
	if old != "" {
		oldObj = object(t, old)
	}
	errs, _ := v.Validate(context.Background(), field.NewPath("root"), s, object(t, obj), oldObj, celconfig.RuntimeCELCostBudget)
	if len(errs) == 0 {
		return ""
	}
	return errs.ToAggregate().Error()
}

// The apiserver accepts the CRD: every rule compiles and stays within the estimated cost limits.
func TestCRDIsValid(t *testing.T) {
	if errs := validation.ValidateCustomResourceDefinition(context.Background(), loadCRD(t)); len(errs) > 0 {
		t.Fatal(errs.ToAggregate())
	}
}

const base = `
metadata: {name: one}
spec:
  version: 6.0.17
  target: {type: vcluster}
`

const tenancy = base + `  platform:
    tenantHostImage: localhost/wash:dev
    tenants: [{name: acme}]
    users: [{name: dev, memberships: [{tenant: acme, role: developer}]}]
    tenantAuth:
      image: ghcr.io/di-framework/tenant-auth@sha256:455af084f57e60a54b16b6f5c4f39fcafb0593612fb036e1b099b88423147a30
      issuer: http://stub-oidc.pg-stub-oidc.svc.cluster.local
      clientId: pgprove-console
      clientSecretRef: {name: oauth, key: clientSecret}
`

func TestTenancyRules(t *testing.T) {
	for name, tc := range map[string]struct{ obj, old, want string }{
		"valid create":          {obj: tenancy},
		"valid tenancy change":  {obj: strings.Replace(tenancy, "[{name: acme}]", "[{name: acme}, {name: beta}]", 1), old: tenancy},
		"membership of nothing": {obj: strings.Replace(tenancy, "tenant: acme", "tenant: other", 1), want: "every users[].memberships[].tenant must name an entry of tenants"},
		"users without tenants": {obj: strings.Replace(tenancy, "    tenants: [{name: acme}]\n", "", 1), want: "every users[].memberships[].tenant must name an entry of tenants"},
		"tenantAuth without secretRef": {
			obj: strings.Replace(tenancy, "      clientSecretRef: {name: oauth, key: clientSecret}\n", "", 1), want: "tenantAuth needs issuer, clientId and clientSecretRef together",
		},
		"tenantAuth without issuer": {
			obj: strings.Replace(tenancy, "      issuer: http://stub-oidc.pg-stub-oidc.svc.cluster.local\n", "", 1), want: "tenantAuth needs issuer, clientId and clientSecretRef together",
		},
		"host image changed": {
			obj: strings.Replace(tenancy, "localhost/wash:dev", "localhost/wash:other", 1), old: tenancy, want: "platform.tenantHostImage is immutable in v1alpha1",
		},
		"host image added": {
			obj: tenancy, old: strings.Replace(tenancy, "    tenantHostImage: localhost/wash:dev\n", "", 1), want: "platform.tenantHostImage is immutable in v1alpha1",
		},
		"host image removed": {
			obj: strings.Replace(tenancy, "    tenantHostImage: localhost/wash:dev\n", "", 1), old: tenancy, want: "platform.tenantHostImage is immutable in v1alpha1",
		},
		"no host image either side": {obj: base, old: base},
	} {
		t.Run(name, func(t *testing.T) {
			got := celErrors(t, tc.obj, tc.old)
			if tc.want == "" && got != "" {
				t.Fatalf("unexpected errors: %s", got)
			}
			if !strings.Contains(got, tc.want) {
				t.Fatalf("errors %q, want %q", got, tc.want)
			}
		})
	}
}
