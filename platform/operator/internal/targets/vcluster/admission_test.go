package vcluster

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/cel-go/cel"
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/yaml"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

const operatorUser = "system:serviceaccount:platform-operator:platform-operator"

// The rendered policy and binding, as the operator applies them (#466).
func TestAdmissionPolicy(t *testing.T) {
	policy, binding := AdmissionPolicy(operatorUser)
	got, err := yaml.Marshal([]any{policy, binding})
	if err != nil {
		t.Fatal(err)
	}
	want := `- metadata:
    labels:
      app.kubernetes.io/managed-by: platform-operator
    name: platform-operator-protect-vcluster-service
  spec:
    failurePolicy: Fail
    matchConstraints:
      matchPolicy: Equivalent
      namespaceSelector: {}
      objectSelector: {}
      resourceRules:
      - apiGroups:
        - ""
        apiVersions:
        - v1
        operations:
        - DELETE
        resources:
        - services
        scope: '*'
    validations:
    - expression: oldObject.metadata.name != "vcluster" || request.userInfo.username
        == "system:serviceaccount:platform-operator:platform-operator" || has(namespaceObject.metadata.deletionTimestamp)
      message: service/vcluster owns every object vCluster syncs into this host namespace;
        deleting it garbage-collects the instance's pods, Secrets and ConfigMaps (see
        https://github.com/di-framework/platform/issues/466). Delete the PlatformInstance
        instead.
      reason: Forbidden
  status: {}
- metadata:
    labels:
      app.kubernetes.io/managed-by: platform-operator
    name: platform-operator-protect-vcluster-service
  spec:
    matchResources:
      matchPolicy: Equivalent
      namespaceSelector:
        matchLabels:
          platform.di-framework.dev/host-namespace: "true"
      objectSelector: {}
    policyName: platform-operator-protect-vcluster-service
    validationActions:
    - Deny
`
	if string(got) != want {
		t.Fatalf("policy:\n%s\nwant:\n%s", got, want)
	}
}

// The policy's rule, evaluated with CEL on the variables the API server binds for a DELETE:
// only service/vcluster is protected, and the operator (helm uninstall) and the namespace
// controller (a terminating namespace) may still delete it.
func TestAdmissionExpression(t *testing.T) {
	env, err := cel.NewEnv(
		cel.Variable("oldObject", cel.DynType),
		cel.Variable("request", cel.DynType),
		cel.Variable("namespaceObject", cel.DynType),
	)
	if err != nil {
		t.Fatal(err)
	}
	ast, iss := env.Compile(AdmissionExpression(operatorUser))
	if iss.Err() != nil {
		t.Fatal(iss.Err())
	}
	if ast.OutputType() != cel.BoolType && ast.OutputType() != cel.DynType {
		t.Fatalf("output type %v", ast.OutputType())
	}
	prg, err := env.Program(ast)
	if err != nil {
		t.Fatal(err)
	}
	ns := func(terminating bool) map[string]any {
		meta := map[string]any{"name": "pi-team-a-one-0123456789"}
		if terminating {
			meta["deletionTimestamp"] = "2026-10-27T00:13:43Z"
		}
		return map[string]any{"metadata": meta}
	}
	for _, tc := range []struct {
		name, service, user string
		terminating         bool
		allowed             bool
	}{
		{"kubectl deletes service/vcluster", "vcluster", "kubernetes-admin", false, false},
		{"another service account deletes it", "vcluster", "system:serviceaccount:platform-operator:other", false, false},
		{"the operator deletes it", "vcluster", operatorUser, false, true},
		{"the namespace is being deleted", "vcluster", "system:serviceaccount:kube-system:namespace-controller", true, true},
		{"another Service", "vcluster-headless", "kubernetes-admin", false, true},
	} {
		out, _, err := prg.Eval(map[string]any{
			"oldObject":       map[string]any{"metadata": map[string]any{"name": tc.service}},
			"request":         map[string]any{"userInfo": map[string]any{"username": tc.user}},
			"namespaceObject": ns(tc.terminating),
		})
		if err != nil || out.Value() != tc.allowed {
			t.Errorf("%s: allowed = %v (%v), want %v", tc.name, out, err, tc.allowed)
		}
	}
}

