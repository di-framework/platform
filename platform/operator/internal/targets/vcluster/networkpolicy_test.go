package vcluster

import (
	"context"
	"errors"
	"strings"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/yaml"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

const operatorNS = "platform-operator"

// The rendered policies, as the operator applies them to pi-team-a-one-<hash> (#452).
func TestNetworkPolicies(t *testing.T) {
	ns := HostNamespace(instance("team-a", "one"))
	got, err := yaml.Marshal(NetworkPolicies(ns, operatorNS))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.ReplaceAll(`- metadata:
    labels:
      app.kubernetes.io/managed-by: platform-operator
    name: platform-operator-deny-ingress
    namespace: NS
  spec:
    podSelector: {}
    policyTypes:
    - Ingress
- metadata:
    labels:
      app.kubernetes.io/managed-by: platform-operator
    name: platform-operator-allow-same-namespace
    namespace: NS
  spec:
    ingress:
    - from:
      - podSelector: {}
    podSelector: {}
    policyTypes:
    - Ingress
- metadata:
    labels:
      app.kubernetes.io/managed-by: platform-operator
    name: platform-operator-allow-operator
    namespace: NS
  spec:
    ingress:
    - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: platform-operator
      ports:
      - port: 8443
        protocol: TCP
    podSelector:
      matchLabels:
        app: vcluster
        release: vcluster
    policyTypes:
    - Ingress
`, "NS", ns)
	if string(got) != want {
		t.Fatalf("rendered policies:\n%s\nwant:\n%s", got, want)
	}
}

func policy(t *testing.T, c client.Client, ns, name string) *networkingv1.NetworkPolicy {
	t.Helper()
	var np networkingv1.NetworkPolicy
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: ns, Name: name}, &np); err != nil {
		t.Fatalf("policy %s: %v", name, err)
	}
	return &np
}

// Ensure creates the policies before the vCluster, leaves unchanged ones alone and puts back a
// deleted or edited one on the next round, which is what repair runs.
func TestEnsureOwnsTheHostNetworkPolicies(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	helm := &fakeHelm{installed: map[string]map[string]any{}}
	c := newClient(t)
	tg := &Target{Client: c, Helm: helm, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{}, nil
	}}
	ctx := context.Background()
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	var list networkingv1.NetworkPolicyList
	if err := c.List(ctx, &list, client.InNamespace(ns)); err != nil || len(list.Items) != 3 {
		t.Fatalf("policies in %s: %d %v", ns, len(list.Items), err)
	}
	same := policy(t, c, ns, PolicySameNamespace)

	if err := c.Delete(ctx, policy(t, c, ns, PolicyDenyIngress)); err != nil {
		t.Fatal(err)
	}
	edited := policy(t, c, ns, PolicyOperator)
	edited.Spec.Ingress = nil
	if err := c.Update(ctx, edited); err != nil {
		t.Fatal(err)
	}
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	policy(t, c, ns, PolicyDenyIngress)
	if got := policy(t, c, ns, PolicyOperator); len(got.Spec.Ingress) != 1 {
		t.Fatalf("edited policy not restored: %+v", got.Spec)
	}
	if got := policy(t, c, ns, PolicySameNamespace); got.ResourceVersion != same.ResourceVersion {
		t.Fatalf("unchanged policy rewritten: %s -> %s", same.ResourceVersion, got.ResourceVersion)
	}
}

func TestEnsureNeedsTheOperatorNamespace(t *testing.T) {
	tg := &Target{Client: newClient(t), Helm: &fakeHelm{installed: map[string]map[string]any{}}, OperatorUsername: operatorUser}
	if _, err := tg.Ensure(context.Background(), instance("team-a", "one")); err == nil || !strings.Contains(err.Error(), "operator's namespace") {
		t.Fatalf("Ensure without the operator namespace: %v", err)
	}
}

func TestApplyNetworkPoliciesReportsAWriteError(t *testing.T) {
	c := interceptor.NewClient(newClient(t).(client.WithWatch), interceptor.Funcs{
		Create: func(context.Context, client.WithWatch, client.Object, ...client.CreateOption) error {
			return errors.New("denied")
		},
	})
	tg := &Target{Client: c, OperatorNamespace: operatorNS, OperatorUsername: operatorUser}
	if err := tg.applyNetworkPolicies(context.Background(), "pi-x"); err == nil || !strings.Contains(err.Error(), "network policy pi-x/"+PolicyDenyIngress+": denied") {
		t.Fatalf("write error: %v", err)
	}
}
