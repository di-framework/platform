package v1alpha1_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/validation"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	apiservervalidation "k8s.io/apiextensions-apiserver/pkg/apiserver/validation"
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
			obj: strings.Replace(tenancy, "localhost/wash:dev", "localhost/wash:other", 1), old: tenancy,
		},
		"host image added":          {obj: tenancy, old: strings.Replace(tenancy, "    tenantHostImage: localhost/wash:dev\n", "", 1)},
		"host image removed":        {obj: strings.Replace(tenancy, "    tenantHostImage: localhost/wash:dev\n", "", 1), old: tenancy},
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

// schemaErrors runs the CRD's OpenAPI schema (types, bounds, patterns) as the apiserver does.
func schemaErrors(t *testing.T, obj string) string {
	t.Helper()
	v, _, err := apiservervalidation.NewSchemaValidator(loadCRD(t).Spec.Validation.OpenAPIV3Schema)
	if err != nil {
		t.Fatal(err)
	}
	errs := apiservervalidation.ValidateCustomResource(field.NewPath("root"), object(t, obj), v)
	if len(errs) == 0 {
		return ""
	}
	return errs.ToAggregate().Error()
}

// W3: the tenant bounds are the platform Tenant CRD's, so bad values fail admission.
func TestTenantBounds(t *testing.T) {
	withTenant := func(fields string) string {
		return strings.Replace(tenancy, "tenants: [{name: acme}]", "tenants: [{name: acme, "+fields+"}]", 1)
	}
	ok := "runtime: {replicas: 10, coreInstances: 10000}, resources: {cpu: '1.5', memory: 512Mi, workloads: 1000, backingServices: 100, serviceBindings: 400, apiKeys: 10000}"
	if got := schemaErrors(t, withTenant(ok)); got != "" {
		t.Fatalf("upper bounds rejected: %s", got)
	}
	for _, bad := range []string{
		"runtime: {replicas: 0}", "runtime: {replicas: 11}", "runtime: {coreInstances: 0}", "runtime: {coreInstances: 10001}",
		"resources: {cpu: two}", "resources: {memory: 4GB}", "resources: {cpu: '-1'}",
		"resources: {workloads: 0}", "resources: {workloads: 1001}",
		"resources: {backingServices: 0}", "resources: {backingServices: 101}",
		"resources: {serviceBindings: 0}", "resources: {serviceBindings: 401}",
		"resources: {apiKeys: 0}", "resources: {apiKeys: 10001}",
	} {
		if schemaErrors(t, withTenant(bad)) == "" {
			t.Errorf("%s: accepted", bad)
		}
	}
}

// W2: the largest object the limits allow (32 tenants, 128 users with 16 memberships each, every
// name 40 characters) passes the membership rule within the apiserver's runtime cost limits.
func TestLargestAllowedSpecFitsTheCELBudget(t *testing.T) {
	name := func(prefix string, i int) string {
		n := fmt.Sprintf("%s%d", prefix, i)
		return n + strings.Repeat("x", 40-len(n))
	}
	var b strings.Builder
	b.WriteString(base + "  platform:\n    tenants:\n")
	for i := range 32 {
		fmt.Fprintf(&b, "      - name: %s\n", name("t", i))
	}
	b.WriteString("    users:\n")
	for u := range 128 {
		fmt.Fprintf(&b, "      - name: %s\n        memberships:\n", name("u", u))
		for m := range 16 {
			fmt.Fprintf(&b, "          - {tenant: %s, role: viewer}\n", name("t", 31-m))
		}
	}
	big := b.String()
	if got := schemaErrors(t, big); got != "" {
		t.Fatalf("schema: %s", got)
	}
	if got := celErrors(t, big, big); got != "" {
		t.Fatalf("CEL: %s", got)
	}
	// One more user is refused by the schema.
	more := strings.Replace(big, "    users:\n", "    users:\n      - {name: extra, memberships: []}\n", 1)
	if !strings.Contains(schemaErrors(t, more), "must have at most 128 items") {
		t.Fatalf("129 users accepted: %s", schemaErrors(t, more))
	}
}