// Ensure installs the policy and its binding and puts back an edited or deleted one.
func TestEnsureOwnsTheAdmissionPolicy(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	ctx := context.Background()
	if st, err := tg.Ensure(ctx, inst); err != nil || !st.Ready {
		t.Fatalf("Ensure: %+v %v", st, err)
	}
	wantPolicy, wantBinding := AdmissionPolicy(operatorUser)
	var policy admissionregistrationv1.ValidatingAdmissionPolicy
	var binding admissionregistrationv1.ValidatingAdmissionPolicyBinding
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: AdmissionPolicyName}, &policy); err != nil || policy.Spec.Validations[0].Expression != wantPolicy.Spec.Validations[0].Expression {
		t.Fatalf("policy %+v %v", policy.Spec, err)
	}
	policy.Spec.Validations[0].Expression = "true"
	if err := tg.Client.Update(ctx, &policy); err != nil {
		t.Fatal(err)
	}
	if err := tg.Client.Delete(ctx, &admissionregistrationv1.ValidatingAdmissionPolicyBinding{ObjectMeta: metav1.ObjectMeta{Name: AdmissionPolicyName}}); err != nil {
		t.Fatal(err)
	}
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: AdmissionPolicyName}, &policy); err != nil || policy.Spec.Validations[0].Expression != wantPolicy.Spec.Validations[0].Expression {
		t.Fatalf("edited policy not put back: %+v %v", policy.Spec, err)
	}
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: AdmissionPolicyName}, &binding); err != nil || binding.Spec.PolicyName != wantBinding.Spec.PolicyName {
		t.Fatalf("deleted binding not put back: %+v %v", binding.Spec, err)
	}
}

// A host namespace created before the label existed gets it; a new one is created with it.
func TestEnsureLabelsTheHostNamespace(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	ctx := context.Background()
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	var ns corev1.Namespace
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: HostNamespace(inst)}, &ns); err != nil || ns.Labels[HostNamespaceLabel] != "true" {
		t.Fatalf("existing namespace not labelled: %v %v", ns.Labels, err)
	}
	other := instance("team-b", "two")
	tg.Values = func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{}, nil
	}
	if _, err := tg.Ensure(ctx, other); err != nil {
		t.Fatal(err)
	}
	if err := tg.Client.Get(ctx, client.ObjectKey{Name: HostNamespace(other)}, &ns); err != nil || ns.Labels[HostNamespaceLabel] != "true" {
		t.Fatalf("new namespace not labelled: %v %v", ns.Labels, err)
	}
}

func TestEnsureReportsAdmissionPolicyErrors(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	ctx := context.Background()
	tg.OperatorUsername = ""
	if _, err := tg.Ensure(ctx, inst); err == nil || err.Error() != "the operator's username is unknown" {
		t.Fatalf("no username: %v", err)
	}
	tg.OperatorUsername = operatorUser
	base := tg.Client.(client.WithWatch)
	for _, kind := range []string{"policy", "binding"} {
		tg.Client = interceptor.NewClient(base, interceptor.Funcs{
			Get: func(ctx context.Context, cl client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
				switch obj.(type) {
				case *admissionregistrationv1.ValidatingAdmissionPolicy:
					if kind == "policy" {
						return errors.New("boom")
					}
				case *admissionregistrationv1.ValidatingAdmissionPolicyBinding:
					if kind == "binding" {
						return errors.New("boom")
					}
				}
				return cl.Get(ctx, key, obj, opts...)
			},
		})
		if _, err := tg.Ensure(ctx, inst); err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("%s error: %v", kind, err)
		}
	}
}

func TestEnsureReportsANamespaceLabelError(t *testing.T) {
	tg, _, inst, _ := readyInstance(t)
	tg.Client = interceptor.NewClient(tg.Client.(client.WithWatch), interceptor.Funcs{
		Patch: func(context.Context, client.WithWatch, client.Object, client.Patch, ...client.PatchOption) error {
			return errors.New("patch failed")
		},
	})
	if _, err := tg.Ensure(context.Background(), inst); err == nil || err.Error() != "patch failed" {
		t.Fatalf("label error: %v", err)
	}
}
