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
	// DeletionDelete deletes the target cluster, with the platform and the cluster's own data
	// volume, then removes the operator's default storageRoot from the node. A custom
	// spec.platform.storageRoot is never removed (see the README).
	DeletionDelete DeletionPolicy = "Delete"
	// DeletionRetain removes the PlatformInstance but keeps the target cluster, its data and
	// the install state, so a PlatformInstance with the same name picks them up again.
	DeletionRetain DeletionPolicy = "Retain"
)

// NetworkPolicyEngine is the platform's networkPolicyEngine setting.
// +kubebuilder:validation:Enum=existing;kube-router
type NetworkPolicyEngine string

// PlatformInstanceSpec is the desired platform instance. The target and storageRoot are fixed at
// creation: the operator would otherwise lose track of the cluster and data it made.
// +kubebuilder:validation:XValidation:rule="self.target == oldSelf.target",message="target is immutable"
// +kubebuilder:validation:XValidation:rule="has(self.platform) && has(self.platform.storageRoot) ? has(oldSelf.platform) && has(oldSelf.platform.storageRoot) && oldSelf.platform.storageRoot == self.platform.storageRoot : !(has(oldSelf.platform) && has(oldSelf.platform.storageRoot))",message="platform.storageRoot is immutable"
// +kubebuilder:validation:XValidation:rule="has(self.platform) && has(self.platform.tenantHostImage) ? has(oldSelf.platform) && has(oldSelf.platform.tenantHostImage) && oldSelf.platform.tenantHostImage == self.platform.tenantHostImage : !(has(oldSelf.platform) && has(oldSelf.platform.tenantHostImage))",message="platform.tenantHostImage is immutable in v1alpha1: it is fixed at creation (empty uses the operator's pinned exclusive host image)"
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
// +kubebuilder:validation:XValidation:rule="!has(self.users) || self.users.all(u, u.memberships.all(m, has(self.tenants) && self.tenants.exists(t, t.name == m.tenant)))",message="every users[].memberships[].tenant must name an entry of tenants"
type PlatformSettings struct {
	// NetworkPolicyEngine is existing (default: the target enforces NetworkPolicy) or
	// kube-router (the platform runs its own policy controller).
	// +kubebuilder:default=existing
	// +optional
	NetworkPolicyEngine NetworkPolicyEngine `json:"networkPolicyEngine,omitempty"`

	// StorageRoot is the node path under which the platform keeps tenant data. Empty uses the
	// operator's per-instance default, which deletionPolicy Delete removes. The operator didn't
	// create a path set here, so it never removes it.
	// +optional
	StorageRoot string `json:"storageRoot,omitempty"`

	// Gateway configures the platform HTTP gateway.
	// +optional
	Gateway GatewaySettings `json:"gateway,omitempty"`

	// Tenants are the platform's tenants (its `tenants` config). A change on a Ready instance is
	// applied by the install the spec change starts.
	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=32
	// +optional
	Tenants []Tenant `json:"tenants,omitempty"`

	// Users are the platform's users and their tenant memberships (its `users` config).
	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=128
	// +optional
	Users []User `json:"users,omitempty"`

	// TenantAuth enables the per-tenant console and /v1 API against an OIDC issuer (the
	// platform's `tenantAuth` config). Unset, tenants get no console.
	// +optional
	TenantAuth *TenantAuth `json:"tenantAuth,omitempty"`

	// TenantHostImage is the platform's `tenantHostImage`. Empty uses the operator's pinned
	// exclusive host variant (ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive by digest), which
	// the PGlite exclusive-PGDATA workloads need. Fixed at creation.
	// +kubebuilder:validation:Pattern=`^[^\s@]+(@sha256:[0-9a-f]{64})?$`
	// +kubebuilder:validation:MaxLength=512
	// +optional
	TenantHostImage string `json:"tenantHostImage,omitempty"`

	// TenantHostImagePullPolicy is the platform's `tenantHostImagePullPolicy` (the platform
	// defaults to IfNotPresent).
	// +kubebuilder:validation:Enum=Always;IfNotPresent;Never
	// +optional
	TenantHostImagePullPolicy string `json:"tenantHostImagePullPolicy,omitempty"`
}

// Tenant is one entry of the platform's `tenants` config.
type Tenant struct {
	// Name is 1-40 lowercase letters, digits and hyphens, starting with a letter.
	// +kubebuilder:validation:MaxLength=40
	// +kubebuilder:validation:Pattern=`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`
	Name string `json:"name"`

	// Suspended suspends the tenant.
	// +optional
	Suspended bool `json:"suspended,omitempty"`

	// DeletionPolicy is what removing the tenant does to its data: Retain or Delete (the
	// platform's default applies when unset).
	// +kubebuilder:validation:Enum=Retain;Delete
	// +optional
	DeletionPolicy string `json:"deletionPolicy,omitempty"`

	// Runtime sizes the tenant's hosts.
	// +optional
	Runtime *TenantRuntime `json:"runtime,omitempty"`

	// Resources are the tenant's quotas.
	// +optional
	Resources *TenantResources `json:"resources,omitempty"`
}

