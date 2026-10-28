package vcluster

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/yaml"

	"github.com/di-framework/platform/operator/api/v1alpha1"
)

const operatorNS = "platform-operator"

// stubIssuer is the issuerUpstream the proving-grounds Layer 3 run sets.
var stubIssuer = &v1alpha1.TenantAuth{IssuerUpstream: "stub-oidc.pg-stub-oidc.svc.cluster.local:80", IssuerUpstreamPodPort: 8080}

// The rendered policies, as the operator applies them to pi-team-a-one-<hash> with the Layer 3
// issuer (#452, #535).
func TestNetworkPolicies(t *testing.T) {
	ns := HostNamespace(instance("team-a", "one"))
	got := NetworkPolicies(ns, operatorNS, stubIssuer)
	golden, err := os.ReadFile("testdata/host-network-policies.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var want []*networkingv1.NetworkPolicy
	if err := yaml.UnmarshalStrict([]byte(strings.ReplaceAll(string(golden), "namespace: NS\n", "namespace: "+ns+"\n")), &want); err != nil {
		t.Fatal(err)
	}
	if !equality.Semantic.DeepEqual(got, want) {
		rendered, _ := yaml.Marshal(got)
		t.Fatalf("rendered policies:\n%s\nwant:\n%s", rendered, golden)
	}
}

func policyNames(policies []*networkingv1.NetworkPolicy) []string {
	out := make([]string, 0, len(policies))
	for _, p := range policies {
		out = append(out, p.Name)
	}
	return out
}

// The issuer policy exists only with an issuerUpstream, and every narrow allow comes before the
// same-namespace policy, so narrowing an old broad one never drops DNS or the API.
func TestNetworkPolicyOrder(t *testing.T) {
	base := []string{PolicyDenyIngress, PolicyControlPlane, PolicyDNS, PolicySameNamespace, PolicyOperator}
	withIssuer := []string{PolicyDenyIngress, PolicyControlPlane, PolicyDNS, PolicyIssuer, PolicySameNamespace, PolicyOperator}
	for _, tc := range []struct {
		name string
		auth *v1alpha1.TenantAuth
		want []string
	}{
		{"no tenantAuth", nil, base},
		{"external issuer", &v1alpha1.TenantAuth{Issuer: "https://id.example.com"}, base},
		{"issuerUpstream", stubIssuer, withIssuer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := policyNames(NetworkPolicies("pi-x", operatorNS, tc.auth)); !slices.Equal(got, tc.want) {
				t.Fatalf("policies %v, want %v", got, tc.want)
			}
		})
	}
}

func TestIssuerUpstream(t *testing.T) {
	for _, tc := range []struct {
		upstream  string
		podPort   int32
		namespace string
		ports     []int32
	}{
		{"", 8080, "", nil},
		{"stub-oidc.pg-stub-oidc.svc.cluster.local:80", 8080, "pg-stub-oidc", []int32{80, 8080}},
		{"issuer.idp:8443", 0, "idp", []int32{8443}},
		{"issuer.idp:8080", 8080, "idp", []int32{8080}},
		{"issuer", 0, "wasmcloud", []int32{80}},
		{"issuer.idp:http", 9000, "idp", []int32{9000}},
		{"issuer.idp:http", 0, "", nil},
	} {
		t.Run(fmt.Sprintf("%s/%d", tc.upstream, tc.podPort), func(t *testing.T) {
			ns, ports, ok := issuerUpstream(&v1alpha1.TenantAuth{IssuerUpstream: tc.upstream, IssuerUpstreamPodPort: tc.podPort})
			if ok != (tc.ports != nil) || (ok && (ns != tc.namespace || !slices.Equal(ports, tc.ports))) {
				t.Fatalf("issuerUpstream = %q %v %v, want %q %v", ns, ports, ok, tc.namespace, tc.ports)
			}
		})
	}
	if _, _, ok := issuerUpstream(nil); ok {
		t.Fatal("issuerUpstream without tenantAuth")
	}
}

