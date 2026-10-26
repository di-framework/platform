package vcluster

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// Host-namespace NetworkPolicies the operator owns in every instance's host namespace (#452).
const (
	// PolicyDenyIngress selects every pod in the host namespace for ingress, with no rule, so
	// only what the other policies (the operator's and those vCluster syncs from inside the
	// instance) allow gets in.
	PolicyDenyIngress = "platform-operator-deny-ingress"
	// PolicySameNamespace admits pods of the same host namespace: the instance's own synced
	// pods, its CoreDNS and its vCluster control plane, which reaches synced pods and serves the
	// kubelet port (10250) of its vcluster-node-* Services.
	PolicySameNamespace = "platform-operator-allow-same-namespace"
	// PolicyOperator admits the operator's namespace to the vCluster API (container port 8443,
	// behind svc/vcluster:443), which the operator's target check and Pulumi installs use.
	PolicyOperator = "platform-operator-allow-operator"
)

// vclusterAPIPort is the vCluster control plane's container port behind svc/vcluster:443.
const vclusterAPIPort = 8443

var managedBy = map[string]string{"app.kubernetes.io/managed-by": "platform-operator"}

// NetworkPolicies renders the host-namespace policies for one instance. Synced pods of other
// instances live in other host namespaces, so they match none of the allow rules. Ingress only:
// egress stays as the platform's synced policies set it (cluster DNS on the host kube-dns among
// it). The gateway's NodePort path is admitted by the platform's own synced gateway policy,
// whose ingress rule has ports but no peers; NetworkPolicies are additive, so the default deny
// here doesn't close it.
func NetworkPolicies(hostNamespace, operatorNamespace string) []*networkingv1.NetworkPolicy {
	tcp := corev1.ProtocolTCP
	api := intstr.FromInt32(vclusterAPIPort)
	meta := func(name string) metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: hostNamespace, Labels: managedBy}
	}
	ingress := []networkingv1.PolicyType{networkingv1.PolicyTypeIngress}
	return []*networkingv1.NetworkPolicy{
		{
			ObjectMeta: meta(PolicyDenyIngress),
			Spec:       networkingv1.NetworkPolicySpec{PodSelector: metav1.LabelSelector{}, PolicyTypes: ingress},
		},
		{
			ObjectMeta: meta(PolicySameNamespace),
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{},
				PolicyTypes: ingress,
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{PodSelector: &metav1.LabelSelector{}}},
				}},
			},
		},
		{
			ObjectMeta: meta(PolicyOperator),
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "vcluster", "release": ReleaseName}},
				PolicyTypes: ingress,
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From: []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{
						MatchLabels: map[string]string{"kubernetes.io/metadata.name": operatorNamespace},
					}}},
					Ports: []networkingv1.NetworkPolicyPort{{Protocol: &tcp, Port: &api}},
				}},
			},
		},
	}
}

// applyNetworkPolicies creates the host-namespace policies, or puts back a deleted or edited
// one. An unchanged policy is not written.
func (t *Target) applyNetworkPolicies(ctx context.Context, ns string) error {
	if t.OperatorNamespace == "" {
		return fmt.Errorf("the operator's namespace is unknown")
	}
	for _, want := range NetworkPolicies(ns, t.OperatorNamespace) {
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
	return nil
}