// TenantRuntime is a tenant's `runtime`.
type TenantRuntime struct {
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=10
	// +optional
	Replicas *int32 `json:"replicas,omitempty"`
	// CoreInstances is WASH_CORE_INSTANCES for the tenant host (platform default 100).
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=10000
	// +optional
	CoreInstances *int32 `json:"coreInstances,omitempty"`
}

// TenantResources is a tenant's `resources`.
type TenantResources struct {
	// The bounds are the platform Tenant CRD's.
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$`
	// +optional
	CPU string `json:"cpu,omitempty"`
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[0-9]+(\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$`
	// +optional
	Memory string `json:"memory,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=1000
	// +optional
	Workloads *int32 `json:"workloads,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=100
	// +optional
	BackingServices *int32 `json:"backingServices,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=400
	// +optional
	ServiceBindings *int32 `json:"serviceBindings,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=10000
	// +optional
	APIKeys *int32 `json:"apiKeys,omitempty"`
}

// User is one entry of the platform's `users` config.
type User struct {
	// Name is 1-40 lowercase letters, digits and hyphens, starting with a letter.
	// +kubebuilder:validation:MaxLength=40
	// +kubebuilder:validation:Pattern=`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`
	Name string `json:"name"`

	// Suspended blocks the user's access.
	// +optional
	Suspended bool `json:"suspended,omitempty"`

	// Memberships are the tenants the user belongs to, one entry per tenant.
	// +listType=map
	// +listMapKey=tenant
	// +kubebuilder:validation:MaxItems=16
	Memberships []Membership `json:"memberships"`
}

// MembershipRole is a user's role in a tenant.
// +kubebuilder:validation:Enum=developer;viewer
type MembershipRole string

// Membership puts a user in a tenant.
type Membership struct {
	// Tenant names an entry of spec.platform.tenants.
	// +kubebuilder:validation:MaxLength=40
	Tenant string         `json:"tenant"`
	Role   MembershipRole `json:"role"`
}

// TenantAuth is the platform's `tenantAuth` config, with the OAuth client secret read from a
// Secret instead of inline. The operator copies the secret into the target's platform namespace
// and points tenantAuth.oauthClient.secretName at the copy.
// +kubebuilder:validation:XValidation:rule="has(self.issuer) && has(self.clientId) && has(self.clientSecretRef)",message="tenantAuth needs issuer, clientId and clientSecretRef together"
type TenantAuth struct {
	// Image is the tenant-auth image, pinned by digest (<repository>@sha256:<digest>).
	// +kubebuilder:validation:Pattern=`^[^@\s]+@sha256:[0-9a-f]{64}$`
	// +kubebuilder:validation:MaxLength=512
	Image string `json:"image"`

	// Issuer is the OIDC issuer URL, as both pods and browsers name it.
	// +kubebuilder:validation:Pattern=`^https?://`
	// +kubebuilder:validation:MaxLength=2048
	// +optional
	Issuer string `json:"issuer,omitempty"`

	// ClientID is the console's confidential OAuth client (oauthClient.id).
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +optional
	ClientID string `json:"clientId,omitempty"`

	// ClientSecretRef names the Secret, in the PlatformInstance's namespace, and its key that
	// hold the OAuth client secret.
	// +optional
	ClientSecretRef *SecretKeyReference `json:"clientSecretRef,omitempty"`

	// IssuerUpstream is the in-cluster <service>.<namespace>[.svc...]:<port> a sidecar forwards a
	// loopback issuer's port to.
	// +kubebuilder:validation:MaxLength=512
	// +optional
	IssuerUpstream string `json:"issuerUpstream,omitempty"`

	// IssuerUpstreamPodPort is the pod port behind issuerUpstream.
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	// +optional
	IssuerUpstreamPodPort int32 `json:"issuerUpstreamPodPort,omitempty"`

	// IssuerIP is the issuer's IPv4 when pods cannot resolve its hostname.
	// +kubebuilder:validation:MaxLength=15
	// +optional
	IssuerIP string `json:"issuerIp,omitempty"`

	// ConsolePublicURL is the browser-visible console URL; {tenant} is replaced.
	// +kubebuilder:validation:Pattern=`^https?://`
	// +kubebuilder:validation:MaxLength=2048
	// +optional
	ConsolePublicURL string `json:"consolePublicUrl,omitempty"`

	// ControllerPublicURL is the controller URL shown to users and CLIs; {tenant} is replaced.
	// +kubebuilder:validation:Pattern=`^https?://`
	// +kubebuilder:validation:MaxLength=2048
	// +optional
	ControllerPublicURL string `json:"controllerPublicUrl,omitempty"`

	// Registry deploys each tenant's own OCI registry.
	// +optional
	Registry *TenantRegistry `json:"registry,omitempty"`
}