// Host-side labels of an instance's pods, as vCluster 0.37.3 synced them in the proving-grounds
// Layer 4 runs.
func synced(virtualNamespace string, extra map[string]string) map[string]string {
	out := map[string]string{labelManagedBy: ReleaseName, labelVirtualNamespace: virtualNamespace}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

var (
	controlPlanePod = map[string]string{"app": "vcluster", "release": "vcluster", "statefulset.kubernetes.io/pod-name": "vcluster-0"}
	probePod        = synced("l4-probe", nil)
	spoofedPod      = synced("l4-probe", map[string]string{"app": "vcluster", "release": "vcluster", "k8s-app": "kube-dns"})
	tenantAuthPod   = synced("di-runtime-a", map[string]string{"app": "tenant-console", labelComponent: "tenant-auth"})
	gatewayPod      = synced("wasmcloud", map[string]string{"app": "di-platform-gateway"})
	natsPod         = synced("wasmcloud", map[string]string{"wasmcloud.com/name": "nats"})
	tenantHostPod   = synced("di-runtime-a", map[string]string{"wasmcloud.com/name": "hostgroup", "wasmcloud.com/hostgroup": "tenant-a"})
	coreDNSPod      = synced("kube-system", map[string]string{"k8s-app": "kube-dns"})
	issuerPod       = synced("pg-stub-oidc", map[string]string{"app": "stub-oidc"})
)

func matches(t *testing.T, s *metav1.LabelSelector, pod map[string]string) bool {
	t.Helper()
	sel, err := metav1.LabelSelectorAsSelector(s)
	if err != nil {
		t.Fatal(err)
	}
	return sel.Matches(labels.Set(pod))
}

// admitted lists what the operator's policies alone let src reach on dst, both pods of the host
// namespace: "*" for every port, else protocol/port.
func admitted(t *testing.T, policies []*networkingv1.NetworkPolicy, src, dst map[string]string) []string {
	t.Helper()
	var out []string
	for _, p := range policies {
		if !matches(t, &p.Spec.PodSelector, dst) {
			continue
		}
		for _, rule := range p.Spec.Ingress {
			if !slices.ContainsFunc(rule.From, func(peer networkingv1.NetworkPolicyPeer) bool {
				return peer.NamespaceSelector == nil && peer.PodSelector != nil && matches(t, peer.PodSelector, src)
			}) {
				continue
			}
			if len(rule.Ports) == 0 {
				out = append(out, "*")
			}
			for _, port := range rule.Ports {
				out = append(out, fmt.Sprintf("%s/%s", *port.Protocol, port.Port.String()))
			}
		}
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// #535: between the instance's own pods the operator admits only the vCluster flows and the
// issuer, so the platform's synced policies decide the rest (Layer 4 gate 3.2's in-instance row:
// a probe in a non-platform, non-tenant namespace).
func TestNetworkPoliciesInsideTheInstance(t *testing.T) {
	policies := NetworkPolicies("pi-x", operatorNS, stubIssuer)
	for _, tc := range []struct {
		name     string
		src, dst map[string]string
		want     []string
	}{
		{"probe to gateway", probePod, gatewayPod, nil},
		{"probe to NATS", probePod, natsPod, nil},
		{"probe to tenant host", probePod, tenantHostPod, nil},
		{"probe to issuer", probePod, issuerPod, nil},
		{"probe to CoreDNS", probePod, coreDNSPod, []string{"TCP/53", "UDP/53"}},
		{"probe to control plane", probePod, controlPlanePod, []string{"TCP/8443"}},
		{"spoofed control plane to NATS", spoofedPod, natsPod, nil},
		{"spoofed control plane to tenant host", spoofedPod, tenantHostPod, nil},
		{"tenant-auth to issuer", tenantAuthPod, issuerPod, []string{"TCP/80", "TCP/8080"}},
		{"tenant-auth to gateway", tenantAuthPod, gatewayPod, nil},
		{"control plane to NATS", controlPlanePod, natsPod, []string{"*"}},
		{"control plane to tenant host", controlPlanePod, tenantHostPod, []string{"*"}},
		{"control plane to itself", controlPlanePod, controlPlanePod, []string{"*"}},
		{"tenant host to NATS", tenantHostPod, natsPod, nil},
		{"gateway to tenant host", gatewayPod, tenantHostPod, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := admitted(t, policies, tc.src, tc.dst); !slices.Equal(got, tc.want) {
				t.Fatalf("admitted %v, want %v", got, tc.want)
			}
		})
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

func ensureTarget(c client.Client) *Target {
	return &Target{Client: c, Helm: &fakeHelm{installed: map[string]map[string]any{}}, OperatorNamespace: operatorNS, OperatorUsername: operatorUser, Values: func(context.Context, *v1alpha1.PlatformInstance) (map[string]any, error) {
		return map[string]any{}, nil
	}}
}

// Ensure creates the policies before the vCluster, leaves unchanged ones alone and puts back a
// deleted or edited one on the next round, which is what repair runs.
func TestEnsureOwnsTheHostNetworkPolicies(t *testing.T) {
	inst := instance("team-a", "one")
	ns := HostNamespace(inst)
	c := newClient(t)
	tg := ensureTarget(c)
	ctx := context.Background()
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	var list networkingv1.NetworkPolicyList
	if err := c.List(ctx, &list, client.InNamespace(ns)); err != nil || len(list.Items) != 5 {
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

// An instance created before #535 has the broad same-namespace policy. The next round narrows it
// in place (same object, its other labels kept), after the narrow allows that replace it exist.
func TestEnsureNarrowsAnOldSameNamespacePolicyInPlace(t *testing.T) {
	inst := instance("team-a", "one")
	inst.Spec.Platform.TenantAuth = stubIssuer
	ns := HostNamespace(inst)
	old := &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: PolicySameNamespace, Namespace: ns, UID: "old-uid", Labels: map[string]string{
			"app.kubernetes.io/managed-by": "platform-operator", "team": "a",
		}},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{},
			PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
			Ingress:     []networkingv1.NetworkPolicyIngressRule{{From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{}}}}},
		},
	}
	var writes []string
	record := func(verb string, obj client.Object) {
		if _, ok := obj.(*networkingv1.NetworkPolicy); ok {
			writes = append(writes, verb+" "+obj.GetName())
		}
	}
	c := interceptor.NewClient(newClient(t, old).(client.WithWatch), interceptor.Funcs{
		Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			record("create", obj)
			return c.Create(ctx, obj, opts...)
		},
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			record("update", obj)
			return c.Update(ctx, obj, opts...)
		},
	})
	if _, err := ensureTarget(c).Ensure(context.Background(), inst); err != nil {
		t.Fatal(err)
	}
	got := policy(t, c, ns, PolicySameNamespace)
	policies := NetworkPolicies(ns, operatorNS, stubIssuer)
	want := policies[slices.Index(policyNames(policies), PolicySameNamespace)]
	if got.UID != "old-uid" || got.Labels["team"] != "a" || !equality.Semantic.DeepEqual(got.Spec, want.Spec) {
		t.Fatalf("same-namespace policy not narrowed in place: uid %s labels %v spec %+v", got.UID, got.Labels, got.Spec)
	}
	wantWrites := []string{
		"create " + PolicyDenyIngress, "create " + PolicyControlPlane, "create " + PolicyDNS, "create " + PolicyIssuer,
		"update " + PolicySameNamespace, "create " + PolicyOperator,
	}
	if !slices.Equal(writes, wantWrites) {
		t.Fatalf("writes %v, want %v", writes, wantWrites)
	}
}

