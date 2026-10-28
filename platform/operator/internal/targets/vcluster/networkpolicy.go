package vcluster

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	"github.com/di-framework/platform/operator/api/v1alpha1"
	"github.com/di-framework/platform/operator/internal/targets"
)

// Host-namespace NetworkPolicies the operator owns in every instance's host namespace (#452).
// Between the instance's own pods they admit only what the vCluster machinery needs; every other
// flow inside the instance is left to the policies vCluster syncs from inside it (#535).
const (
	// PolicyDenyIngress selects every pod in the host namespace for ingress, with no rule, so
	// only what the other policies (the operator's and those vCluster syncs from inside the
	// instance) allow gets in.
	PolicyDenyIngress = "platform-operator-deny-ingress"
	// PolicyControlPlane admits the instance's synced pods to the vCluster control plane's port
	// 8443: the API server (svc/vcluster:443) and the kubelet port (10250) of its
	// vcluster-node-* Services.
	PolicyControlPlane = "platform-operator-allow-control-plane"
	// PolicyDNS admits the instance's synced pods to its CoreDNS on 53.
	PolicyDNS = "platform-operator-allow-dns"
	// PolicyIssuer admits the instance's tenant-auth pods to the pods of the namespace
	// spec.tenantAuth.issuerUpstream names, on its ports. Only with an issuerUpstream.
	PolicyIssuer = "platform-operator-allow-issuer"
	// PolicySameNamespace admits the vCluster control plane to every pod of the host namespace:
	// its synced pods (admission webhooks and the API server's other calls into them) and its
	// own peers.
	PolicySameNamespace = "platform-operator-allow-same-namespace"
	// PolicyOperator admits the operator's namespace to the vCluster API (container port 8443,
	// behind svc/vcluster:443), which the operator's target check and Pulumi installs use.
	PolicyOperator = "platform-operator-allow-operator"
)

// vclusterAPIPort is the vCluster control plane's container port behind svc/vcluster:443 and
// the vcluster-node-* Services' 10250.
const vclusterAPIPort = 8443

// Labels of the vCluster 0.37.3 chart and syncer. The chart labels the control plane's pods
// app=vcluster,release=<release> (templates/statefulset.yaml) and its own optional policies
// select the synced pods by vcluster.loft.sh/managed-by=<release> (templates/networkpolicy.yaml).
// The syncer also sets vcluster.loft.sh/namespace to a synced pod's virtual namespace and keeps
// its virtual labels, so the CoreDNS the operator deploys keeps k8s-app=kube-dns.
const (
	labelManagedBy        = "vcluster.loft.sh/managed-by"
	labelVirtualNamespace = "vcluster.loft.sh/namespace"
	// labelComponent is the platform's component label; its tenant-auth pods carry
	// component=tenant-auth and are the ones whose egress reaches the issuerUpstream.
	labelComponent = "platform.di-framework.dev/component"
)

var managedBy = map[string]string{"app.kubernetes.io/managed-by": "platform-operator"}

// controlPlanePods selects the vCluster control plane. Synced pods keep their virtual labels, so
// one labelled app=vcluster,release=vcluster inside the instance is told apart by the
// managed-by label the syncer gives every synced pod.
func controlPlanePods() *metav1.LabelSelector {
	return &metav1.LabelSelector{
		MatchLabels: map[string]string{"app": "vcluster", "release": ReleaseName},
		MatchExpressions: []metav1.LabelSelectorRequirement{
			{Key: labelManagedBy, Operator: metav1.LabelSelectorOpDoesNotExist},
		},
	}
}

// syncedPods selects the instance's synced pods, narrowed by extra labels.
func syncedPods(labels map[string]string) *metav1.LabelSelector {
	match := map[string]string{labelManagedBy: ReleaseName}
	for k, v := range labels {
		match[k] = v
	}
	return &metav1.LabelSelector{MatchLabels: match}
}

// ports lists the ports of one protocol.
func ports(protocol corev1.Protocol, numbers ...int32) []networkingv1.NetworkPolicyPort {
	out := make([]networkingv1.NetworkPolicyPort, 0, len(numbers))
	for _, n := range numbers {
		port := intstr.FromInt32(n)
		out = append(out, networkingv1.NetworkPolicyPort{Protocol: &protocol, Port: &port})
	}
	return out
}

// issuerUpstream reads spec.tenantAuth.issuerUpstream (<service>.<namespace>[.svc...]:<port>)
// the way the platform does for the tenant-auth egress: the namespace is the host's second
// label (the platform namespace when there is none), the port defaults to 80, and the pod port
// behind it is added. ok is false without an issuerUpstream or a usable port.
func issuerUpstream(auth *v1alpha1.TenantAuth) (namespace string, issuerPorts []int32, ok bool) {
	if auth == nil || auth.IssuerUpstream == "" {
		return "", nil, false
	}
	host, port, found := strings.Cut(auth.IssuerUpstream, ":")
	namespace = targets.PlatformNamespace
	if labels := strings.Split(host, "."); len(labels) > 1 && labels[1] != "" {
		namespace = labels[1]
	}
	if !found {
		port = "80"
	}
	if n, err := strconv.ParseInt(port, 10, 32); err == nil && n > 0 && n <= 65535 {
		issuerPorts = append(issuerPorts, int32(n))
	}
	if p := auth.IssuerUpstreamPodPort; p != 0 && (len(issuerPorts) == 0 || issuerPorts[0] != p) {
		issuerPorts = append(issuerPorts, p)
	}
	return namespace, issuerPorts, len(issuerPorts) > 0
}

