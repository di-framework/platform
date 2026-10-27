package vcluster

import (
	"context"
	"fmt"
	"strconv"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// HostNamespaceLabel marks an instance host namespace. The admission policy that protects
// service/vcluster selects namespaces by it.
const HostNamespaceLabel = "platform.di-framework.dev/host-namespace"

// AdmissionPolicyName names the cluster-scoped ValidatingAdmissionPolicy and its binding.
const AdmissionPolicyName = "platform-operator-protect-vcluster-service"

// DeniedMessage is what a refused delete of service/vcluster reports.
const DeniedMessage = "service/vcluster owns every object vCluster syncs into this host namespace; " +
	"deleting it garbage-collects the instance's pods, Secrets and ConfigMaps " +
	"(see https://github.com/di-framework/platform/issues/466). Delete the PlatformInstance instead."

// AdmissionExpression is the CEL rule the policy enforces: a DELETE of a Service is allowed
// unless it is service/vcluster, and even then when the operator sends it (helm uninstall while
// the instance is deleted) or its namespace is terminating (the namespace controller removes
// the namespace's contents).
func AdmissionExpression(operatorUsername string) string {
	return "oldObject.metadata.name != " + strconv.Quote(ReleaseName) +
		" || request.userInfo.username == " + strconv.Quote(operatorUsername) +
		" || has(namespaceObject.metadata.deletionTimestamp)"
}

// AdmissionPolicy renders the policy and its binding. The binding applies it to the namespaces
// labelled HostNamespaceLabel=true.
func AdmissionPolicy(operatorUsername string) (*admissionregistrationv1.ValidatingAdmissionPolicy, *admissionregistrationv1.ValidatingAdmissionPolicyBinding) {
	// The defaults the API server fills in are set here, so an unchanged policy isn't rewritten
	// every round.
	fail := admissionregistrationv1.Fail
	equivalent := admissionregistrationv1.Equivalent
	anyScope := admissionregistrationv1.AllScopes
	forbidden := metav1.StatusReasonForbidden
	policy := &admissionregistrationv1.ValidatingAdmissionPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: AdmissionPolicyName, Labels: managedBy},
		Spec: admissionregistrationv1.ValidatingAdmissionPolicySpec{
			FailurePolicy: &fail,
			MatchConstraints: &admissionregistrationv1.MatchResources{
				MatchPolicy:       &equivalent,
				NamespaceSelector: &metav1.LabelSelector{},
				ObjectSelector:    &metav1.LabelSelector{},
				ResourceRules: []admissionregistrationv1.NamedRuleWithOperations{{
					RuleWithOperations: admissionregistrationv1.RuleWithOperations{
						Operations: []admissionregistrationv1.OperationType{admissionregistrationv1.Delete},
						Rule: admissionregistrationv1.Rule{
							APIGroups:   []string{""},
							APIVersions: []string{"v1"},
							Resources:   []string{"services"},
							Scope:       &anyScope,
						},
					},
				}},
			},
			Validations: []admissionregistrationv1.Validation{{
				Expression: AdmissionExpression(operatorUsername),
				Message:    DeniedMessage,
				Reason:     &forbidden,
			}},
		},
	}
	binding := &admissionregistrationv1.ValidatingAdmissionPolicyBinding{
		ObjectMeta: metav1.ObjectMeta{Name: AdmissionPolicyName, Labels: managedBy},
		Spec: admissionregistrationv1.ValidatingAdmissionPolicyBindingSpec{
			PolicyName: AdmissionPolicyName,
			MatchResources: &admissionregistrationv1.MatchResources{
				MatchPolicy:       &equivalent,
				ObjectSelector:    &metav1.LabelSelector{},
				NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{HostNamespaceLabel: "true"}},
			},
			ValidationActions: []admissionregistrationv1.ValidationAction{admissionregistrationv1.Deny},
		},
	}
	return policy, binding
}

// applyAdmissionPolicy creates the policy and its binding, or puts back a deleted or edited one.
func (t *Target) applyAdmissionPolicy(ctx context.Context) error {
	if t.OperatorUsername == "" {
		return fmt.Errorf("the operator's username is unknown")
	}
	wantPolicy, wantBinding := AdmissionPolicy(t.OperatorUsername)
	policy := &admissionregistrationv1.ValidatingAdmissionPolicy{ObjectMeta: metav1.ObjectMeta{Name: wantPolicy.Name}}
	if _, err := controllerutil.CreateOrUpdate(ctx, t.Client, policy, func() error {
		policy.Labels = mergeLabels(policy.Labels, wantPolicy.Labels)
		policy.Spec = wantPolicy.Spec
		return nil
	}); err != nil {
		return fmt.Errorf("validating admission policy %s: %w", wantPolicy.Name, err)
	}
	binding := &admissionregistrationv1.ValidatingAdmissionPolicyBinding{ObjectMeta: metav1.ObjectMeta{Name: wantBinding.Name}}
	if _, err := controllerutil.CreateOrUpdate(ctx, t.Client, binding, func() error {
		binding.Labels = mergeLabels(binding.Labels, wantBinding.Labels)
		binding.Spec = wantBinding.Spec
		return nil
	}); err != nil {
		return fmt.Errorf("validating admission policy binding %s: %w", wantBinding.Name, err)
	}
	return nil
}

func mergeLabels(have, want map[string]string) map[string]string {
	if have == nil {
		have = map[string]string{}
	}
	for k, v := range want {
		have[k] = v
	}
	return have
}