// The issuer policy follows spec.tenantAuth.issuerUpstream: it is deleted once that is unset.
func TestEnsureDropsTheIssuerPolicyWithTheIssuerUpstream(t *testing.T) {
	inst := instance("team-a", "one")
	inst.Spec.Platform.TenantAuth = stubIssuer
	ns := HostNamespace(inst)
	c := newClient(t)
	tg := ensureTarget(c)
	ctx := context.Background()
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	if got := policy(t, c, ns, PolicyIssuer); got.Spec.PodSelector.MatchLabels[labelVirtualNamespace] != "pg-stub-oidc" {
		t.Fatalf("issuer policy selects %v", got.Spec.PodSelector)
	}
	inst.Spec.Platform.TenantAuth = &v1alpha1.TenantAuth{Issuer: "https://id.example.com"}
	if _, err := tg.Ensure(ctx, inst); err != nil {
		t.Fatal(err)
	}
	err := c.Get(ctx, client.ObjectKey{Namespace: ns, Name: PolicyIssuer}, &networkingv1.NetworkPolicy{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("issuer policy after issuerUpstream was unset: %v", err)
	}
}

func TestEnsureNeedsTheOperatorNamespace(t *testing.T) {
	tg := &Target{Client: newClient(t), Helm: &fakeHelm{installed: map[string]map[string]any{}}, OperatorUsername: operatorUser}
	if _, err := tg.Ensure(context.Background(), instance("team-a", "one")); err == nil || !strings.Contains(err.Error(), "operator's namespace") {
		t.Fatalf("Ensure without the operator namespace: %v", err)
	}
}

func TestApplyNetworkPoliciesReportsAWriteError(t *testing.T) {
	denied := errors.New("denied")
	for _, tc := range []struct {
		name  string
		funcs interceptor.Funcs
		want  string
	}{
		{"create", interceptor.Funcs{Create: func(context.Context, client.WithWatch, client.Object, ...client.CreateOption) error {
			return denied
		}}, PolicyDenyIngress},
		{"delete", interceptor.Funcs{Delete: func(context.Context, client.WithWatch, client.Object, ...client.DeleteOption) error {
			return denied
		}}, PolicyIssuer},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stale := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: PolicyIssuer, Namespace: "pi-x"}}
			tg := &Target{Client: interceptor.NewClient(newClient(t, stale).(client.WithWatch), tc.funcs), OperatorNamespace: operatorNS, OperatorUsername: operatorUser}
			if err := tg.applyNetworkPolicies(context.Background(), "pi-x", nil); err == nil || !strings.Contains(err.Error(), "network policy pi-x/"+tc.want+": denied") {
				t.Fatalf("write error: %v", err)
			}
		})
	}
}