// NetworkPolicies renders the host-namespace policies for one instance, in the order they are
// applied: the narrow allows come before PolicySameNamespace, so an instance whose old
// same-namespace policy admitted every pod of the instance keeps DNS and the API while it is
// narrowed. Synced pods of other instances live in other host namespaces, so they match none of
// the allow rules. Ingress only: egress stays as the platform's synced policies set it (cluster
// DNS on the instance's CoreDNS among it). The gateway's NodePort path is admitted by the
// platform's own synced gateway policy, whose ingress rule has ports but no peers when
// published; NetworkPolicies are additive, so the default deny here doesn't close it.
func NetworkPolicies(hostNamespace, operatorNamespace string, auth *v1alpha1.TenantAuth) []*networkingv1.NetworkPolicy {
	allow := func(name string, pods *metav1.LabelSelector, rules ...networkingv1.NetworkPolicyIngressRule) *networkingv1.NetworkPolicy {
		return &networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: hostNamespace, Labels: managedBy},
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: *pods,
				PolicyTypes: []networkingv1.PolicyType{networkingv1.PolicyTypeIngress},
				Ingress:     rules,
			},
		}
	}
	from := func(pods *metav1.LabelSelector) []networkingv1.NetworkPolicyPeer {
		return []networkingv1.NetworkPolicyPeer{{PodSelector: pods}}
	}
	policies := []*networkingv1.NetworkPolicy{
		allow(PolicyDenyIngress, &metav1.LabelSelector{}),
		allow(PolicyControlPlane, controlPlanePods(), networkingv1.NetworkPolicyIngressRule{
			From: from(syncedPods(nil)), Ports: ports(corev1.ProtocolTCP, vclusterAPIPort),
		}),
		allow(PolicyDNS, syncedPods(map[string]string{"k8s-app": "kube-dns", labelVirtualNamespace: "kube-system"}), networkingv1.NetworkPolicyIngressRule{
			From: from(syncedPods(nil)), Ports: append(ports(corev1.ProtocolUDP, 53), ports(corev1.ProtocolTCP, 53)...),
		}),
	}
	if ns, issuerPorts, ok := issuerUpstream(auth); ok {
		policies = append(policies, allow(PolicyIssuer, syncedPods(map[string]string{labelVirtualNamespace: ns}), networkingv1.NetworkPolicyIngressRule{
			From: from(syncedPods(map[string]string{labelComponent: "tenant-auth"})), Ports: ports(corev1.ProtocolTCP, issuerPorts...),
		}))
	}
	return append(policies,
		allow(PolicySameNamespace, &metav1.LabelSelector{}, networkingv1.NetworkPolicyIngressRule{From: from(controlPlanePods())}),
		allow(PolicyOperator, controlPlanePods(), networkingv1.NetworkPolicyIngressRule{
			From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"kubernetes.io/metadata.name": operatorNamespace},
			}}},
			Ports: ports(corev1.ProtocolTCP, vclusterAPIPort),
		}),
	)
}

// applyNetworkPolicies creates the host-namespace policies, or puts back a deleted or edited
// one, and updates an existing one whose spec changed (an instance created by an older
// operator) in place. An unchanged policy is not written. PolicyIssuer is deleted when the
// instance no longer sets an issuerUpstream.
func (t *Target) applyNetworkPolicies(ctx context.Context, ns string, auth *v1alpha1.TenantAuth) error {
	if t.OperatorNamespace == "" {
		return fmt.Errorf("the operator's namespace is unknown")
	}
	issuer := false
	for _, want := range NetworkPolicies(ns, t.OperatorNamespace, auth) {
		issuer = issuer || want.Name == PolicyIssuer
		np := &networkingv1.NetworkPolicy{ObjectMeta: metav1.ObjectMeta{Name: want.Name, Namespace: ns}}
		if _, err := controllerutil.CreateOrUpdate(ctx, t.Client, np, func() error {
			if np.Labels == nil {
				np.Labels = map[string]string{}
			}
			for k, v := range want.Labels {
				np.Labels[k] = v
			}
			np.Spec = want.Spec
			return nil
		}); err != nil {
			return fmt.Errorf("network policy %s/%s: %w", ns, want.Name, err)
		}
	}
	if issuer {
		return nil
	}
	stale := &networkingv1.NetworkPolicy{}
	err := t.Client.Get(ctx, client.ObjectKey{Namespace: ns, Name: PolicyIssuer}, stale)
	if err == nil {
		err = t.Client.Delete(ctx, stale)
	}
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("network policy %s/%s: %w", ns, PolicyIssuer, err)
	}
	return nil
}