// SecretKeyReference names a key of a Secret in the PlatformInstance's namespace.
type SecretKeyReference struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	Name string `json:"name"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	Key string `json:"key"`
}

// TenantRegistry is tenantAuth.registry.
type TenantRegistry struct {
	// Component is the oci-registry component, pinned by digest.
	// +kubebuilder:validation:Pattern=`^[^@\s]+@sha256:[0-9a-f]{64}$`
	// +kubebuilder:validation:MaxLength=512
	Component string `json:"component"`

	// PublicURL is the registry origin users log in to; {tenant} is replaced.
	// +kubebuilder:validation:Pattern=`^https?://`
	// +kubebuilder:validation:MaxLength=2048
	// +optional
	PublicURL string `json:"publicUrl,omitempty"`

	// Limits bound the controller's registry front.
	// +optional
	Limits *TenantRegistryLimits `json:"limits,omitempty"`
}

// TenantRegistryLimits are tenantAuth.registry.limits; each a positive integer.
type TenantRegistryLimits struct {
	// +kubebuilder:validation:Minimum=1
	// +optional
	MaxBodyBytes *int64 `json:"maxBodyBytes,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +optional
	UpstreamTimeoutMs *int64 `json:"upstreamTimeoutMs,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +optional
	MaxConcurrent *int64 `json:"maxConcurrent,omitempty"`
	// +kubebuilder:validation:Minimum=1
	// +optional
	UploadIdleTimeoutMs *int64 `json:"uploadIdleTimeoutMs,omitempty"`
}

// GatewaySettings configures the platform HTTP gateway.
type GatewaySettings struct {
	// HTTPNodePort publishes the gateway on this NodePort. Zero (default) keeps it ClusterIP.
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=32767
	// +optional
	HTTPNodePort int32 `json:"httpNodePort,omitempty"`

	// HTTPEndpoint is the gateway's public base URL, for example http://apps.example:30080. The
	// platform derives route URLs from it, and status.endpoints.http reports it. The operator
	// can't know how the gateway is reached from outside, so it is set here.
	// +kubebuilder:validation:Pattern=`^https?://`
	// +optional
	HTTPEndpoint string `json:"httpEndpoint,omitempty"`
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
	// ConditionConfigApplied is True once an install applied the spec's platform settings
	// (tenants, users, tenantAuth, tenant host image) of the generation status.applied names.
	ConditionConfigApplied = "ConfigApplied"
)

// ReasonTenantAuthSecret (on Installed) reports that spec.platform.tenantAuth.clientSecretRef
// names a Secret or key that can't be read. The operator doesn't install until it can.
const ReasonTenantAuthSecret = "TenantAuthSecretUnavailable"

// ReasonStorageCleanupFailed (on Installed) reports that removing the default storageRoot after a
// Delete failed. The finalizer stays until a retry succeeds, the instance is annotated with
// AnnotationSkipStorageCleanup, or its deletionPolicy is set to Retain.
const ReasonStorageCleanupFailed = "StorageCleanupFailed"

// ReasonInvalidStorageRoot (on Installed) reports a custom spec.platform.storageRoot that overlaps
// the operator's --storage-root-base. The operator doesn't install it.
const ReasonInvalidStorageRoot = "InvalidStorageRoot"

// AnnotationSkipStorageCleanup set to "true" on a PlatformInstance makes deletionPolicy Delete
// leave the default storageRoot on the node, for example when the node can't run the cleanup.
const AnnotationSkipStorageCleanup = "platform.di-framework.dev/skip-storage-cleanup"

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

	// Applied summarizes the platform settings the last successful install applied.
	// +optional
	Applied *AppliedConfig `json:"applied,omitempty"`

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

// AppliedConfig is what the last successful install applied.
type AppliedConfig struct {
	// Generation is the metadata.generation whose settings were applied.
	Generation int64 `json:"generation"`
	// Tenants is the number of applied tenants.
	Tenants int32 `json:"tenants"`
	// Users is the number of applied users.
	Users int32 `json:"users"`
	// TenantAuthIssuer is the applied tenantAuth issuer; empty without tenantAuth.
	// +optional
	TenantAuthIssuer string `json:"tenantAuthIssuer,omitempty"`
	// TenantHostImage is the applied tenant host image.
	// +optional
	TenantHostImage string `json:"tenantHostImage,omitempty"`
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
// +kubebuilder:validation:XValidation:rule="self.metadata.name.size() <= 63",message="name must be at most 63 characters"
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
