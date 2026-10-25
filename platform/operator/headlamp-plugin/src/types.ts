/**
 * The PlatformInstance API (platform.di-framework.dev/v1alpha1), mirrored from
 * platform/operator/api/v1alpha1/platforminstance_types.go. Field names and optionality follow the
 * Go JSON tags: every `omitempty` field is optional here.
 */

export const GROUP = 'platform.di-framework.dev';
export const VERSION = 'v1alpha1';
export const API_VERSION = `${GROUP}/${VERSION}`;
export const KIND = 'PlatformInstance';
export const PLURAL = 'platforminstances';

/** The CRD's CEL rule: `self.metadata.name.size() <= 63`. */
export const MAX_NAME_LENGTH = 63;

export const TARGET_TYPES = ['vcluster'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const DELETION_POLICIES = ['Delete', 'Retain'] as const;
export type DeletionPolicy = (typeof DELETION_POLICIES)[number];

export const NETWORK_POLICY_ENGINES = ['existing', 'kube-router'] as const;
export type NetworkPolicyEngine = (typeof NETWORK_POLICY_ENGINES)[number];

export const PHASES = [
  'Pending',
  'Provisioning',
  'Installing',
  'Ready',
  'Failed',
  'Deleting',
] as const;
export type Phase = (typeof PHASES)[number];

/** The condition types the operator reports, in reconcile order. */
export const CONDITION_TYPES = ['TargetReady', 'Installed', 'Ready'] as const;

export interface GatewaySettings {
  httpNodePort?: number;
  httpEndpoint?: string;
}

export interface PlatformSettings {
  networkPolicyEngine?: NetworkPolicyEngine;
  storageRoot?: string;
  gateway?: GatewaySettings;
}

export interface PlatformInstanceSpec {
  version: string;
  target: { type: TargetType };
  platform?: PlatformSettings;
  deletionPolicy?: DeletionPolicy;
}

/** A metav1.Condition. */
export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  lastTransitionTime: string;
  observedGeneration?: number;
}

export interface PlatformInstanceStatus {
  observedGeneration?: number;
  phase?: Phase;
  installedVersion?: string;
  endpoints?: { kubernetes?: string; http?: string };
  kubeconfigSecretRef?: { name: string };
  lastRepair?: string;
  conditions?: Condition[];
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  [key: string]: unknown;
}

/** A PlatformInstance as the API returns it (and as `kubectl get -o yaml` prints it). */
export interface PlatformInstanceObject {
  apiVersion: typeof API_VERSION;
  kind: typeof KIND;
  metadata: ObjectMeta;
  spec: PlatformInstanceSpec;
  status?: PlatformInstanceStatus;
}
