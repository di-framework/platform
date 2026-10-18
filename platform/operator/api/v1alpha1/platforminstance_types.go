// Package v1alpha1 is the PlatformInstance API: one isolated copy of the di-framework platform.
// +kubebuilder:object:generate=true
// +groupName=platform.di-framework.dev
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

// GroupVersion is the API group and version of PlatformInstance.
var GroupVersion = schema.GroupVersion{Group: "platform.di-framework.dev", Version: "v1alpha1"}

var (
	// SchemeBuilder registers the PlatformInstance types.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	// AddToScheme adds the PlatformInstance types to a scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)

// TargetType names the kind of cluster an instance runs in.
// +kubebuilder:validation:Enum=vcluster
type TargetType string

// TargetVCluster runs the instance in a vCluster on the operator's own cluster.
const TargetVCluster TargetType = "vcluster"

// DeletionPolicy says what happens to an instance's cluster and data when the
// PlatformInstance is deleted.
// +kubebuilder:validation:Enum=Delete;Retain
type DeletionPolicy string

const (
	// DeletionDelete uninstalls the platform and deletes the target cluster and its data.
	DeletionDelete DeletionPolicy = "Delete"
	// DeletionRetain removes the PlatformInstance but keeps the target cluster, its data and
	// the install state, so a PlatformInstance with the same name picks them up again.
	DeletionRetain DeletionPolicy = "Retain"
)

// NetworkPolicyEngine is the platform's networkPolicyEngine setting.
// +kubebuilder:validation:Enum=existing;kube-router
type NetworkPolicyEngine string

// PlatformInstanceSpec is the desired platform instance.
type PlatformInstanceSpec struct {
	// Version is the exact @di-framework/platform package version to install, for example 6.0.17.
	// +kubebuilder:validation:Pattern=`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`
	Version string `json:"version"`

	// Target is where the instance runs.
	Target TargetSpec `json:"target"`

	// Platform holds the platform settings the operator passes to the install.
	// +optional
	Platform PlatformSettings `json:"platform,omitempty"`

	// DeletionPolicy is Delete (default) or Retain.
	// +kubebuilder:default=Delete
	// +optional
	DeletionPolicy DeletionPolicy `json:"deletionPolicy,omitempty"`
}

// TargetSpec selects the target cluster. The vCluster chart version is the operator's pinned,
// embedded chart; it moves with operator releases.
type TargetSpec struct {
	// Type is the target kind. Only vcluster is supported in v1alpha1.
	Type TargetType `json:"type"`
}

// PlatformSettings are the platform install settings an instance owner may choose.
type PlatformSettings struct {
	// NetworkPolicyEngine is existing (default: the target enforces NetworkPolicy) or
	// kube-router (the platform runs its own policy controller).
	// +kubebuilder:default=existing
	// +optional
	NetworkPolicyEngine NetworkPolicyEngine `json:"networkPolicyEngine,omitempty"`

	// StorageRoot is the node path under which the platform keeps tenant data. Empty uses the
	// operator's per-instance default.
	// +optional
	StorageRoot string `json:"storageRoot,omitempty"`

	// Gateway configures the platform HTTP gateway.
	// +optional
	Gateway GatewaySettings `json:"gateway,omitempty"`
}

// GatewaySettings configures the platform HTTP gateway.
type GatewaySettings struct {
	// HTTPNodePort publishes the gateway on this NodePort. Zero (default) keeps it ClusterIP.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=32767
	// +optional
	HTTPNodePort int32 `json:"httpNodePort,omitempty"`
}

// Phase is the instance's coarse lifecycle state.
// +kubebuilder:validation:Enum=Pending;Provisioning;Installing;Ready;Failed;Deleting
type Phase string

const (
	PhasePending      Phase = "Pending"
	PhaseProvisioning Phase = "Provisioning"
	PhaseInstalling   Phase = "Installing"
	PhaseReady        Phase = "Ready"
	PhaseFailed       Phase = "Failed"
	PhaseDeleting     Phase = "Deleting"
)

// Condition types reported in status.conditions.
const (
	// ConditionTargetReady is True once the target cluster answers with a kubeconfig.
	ConditionTargetReady = "TargetReady"
	// ConditionInstalled is True once the platform at spec.version is installed.
	ConditionInstalled = "Installed"
	// ConditionReady is True when the instance is usable at spec.version.
	ConditionReady = "Ready"
)

// PlatformInstanceStatus is the observed state of an instance.
type PlatformInstanceStatus struct {
	// ObservedGeneration is the generation the status describes.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Phase is the coarse lifecycle state.
	// +optional
	Phase Phase `json:"phase,omitempty"`

	// InstalledVersion is the platform version the last successful install applied.
	// +optional
	InstalledVersion string `json:"installedVersion,omitempty"`

	// Endpoints are the instance's published URLs, from the install's outputs.
	// +optional
	Endpoints Endpoints `json:"endpoints,omitempty"`

	// KubeconfigSecretRef names the Secret, in the PlatformInstance's namespace, that holds the
	// instance's admin kubeconfig under the key "kubeconfig".
	// +optional
	KubeconfigSecretRef *SecretReference `json:"kubeconfigSecretRef,omitempty"`

	// LastRepair is when the last periodic refresh and up finished.
	// +optional
	LastRepair *metav1.Time `json:"lastRepair,omitempty"`

	// Conditions carry readable reasons for each part of the reconcile.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// Endpoints are an instance's published URLs.
type Endpoints struct {
	// +optional
	Kubernetes string `json:"kubernetes,omitempty"`
	// +optional
	HTTP string `json:"http,omitempty"`
}

// SecretReference names a Secret in the PlatformInstance's namespace.
type SecretReference struct {
	Name string `json:"name"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=pi
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
// +kubebuilder:printcolumn:name="Installed",type=string,JSONPath=`.status.installedVersion`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// PlatformInstance is one isolated copy of the di-framework platform.
type PlatformInstance struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PlatformInstanceSpec   `json:"spec,omitempty"`
	Status PlatformInstanceStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// PlatformInstanceList is a list of PlatformInstances.
type PlatformInstanceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PlatformInstance `json:"items"`
}

func init() {
	SchemeBuilder.Register(&PlatformInstance{}, &PlatformInstanceList{})
}
