import { createHash } from 'node:crypto';
import { API_KEYS_LIMITS, apiKeysNamespace, DEFAULT_API_KEYS } from './api-keys';
import { backingServiceCrds, DELETION_POLICIES } from './backing-services';
import { PRIVATE_IPV4_RANGES } from './egress';
import {
  JETSTREAM_ACCOUNT_INIT_SCRIPT,
  NATS_BOX_IMAGE,
  natsAccountsConfig,
  REGISTRY_NATS_AUTH_ANNOTATION,
  REGISTRY_NATS_MIGRATION,
  REGISTRY_NATS_MIGRATION_COMPONENT,
  REGISTRY_NATS_MIGRATION_DEADLINE_SECONDS,
  REGISTRY_NATS_MIGRATION_JOB,
  REGISTRY_NATS_MIGRATION_LIMITS,
  REGISTRY_NATS_MIGRATION_SCRIPT,
  REGISTRY_NATS_MOUNT,
  REGISTRY_NATS_PASSWORD_ENV,
  REGISTRY_NATS_PASSWORD_FILE,
  REGISTRY_NATS_SECRET,
  REGISTRY_NATS_USER_FILE,
  REGISTRY_NATS_VOLUME,
  registryNatsAuthDigest,
  registryNatsSecretData,
} from './registry-nats';
import { hostStorage } from './workload-storage';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
export interface Metadata {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
  deletionTimestamp?: string;
}
export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  observedGeneration: number;
  lastTransitionTime: string;
}
export interface TenantSpec {
  suspended?: boolean;
  deletionPolicy?: 'Retain' | 'Delete';
  runtime?: {
    replicas?: number;
    /** `WASH_CORE_INSTANCES` for the tenant host (default 100, 1–10000). Changing it rolls the host. */
    coreInstances?: number;
  };
  resources?: {
    cpu?: string;
    memory?: string;
    workloads?: number;
    /** Max concurrent BackingService objects in the tenant namespace (default 10). */
    backingServices?: number;
    /** Max concurrent ServiceBinding objects in the tenant namespace (default 40). */
    serviceBindings?: number;
    /** Max API keys of the tenant: `count/secrets` in `di-apikeys-<tenant>` (default 1000, #379). */
    apiKeys?: number;
  };
}
export const CORE_INSTANCES = { default: 100, minimum: 1, maximum: 10000 } as const;
export interface UserSpec {
  suspended?: boolean;
  memberships: { tenant: string; role: 'developer' | 'viewer' }[];
}
export interface CustomResource<S> {
  apiVersion: string;
  kind: 'Tenant' | 'User';
  metadata: Metadata;
  spec: S;
  status?: { conditions?: Condition[]; observedGeneration?: number; [key: string]: unknown };
}
export type Tenant = CustomResource<TenantSpec>;
export type User = CustomResource<UserSpec>;
export interface Resource {
  apiVersion: string;
  kind: string;
  metadata: Metadata;
  [key: string]: unknown;
}
export interface ControllerConfig {
  installation: string;
  namespace: string;
  hostImage: string;
  hostImagePullPolicy?: string;
  schedulerNatsUrl: string;
  /**
   * Exact `host[:port]` registries tenant hosts pull from over plain HTTP, one
   * `--insecure-registry` each (wash patch 0002): the platform registry on local installs. Every
   * other pull, the tenant registry's pull listener included, stays TLS.
   */
  insecureRegistries?: string[];
  storageRoot?: string;
  /** `http://{host}.{tenant}.localhost:<port>` when the platform gateway is published. */
  routeUrlPattern?: string;
  /** The per-tenant controller and console (#58); absent, the reconcile deploys neither. */
  tenantAuth?: TenantAuthConfig;
  /**
   * Whether `tenantAuth.image` is a published build known to read API keys from
   * `di-apikeys-<tenant>` (`API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS`, #379). Absent or false, keys
   * stay in the runtime namespace.
   */
  tenantAuthReadsApiKeyNamespace?: boolean;
  /** JetStream storage caps of each tenant's `di-nats` (#160); absent, the defaults apply. */
  runtimeNats?: RuntimeNatsConfig;
}
/**
 * JetStream storage caps of each tenant's runtime data-plane NATS (`di-nats`), rendered as
 * `max_file_store` and `max_memory_store` in its server config. Each is a binary quantity: a
 * positive integer count of bytes, optionally suffixed `Ki`, `Mi`, `Gi` or `Ti`.
 */
export interface RuntimeNatsConfig {
  /** JetStream file storage on the tenant's host path (default `10Gi`). */
  maxFileStore?: string;
  /**
   * JetStream memory storage (default `32Mi`); at most `64Mi`, half the 128Mi container limit,
   * leaving the rest as headroom for nats-server itself.
   */
  maxMemoryStore?: string;
}
/**
 * Platform-level settings for each tenant's controller and console. The runtime env contract is
 * the one frozen in `platform/tenant-auth/README.md`.
 */
export interface TenantAuthConfig {
  /** `ghcr.io/di-framework/tenant-auth@sha256:<digest>`; always pinned by digest. */
  image: string;
  /** identity-server issuer URL, as both pods and browsers name it. */
  issuer: string;
  /**
   * Until per-tenant clients (#59), every console shares one confidential OAuth client. Its
   * secret lives in a Secret in the platform namespace that the reconcile copies into each
   * tenant's runtime namespace; the controller never reads the identity directory.
   */
  oauthClient: { id: string; secretName: string; secretKey?: string };
  /**
   * For a loopback issuer (`localhost`, `*.localhost`, `127.0.0.1`): the in-cluster
   * `<service>.<namespace>[.svc...]:<port>` a sidecar forwards the issuer port to.
   */
  issuerUpstream?: string;
  /** The pod port behind `issuerUpstream` (NetworkPolicy matches it after DNAT). */
  issuerUpstreamPodPort?: number;
  /** The issuer's IPv4 when pods cannot resolve its hostname. */
  issuerIp?: string;
  /**
   * Browser-visible console URL; `{tenant}` is replaced. Unset, `createPlatform` derives
   * `http://console.{tenant}.localhost:<port>` from an `http://{host}.{tenant}.localhost`
   * `routeUrlPattern` ({@link withDerivedPublicUrls}); otherwise `http://127.0.0.1:8787`.
   */
  consolePublicUrl?: string;
  /**
   * Controller URL shown to users and CLIs; `{tenant}` is replaced. Unset, `createPlatform`
   * derives `https://controller.{tenant}.localhost:<port>` from an
   * `http://{host}.{tenant}.localhost` `routeUrlPattern`; otherwise `https://127.0.0.1:8788`.
   */
  controllerPublicUrl?: string;
  /** Each tenant's own OCI registry (#83); absent, no registry is deployed. */
  registry?: TenantRegistryConfig;
}
/**
 * The per-tenant registry: the `platform/oci-registry` component, run as a WorkloadDeployment on
 * the tenant's own hosts and backed by their data-plane blobstore. Its whoami callback goes to
 * the controller's whoami listener over TLS (#113); users reach it through the controller's TLS
 * registry front.
 */
export interface TenantRegistryConfig {
  /** `ghcr.io/di-framework/oci-registry@sha256:<digest>`; always pinned by digest. */
  component: string;
  /**
   * Registry origin users log in to; `{tenant}` is replaced. `https://<label>.{tenant}.localhost:<port>`
   * on the gateway port is routed through the gateway (TLS passthrough to the registry front).
   * Unset, `createPlatform` derives `https://registry.{tenant}.localhost:<port>` from an
   * `http://{host}.{tenant}.localhost` `routeUrlPattern`; otherwise `https://127.0.0.1:8790`, a
   * port-forward to the registry front.
   */
  publicUrl?: string;
  /**
   * Bounds of the controller's registry front, each optional (the controller's default applies):
   * rendered as `TENANT_CONTROLLER_REGISTRY_MAX_BODY_BYTES`, `_UPSTREAM_TIMEOUT_MS`,
   * `_MAX_CONCURRENT` and `_UPLOAD_IDLE_TIMEOUT_MS` on the controller Deployment.
   */
  limits?: TenantRegistryLimits;
}
/** Registry front bounds (S6 of the #83 review); positive integers. */
export interface TenantRegistryLimits {
  /** Largest request body, in bytes (default 512 MiB). */
  maxBodyBytes?: number;
  /** Wait for the registry's response headers once the request body is sent, in ms (default 60000). */
  upstreamTimeoutMs?: number;
  /** Registry requests in flight at once (default 16). */
  maxConcurrent?: number;
  /** How long an upload may deliver no byte before it is cut off, in ms (default 60000). */
  uploadIdleTimeoutMs?: number;
}
/**
 * The controller's listener serving only `GET /v1/auth/whoami` (#83): TLS with the controller
 * certificate (#113), and plain HTTP on the same port for a registry whose config still names
 * `http://` during an upgrade.
 */
export const WHOAMI_PORT = 8789;
/** The controller's TLS front for the tenant registry (#83). */
export const REGISTRY_FRONT_PORT = 8790;
/** The registry WorkloadDeployment in each tenant namespace. */
export const REGISTRY_WORKLOAD = 'di-tenant-registry';
const DEFAULT_REGISTRY_URL = `https://127.0.0.1:${REGISTRY_FRONT_PORT}`;
/**
 * The controller's pull-only listener for the tenant's own hosts (#83 `:host-pull`): GET and HEAD
 * forwarded like the registry front, always TLS with the controller certificate. Tenant hosts
 * allow plain HTTP only for the registries in `insecureRegistries` (#149), never this one.
 */
export const REGISTRY_PULL_PORT = 8791;
/** The Service hosts pull through: `<REGISTRY_PULL_SERVICE>.di-runtime-<tenant>.svc`. */
export const REGISTRY_PULL_SERVICE = 'tenant-registry';
/**
 * The host pull credential (#83 `:host-pull`) in `di-runtime-<tenant>`: `token`, which the
 * controller's whoami listener accepts as a pull-only (viewer) principal, and `config.json`, the
 * Docker config wash reads it from. Generated by the platform controller; delete it to rotate.
 */
export const REGISTRY_PULL_SECRET = 'di-tenant-registry-pull';
/** The Basic username in the host's Docker config; the registry ignores it. */
const REGISTRY_PULL_USER = 'tenant-host';
/**
 * The registry host workload references use: the in-cluster pull Service, without a port (443,
 * TLS).
 */
export function registryPullHost(tenant: string): string {
  return `${REGISTRY_PULL_SERVICE}.${names(tenant).runtimeNamespace}.svc`;
}
/**
 * The name the tenant registry calls the controller's whoami listener by (#113): the controller
 * Service in the runtime namespace, which {@link tenantControllerCertNames} always covers.
 */
export function registryWhoamiHost(tenant: string): string {
  return `tenant-controller.${names(tenant).runtimeNamespace}.svc`;
}
/** The host pull Secret's data (base64): the token and the Docker config naming {@link registryPullHost}. */
export function registryPullSecretData(tenant: string, token: string): Record<string, string> {
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  const config = {
    auths: { [registryPullHost(tenant)]: { auth: base64(`${REGISTRY_PULL_USER}:${token}`) } },
  };
  return { token: base64(token), 'config.json': base64(JSON.stringify(config)) };
}
/**
 * One membership in the tenant, as {@link TENANT_MEMBERS_CONFIG} publishes it (#321). A suspended
 * member is listed with `suspended: true` and gets no access.
 */
export interface TenantMember {
  name: string;
  role: 'developer' | 'viewer';
  suspended: boolean;
}
/** Facts the controller gathers from the cluster for {@link tenantAuthResources}. */
export interface TenantAuthInputs {
  /**
   * The tenant's memberships, suspended ones included. Only the active members' names reach the
   * RBAC: each may mint tokens for `di-user-<name>`.
   */
  members: TenantMember[];
  /** API server endpoint addresses and port (the `kubernetes` EndpointSlice). */
  apiServer: { addresses: string[]; port: number };
  /**
   * The controller's serving leaf certificate and key, the CA certificate that issued it and the
   * CA key (PEM). During a CA rotation (#170) `caNext` is the successor that does not sign yet and
   * `caPrevious` the CA that `caCert` replaced; clients trust all of them (see
   * `controllerTrustBundle`).
   * The CA keys are kept in a platform-namespace Secret nothing mounts.
   */
  tls: {
    cert: string;
    key: string;
    caCert: string;
    caKey: string;
    caNext?: { cert: string; key: string };
    caPrevious?: string;
  };
  /** The shared OAuth client secret, base64 as read from the platform Secret; absent until it exists. */
  clientSecret?: string;
  /**
   * Whether the registry front may forward to the registry (W4/W6 of the #83 review): true only
   * when the tenant is not suspended and no other workload claims the registry host. Registry
   * readiness is deliberately not part of it, so it never changes the controller's pod template.
   * Otherwise the controller is rendered without the front listener, so credentials are never
   * sent to the tenant hosts.
   */
  registryServing?: boolean;
  /**
   * The host pull token (#83 `:host-pull`), kept from the existing `di-tenant-registry-pull`
   * Secret or newly generated; absent, no pull Secret is rendered.
   */
  hostPullToken?: string;
  /**
   * The registry's NATS account (#159): `stopped` from the moment the controller stops the
   * registry for the move of its object store until it can use its credentials, `credentials`
   * once the store is in its account. Absent, the registry stays anonymous in `TENANT`.
   */
  registryNats?: RegistryNatsMode;
  /**
   * API-key Secrets are still in the runtime namespace (#379): the tenant controller keeps a
   * read-only Secret rule there until they are moved. Absent, it has no Secret rule there.
   */
  legacyApiKeys?: boolean;
}
/** How the registry's blobstore entry reaches `di-nats` (#159); see {@link TenantAuthInputs}. */
export type RegistryNatsMode = 'stopped' | 'credentials';
/**
 * Where the move of the registry's object store into its NATS account stands (#159):
 * - `rollout`: `di-nats` and the hosts roll out with the account and the mount; the registry
 *   still runs anonymously in `TENANT`.
 * - `stopping`: both rolled out; the registry is stopped, and no Job exists until a later pass
 *   has observed it stopped (no replica and no Workload left).
 * - `migrating`: the migration Job exists or is created; the registry stays stopped.
 * - `migrated`: the store is in `REGISTRY` (the Job succeeded or the marker says so).
 */
export type RegistryNatsStage = 'rollout' | 'stopping' | 'migrating' | 'migrated';
/**
 * The registry's NATS account on `di-nats` (#159), decided by the platform controller. Present
 * while `tenantAuth.registry` is set and either the host image is a known build with wash patch
 * 0003 or the move already started: the `REGISTRY` account, its credentials Secret and the hosts'
 * read-only mount of it are rendered.
 */
export interface RegistryNats {
  /** The registry user's password: the one in `di-nats-registry` while well formed, or new. */
  password: string;
  stage: RegistryNatsStage;
  /** The host image is a known build with patch 0003, so the registry may use the credentials. */
  credentials: boolean;
  /** Why the migration Job failed (its `Failed` condition); delete the Job to retry. */
  failed?: string;
}
/**
 * How the tenant hosts pull from their registry (#83 `:host-pull`), rendered once the registry
 * is deployed, whether or not its pull Secret exists yet: wash reads the Docker config from that
 * Secret, and over TLS trusts the tenant CA (`caDigest`, the digest of `tenant-controller-ca`, which rolls the hosts
 * when the certificate is renewed, since wash loads `--oci-ca-path` and `--http-client-ca-path`
 * once at start). The CA is trusted for both OCI pulls and the components' outgoing `wasi:http`.
 */
export interface HostPull {
  caDigest?: string;
}
const TENANT_AUTH_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
/** Reject a tenant-auth config that would deploy an unpinned image or miss required fields. */
export function assertTenantAuthConfig(value: TenantAuthConfig | undefined): void {
  if (value === undefined) return;
  if (!TENANT_AUTH_IMAGE.test(value.image ?? ''))
    throw new Error('tenantAuth.image must be pinned by digest (<repository>@sha256:<digest>)');
  if (!URL.canParse(value.issuer ?? '')) throw new Error('tenantAuth.issuer must be a URL');
  if (!value.oauthClient?.id || !value.oauthClient.secretName)
    throw new Error('tenantAuth.oauthClient needs id and secretName');
  if (value.registry === undefined) return;
  if (!TENANT_AUTH_IMAGE.test(value.registry.component ?? ''))
    throw new Error(
      'tenantAuth.registry.component must be pinned by digest (<repository>@sha256:<digest>)',
    );
  if (value.registry.publicUrl !== undefined && !URL.canParse(value.registry.publicUrl))
    throw new Error('tenantAuth.registry.publicUrl must be a URL');
  const limits: unknown = value.registry.limits === undefined ? {} : value.registry.limits;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits))
    throw new Error('tenantAuth.registry.limits must be an object');
  const known = Object.keys(REGISTRY_LIMIT_ENV);
  for (const [key, limit] of Object.entries(limits)) {
    if (!Object.hasOwn(REGISTRY_LIMIT_ENV, key))
      throw new Error(
        `tenantAuth.registry.limits.${key} is not a known limit (${known.join(', ')})`,
      );
    if (!Number.isSafeInteger(limit) || (limit as number) < 1)
      throw new Error(`tenantAuth.registry.limits.${key} must be a positive integer`);
  }
}
/** `di-nats` JetStream caps when the platform config sets none (#160). */
export const RUNTIME_NATS_DEFAULTS = { maxFileStore: '10Gi', maxMemoryStore: '32Mi' } as const;
/** Memory limit of the `di-nats` and `di-redis` containers, in MiB. */
const BACKING_SERVICE_MEMORY_LIMIT_MIB = 128;
/** The `di-nats` / `di-redis` container memory limit, as rendered on the pod. */
export const BACKING_SERVICE_MEMORY_LIMIT = `${BACKING_SERVICE_MEMORY_LIMIT_MIB}Mi`;
/**
 * The largest `di-nats` JetStream memory store: half the container memory limit. The other half
 * is headroom for nats-server itself (connections, buffers, file-store caches), so a full memory
 * store is refused by JetStream (`insufficient resources`) instead of getting the pod OOM-killed.
 */
export const RUNTIME_NATS_MAX_MEMORY_STORE = `${BACKING_SERVICE_MEMORY_LIMIT_MIB / 2}Mi`;
/** The ConfigMap in `di-runtime-<tenant>` holding the `di-nats` server config. */
export const RUNTIME_NATS_CONFIG = 'di-nats-config';
/** The `di-nats` image; its shell also runs the JetStream account init step (#159). */
export const RUNTIME_NATS_IMAGE = 'nats:2.12.8-alpine';
/** Pod template annotation carrying the server config digest, so a cap change restarts NATS. */
export const RUNTIME_NATS_CONFIG_ANNOTATION = 'platform.di-framework.dev/nats-config-sha256';
const BINARY_QUANTITY = /^([1-9][0-9]*)(Ki|Mi|Gi|Ti)?$/;
const MIB = 2 ** 20;
const BINARY_UNITS: Record<string, number> = {
  '': 1,
  Ki: 2 ** 10,
  Mi: MIB,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};
function binaryBytes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = BINARY_QUANTITY.exec(value);
  if (!match) return undefined;
  const bytes = Number(match[1]) * (BINARY_UNITS[match[2] ?? ''] ?? 1);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}
/** Resolved `di-nats` JetStream caps, in bytes. */
export interface RuntimeNatsLimits {
  maxFileStore: number;
  maxMemoryStore: number;
}
/**
 * Validate a `runtimeNats` config and resolve its caps in bytes, defaults filled in. Throws on an
 * unknown key, a value that is not a positive binary quantity, a cap below 1Mi, or a memory
 * store above {@link RUNTIME_NATS_MAX_MEMORY_STORE}.
 */
export function runtimeNatsLimits(value: RuntimeNatsConfig | undefined): RuntimeNatsLimits {
  const config: unknown = value === undefined ? {} : value;
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new Error('runtimeNats must be an object');
  const known = Object.keys(RUNTIME_NATS_DEFAULTS);
  for (const key of Object.keys(config))
    if (!Object.hasOwn(RUNTIME_NATS_DEFAULTS, key))
      throw new Error(`runtimeNats.${key} is not a known setting (${known.join(', ')})`);
  const set = config as RuntimeNatsConfig;
  const resolve = (key: keyof RuntimeNatsConfig): number => {
    const raw = set[key] ?? RUNTIME_NATS_DEFAULTS[key];
    const bytes = binaryBytes(raw);
    if (bytes === undefined)
      throw new Error(
        `runtimeNats.${key} must be a positive binary quantity such as ${RUNTIME_NATS_DEFAULTS[key]} (got ${JSON.stringify(raw)})`,
      );
    if (bytes < MIB) throw new Error(`runtimeNats.${key} must be at least 1Mi`);
    return bytes;
  };
  const limits = {
    maxFileStore: resolve('maxFileStore'),
    maxMemoryStore: resolve('maxMemoryStore'),
  };
  if (limits.maxMemoryStore > (BACKING_SERVICE_MEMORY_LIMIT_MIB / 2) * MIB)
    throw new Error(
      `runtimeNats.maxMemoryStore must be at most ${RUNTIME_NATS_MAX_MEMORY_STORE}, half the di-nats memory limit (${BACKING_SERVICE_MEMORY_LIMIT}); the rest is nats-server's own headroom`,
    );
  return limits;
}
/** Reject a `runtimeNats` config the reconcile could not render. */
export function assertRuntimeNatsConfig(value: RuntimeNatsConfig | undefined): void {
  runtimeNatsLimits(value);
}
/**
 * The `di-nats` server config: JetStream on the tenant's host path (`/data`, the same store
 * directory as the earlier `-js -sd /data` flags), bounded by `limits`. nats-server has no flag
 * for either cap, so they are set in this file. Clients without credentials land in the `TENANT`
 * account; with `registry` the registry's own `REGISTRY` account is added (#159, see
 * `registry-nats.ts`).
 */
export function runtimeNatsServerConfig(
  limits: RuntimeNatsLimits,
  { registry = false }: { registry?: boolean } = {},
): string {
  return [
    'port: 4222',
    'jetstream {',
    '  store_dir: "/data"',
    `  max_file_store: ${limits.maxFileStore}`,
    `  max_memory_store: ${limits.maxMemoryStore}`,
    '}',
    ...natsAccountsConfig(registry),
    '',
  ].join('\n');
}
/**
 * Each registry front limit and the controller env suffix it renders as
 * (`TENANT_CONTROLLER_REGISTRY_<suffix>`): the one source for both validation and rendering
 * (S11 of the #83 review), so a new limit cannot be added to one and missed in the other.
 */
const REGISTRY_LIMIT_ENV = {
  maxBodyBytes: 'MAX_BODY_BYTES',
  upstreamTimeoutMs: 'UPSTREAM_TIMEOUT_MS',
  maxConcurrent: 'MAX_CONCURRENT',
  uploadIdleTimeoutMs: 'UPLOAD_IDLE_TIMEOUT_MS',
} as const satisfies Record<keyof TenantRegistryLimits, string>;
/** Route-host labels the platform gateway forwards to each tenant's console and controller. */
export interface TenantAuthRoutes {
  /** `console` in `http://console.{tenant}.localhost:<port>`: plain HTTP to `tenant-console:8787`. */
  console?: string;
  /** `controller` in `https://controller.{tenant}.localhost:<port>`: TLS passthrough to `tenant-controller:8788`. */
  controller?: string;
  /**
   * The registry workload's `wasi:http` host (#83): TLS for `<registry>.{tenant}.localhost` is
   * passed through to the controller's registry front (8790); plain HTTP to it is refused.
   */
  registry?: string;
}
const ROUTE_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };
/**
 * Which tenant-auth public URLs the gateway routes, from config alone so the gateway and the
 * controller agree. A URL whose host is `<label>.{tenant}.localhost` asks for a route; it gets one
 * when the gateway is published (`routeUrlPattern`, which must be `http://`, since a TLS
 * terminator in front of the gateway breaks controller passthrough) on the same effective port
 * (scheme defaults applied: http 80, https 443) and the scheme fits (console `http`, controller
 * `https`). Schemes and hosts are compared in lower case. Any other URL (the `127.0.0.1`
 * defaults), or any URL while no gateway is published, is left unrouted; a gateway-shaped URL the
 * published gateway cannot route is returned as a problem for `TenantAuthReady`. `urls` holds the
 * normalized (lower-case) public URL of each routed host.
 */
export function tenantAuthRoutes(
  auth: TenantAuthConfig | undefined,
  routeUrlPattern: string | undefined,
): { routes: TenantAuthRoutes; urls: TenantAuthRoutes; problems: string[] } {
  const routes: TenantAuthRoutes = {};
  const urls: TenantAuthRoutes = {};
  const problems: string[] = [];
  const pattern = /^([a-z]+):\/\/[^/]*?(?::(\d+))?$/.exec((routeUrlPattern ?? '').toLowerCase());
  const gatewayScheme = pattern?.[1] ?? '';
  const gatewayPort = pattern?.[2] ?? DEFAULT_PORTS[gatewayScheme] ?? '';
  const wanted: [keyof TenantAuthRoutes, string, string, string | undefined][] = [
    ['console', 'consolePublicUrl', 'http', auth?.consolePublicUrl],
    ['controller', 'controllerPublicUrl', 'https', auth?.controllerPublicUrl],
    ...(auth?.registry
      ? [
          ['registry', 'registry.publicUrl', 'https', auth.registry.publicUrl] as [
            'registry',
            string,
            string,
            string | undefined,
          ],
        ]
      : []),
  ];
  const owner = (label: string) =>
    (Object.keys(routes) as (keyof TenantAuthRoutes)[]).find((key) => routes[key] === label);
  for (const [key, field, scheme, value] of wanted) {
    const url = (value ?? '').toLowerCase();
    const match = /^([a-z]+):\/\/([^/:]+)\.\{tenant\}\.localhost(?::(\d+))?\/?$/.exec(url);
    // No published gateway: nothing to route through (a port-forward or hosts entry serves it).
    if (!match || !routeUrlPattern) continue;
    const [, protocol, label, port] = match as unknown as [string, string, string, string?];
    const effectivePort = port ?? DEFAULT_PORTS[protocol];
    if (gatewayScheme !== 'http')
      problems.push(`tenantAuth.${field} cannot be routed: routeUrlPattern must use http://`);
    else if (protocol !== scheme) problems.push(`tenantAuth.${field} must use ${scheme}://`);
    else if (!ROUTE_LABEL.test(label)) problems.push(`tenantAuth.${field} host label is invalid`);
    else if (effectivePort !== gatewayPort)
      problems.push(`tenantAuth.${field} must use the gateway port ${gatewayPort}`);
    else if (owner(label))
      problems.push(`tenantAuth.${field} must not share the ${owner(label)} host`);
    else {
      routes[key] = label;
      urls[key] = url;
    }
  }
  // The registry's HTTP host is always known to a published gateway, so a plain-HTTP request for
  // it is refused even when users reach the registry another way (a port-forward).
  if (auth?.registry && routeUrlPattern && !routes.registry) {
    const label = registryHttpHost(auth);
    const shared = `tenantAuth.registry.publicUrl must not share the ${owner(label)} host`;
    if (!owner(label)) routes.registry = label;
    else if (!problems.includes(shared)) problems.push(shared);
  }
  return { routes, urls, problems };
}
/** A `routeUrlPattern` the tenant-auth public URLs can be derived from; group 1 is `:<port>`. */
const DERIVABLE_ROUTE_PATTERN = /^http:\/\/\{host\}\.\{tenant\}\.localhost(:\d+)?$/i;
/** The tenant-auth public URLs `auth` leaves unset, by config path. */
export function unsetPublicUrls(auth: TenantAuthConfig | undefined): string[] {
  if (auth === undefined) return [];
  return [
    ...(auth.consolePublicUrl === undefined ? ['consolePublicUrl'] : []),
    ...(auth.controllerPublicUrl === undefined ? ['controllerPublicUrl'] : []),
    ...(auth.registry && auth.registry.publicUrl === undefined ? ['registry.publicUrl'] : []),
  ];
}
/**
 * `auth` with each unset public URL (`consolePublicUrl`, `controllerPublicUrl` and, with a
 * registry, `registry.publicUrl`) derived from the published gateway's `routeUrlPattern`, so a
 * fresh Tenant is routed without extra config: `http://console.{tenant}.localhost:<port>`,
 * `https://controller.{tenant}.localhost:<port>` and `https://registry.{tenant}.localhost:<port>`
 * on the gateway port (`:80` when the pattern names none). Explicit URLs are kept as given. Only
 * an `http://{host}.{tenant}.localhost[:<port>]` pattern is derived from, since only those hosts
 * are routed to the pair; with any other pattern, no `tenantAuth`, no `routeUrlPattern`, or every
 * URL set, `auth` is returned unchanged and the `127.0.0.1` defaults apply, as before.
 */
export function withDerivedPublicUrls(
  auth: TenantAuthConfig | undefined,
  routeUrlPattern: string | undefined,
): TenantAuthConfig | undefined {
  const match = DERIVABLE_ROUTE_PATTERN.exec(routeUrlPattern ?? '');
  if (auth === undefined || !match || unsetPublicUrls(auth).length === 0) return auth;
  // The gateway port, explicit for the TLS hosts (https alone would mean 443) and omitted for the
  // console when it is http's own 80, so its URL stays canonical.
  const port = match[1] ?? ':80';
  const url = (scheme: 'http' | 'https', label: string) =>
    `${scheme}://${label}.{tenant}.localhost${scheme === 'http' && port === ':80' ? '' : port}`;
  return {
    ...auth,
    consolePublicUrl: auth.consolePublicUrl ?? url('http', 'console'),
    controllerPublicUrl: auth.controllerPublicUrl ?? url('https', 'controller'),
    ...(auth.registry && {
      registry: {
        ...auth.registry,
        publicUrl: auth.registry.publicUrl ?? url('https', 'registry'),
      },
    }),
  };
}
/**
 * The registry workload's `wasi:http` host: the route label of a gateway-shaped
 * `registry.publicUrl`, otherwise `registry`. The controller's registry front sends it as `Host`.
 */
export function registryHttpHost(auth: TenantAuthConfig | undefined): string {
  const match = /^[a-z]+:\/\/([^/:]+)\.\{tenant\}\.localhost(?::\d+)?\/?$/.exec(
    (auth?.registry?.publicUrl ?? '').toLowerCase(),
  );
  return match && ROUTE_LABEL.test(match[1] as string) ? (match[1] as string) : 'registry';
}
/** The controller env for the registry front's bounds; unset limits keep the controller default. */
function registryLimitsEnv(limits: TenantRegistryLimits | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, suffix] of Object.entries(REGISTRY_LIMIT_ENV)) {
    const value = limits?.[key as keyof TenantRegistryLimits];
    if (value !== undefined) env[`TENANT_CONTROLLER_REGISTRY_${suffix}`] = String(value);
  }
  return env;
}
/** The registry origin users log in to, with `{tenant}` replaced. */
export function tenantRegistryPublicUrl(
  tenant: string,
  auth: TenantAuthConfig | undefined,
): string {
  return expandTenant(auth?.registry?.publicUrl ?? DEFAULT_REGISTRY_URL, tenant).replace(/\/$/, '');
}
/**
 * Replace the `{tenant}` placeholder in a tenant-auth public URL, in any case: routing matches it
 * case-insensitively, so the published route, the certificate SANs and the console's URLs agree.
 */
function expandTenant(url: string, tenant: string): string {
  return url.replace(/\{tenant\}/gi, tenant);
}
/** `consoleUrl` / `controllerUrl` for `di-platform-routes`, only for hosts the gateway routes. */
function routedTenantAuthUrls(tenant: string, cfg: ControllerConfig): Record<string, string> {
  const { urls } = tenantAuthRoutes(cfg.tenantAuth, cfg.routeUrlPattern);
  const result: Record<string, string> = {};
  if (urls.console) result.consoleUrl = expandTenant(urls.console, tenant);
  if (urls.controller) result.controllerUrl = expandTenant(urls.controller, tenant);
  return result;
}
/** Container limits of one tenant-auth pair, counted on top of the tenant's own quota. */
export const TENANT_AUTH_LIMITS = { cpu: '500m', memory: '448Mi' };
/** Each suffix in thousandths of the base unit, so sums stay integers. */
const units: Record<string, number> = {
  m: 1,
  '': 1000,
  Ki: 1024 * 1000,
  Mi: 1024 ** 2 * 1000,
  Gi: 1024 ** 3 * 1000,
  Ti: 1024 ** 4 * 1000,
};
/** `a + b` for quantities in the CRD's pattern; CPU comes back in millicores, memory in Mi. */
export function addQuantity(a: string, b: string, unit: 'm' | 'Mi'): string {
  const value = (q: string) => {
    const [, n, suffix] = /^([0-9.]+)(m|Ki|Mi|Gi|Ti)?$/.exec(q)!;
    return Math.round(Number(n) * (units[suffix ?? ''] as number));
  };
  return `${Math.ceil((value(a) + value(b)) / (units[unit] as number))}${unit}`;
}
/** Platform HTTP gateway (di-framework/kube#2); its pods alone reach tenant hosts on 9191. */
const GATEWAY_NAME = 'di-platform-gateway';
const GATEWAY_POD_LABELS = { app: GATEWAY_NAME };
/** Per-tenant ConfigMap with the gateway URL template; absent means no gateway is known. */
const ROUTES_CONFIG_NAME = 'di-platform-routes';
const GROUP = 'platform.di-framework.dev';
const VERSION = `${GROUP}/v1alpha1`;
/** The host template annotation carrying the digest of the tenant CA the hosts trust. */
export const REGISTRY_CA_ANNOTATION = `${GROUP}/registry-ca-sha256`;
const INSTALLATION = `${GROUP}/installation`;
const OWNER = `${GROUP}/owner-uid`;
const TENANT = `${GROUP}/tenant`;
const USER = `${GROUP}/user`;
const FINALIZER = `${GROUP}/cleanup`;
const COMPONENT = `${GROUP}/component`;
/** Marks a tenant's runtime namespace (`di-runtime-<tenant>`), so policies can select only those. */
const NAMESPACE_ROLE = `${GROUP}/namespace-role`;
const nameSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 40,
  pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
};
const quantity = { type: 'string', minLength: 1, pattern: '^[0-9]+(\\.[0-9]+)?(m|Ki|Mi|Gi|Ti)?$' };
const conditions = {
  type: 'array',
  'x-kubernetes-list-type': 'map',
  'x-kubernetes-list-map-keys': ['type'],
  items: {
    type: 'object',
    required: ['type', 'status', 'reason', 'message', 'lastTransitionTime', 'observedGeneration'],
    properties: {
      type: { type: 'string' },
      status: { type: 'string', enum: ['True', 'False', 'Unknown'] },
      reason: { type: 'string' },
      message: { type: 'string' },
      lastTransitionTime: { type: 'string', format: 'date-time' },
      observedGeneration: { type: 'integer', format: 'int64' },
    },
  },
};
function crd(kind: string, plural: string, spec: Json, status: Record<string, Json>) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${GROUP}` },
    spec: {
      group: GROUP,
      scope: 'Cluster',
      names: { kind, plural, singular: kind.toLowerCase() },
      versions: [
        {
          name: 'v1alpha1',
          served: true,
          storage: true,
          subresources: { status: {} },
          additionalPrinterColumns: [
            {
              name: 'Ready',
              type: 'string',
              jsonPath: '.status.conditions[?(@.type=="Ready")].status',
            },
            { name: 'Age', type: 'date', jsonPath: '.metadata.creationTimestamp' },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                metadata: { type: 'object', properties: { name: nameSchema } },
                spec,
                status: {
                  type: 'object',
                  properties: {
                    conditions,
                    observedGeneration: { type: 'integer', format: 'int64' },
                    ...status,
                  },
                },
              },
            },
          },
        },
      ],
    },
  };
}
const crds = [
  crd(
    'Tenant',
    'tenants',
    {
      type: 'object',
      properties: {
        suspended: { type: 'boolean', default: false },
        deletionPolicy: { type: 'string', enum: [...DELETION_POLICIES], default: 'Retain' },
        runtime: {
          type: 'object',
          default: {},
          properties: {
            replicas: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
            coreInstances: { type: 'integer', ...CORE_INSTANCES },
          },
        },
        resources: {
          type: 'object',
          default: {},
          properties: {
            cpu: { ...quantity, default: '2' },
            memory: { ...quantity, default: '4Gi' },
            workloads: { type: 'integer', minimum: 1, maximum: 1000, default: 20 },
            backingServices: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            serviceBindings: { type: 'integer', minimum: 1, maximum: 400, default: 40 },
            apiKeys: { type: 'integer', ...API_KEYS_LIMITS, default: DEFAULT_API_KEYS },
          },
        },
      },
    },
    {
      namespace: { type: 'string' },
      runtimeNamespace: { type: 'string' },
      apiKeysNamespace: { type: 'string' },
      // Set once every API key is out of the runtime namespace (#379); tenant-auth then stops
      // reading the old layout.
      apiKeysMigrated: { type: 'boolean' },
      hostgroup: { type: 'string' },
      httpService: { type: 'string' },
    },
  ),
  crd(
    'User',
    'users',
    {
      type: 'object',
      required: ['memberships'],
      properties: {
        suspended: { type: 'boolean', default: false },
        memberships: {
          type: 'array',
          maxItems: 100,
          'x-kubernetes-list-type': 'map',
          'x-kubernetes-list-map-keys': ['tenant'],
          items: {
            type: 'object',
            required: ['tenant', 'role'],
            properties: {
              tenant: nameSchema,
              role: { type: 'string', enum: ['developer', 'viewer'] },
            },
          },
        },
      },
    },
    {
      serviceAccount: {
        type: 'object',
        properties: { name: { type: 'string' }, namespace: { type: 'string' } },
      },
    },
  ),
  ...backingServiceCrds,
];
function names(name: string) {
  return {
    namespace: `di-tenant-${name}`,
    runtimeNamespace: `di-runtime-${name}`,
    apiKeysNamespace: apiKeysNamespace(name),
    hostgroup: `tenant-${name}`,
  };
}
function validName(name: unknown) {
  return (
    typeof name === 'string' && name.length <= 40 && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)
  );
}
function labels(owner: Tenant | User, installation: string): Record<string, string> {
  return {
    [INSTALLATION]: installation,
    [OWNER]: owner.metadata.uid ?? '',
    [owner.kind === 'Tenant' ? TENANT : USER]: owner.metadata.name,
  };
}
function resource(
  owner: Tenant | User,
  installation: string,
  apiVersion: string,
  kind: string,
  name: string,
  namespace: string | undefined,
  body: Record<string, unknown>,
): Resource {
  return {
    apiVersion,
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}), labels: labels(owner, installation) },
    ...body,
  };
}
const readVerbs = ['get', 'list', 'watch'];
const editVerbs = [...readVerbs, 'create', 'update', 'patch', 'delete'];
/**
 * The tenant's runtime quota. With `withTenantAuth` the tenant controller and console limits are
 * added on top, so the tenant keeps its whole budget for the host and backing services (#58).
 * The controller raises it only in the tenant-auth step, right before it applies those
 * Deployments, and keeps it raised only while they exist (#121).
 */
function runtimeQuota(
  tenant: Tenant,
  cfg: ControllerConfig,
  withTenantAuth: boolean,
  /** The registry NATS migration Job's limits are added while it runs (#159). */
  withMigration = false,
): Resource {
  const resources = tenant.spec.resources ?? {};
  const cpu = withTenantAuth
    ? addQuantity(resources.cpu ?? '2', TENANT_AUTH_LIMITS.cpu, 'm')
    : (resources.cpu ?? '2');
  const memory = withTenantAuth
    ? addQuantity(resources.memory ?? '4Gi', TENANT_AUTH_LIMITS.memory, 'Mi')
    : (resources.memory ?? '4Gi');
  return resource(
    tenant,
    cfg.installation,
    'v1',
    'ResourceQuota',
    'di-runtime-quota',
    names(tenant.metadata.name).runtimeNamespace,
    {
      spec: {
        hard: {
          'limits.cpu': withMigration
            ? addQuantity(cpu, REGISTRY_NATS_MIGRATION_LIMITS.cpu, 'm')
            : cpu,
          'limits.memory': withMigration
            ? addQuantity(memory, REGISTRY_NATS_MIGRATION_LIMITS.memory, 'Mi')
            : memory,
          pods: '20',
          // Aggregate compute/storage budget for runtime + controller-managed di-bs-* backends.
          // Per-service sizing still comes from BackingServiceClass parametersSchema (#450).
          'requests.storage': '50Gi',
        },
      },
    },
  );
}
/**
 * The tenant namespace quota. With `withRegistry` one WorkloadDeployment is added for the tenant
 * registry (#83), so it never takes one of the tenant's own. Like {@link runtimeQuota}, it is
 * raised only in the tenant-auth step right before the registry is applied, and stays raised
 * only while the registry exists.
 */
function tenantQuota(tenant: Tenant, cfg: ControllerConfig, withRegistry: boolean): Resource {
  const resources = tenant.spec.resources ?? {};
  return resource(
    tenant,
    cfg.installation,
    'v1',
    'ResourceQuota',
    'di-tenant-quota',
    names(tenant.metadata.name).namespace,
    {
      spec: {
        hard: {
          'count/workloaddeployments.runtime.wasmcloud.dev': String(
            (resources.workloads ?? 20) + (withRegistry ? 1 : 0),
          ),
          [`count/backingservices.${GROUP}`]: String(resources.backingServices ?? 10),
          [`count/servicebindings.${GROUP}`]: String(resources.serviceBindings ?? 40),
          'count/secrets': '100',
          'count/configmaps': '100',
          'count/services': '100',
        },
      },
    },
  );
}
/**
 * The quota of `di-apikeys-<tenant>` (#379): `count/secrets` is the tenant's API-key cap
 * (`spec.resources.apiKeys`), since the namespace holds one Secret per key and nothing else. No
 * pod runs there, so it admits none.
 */
function apiKeysQuota(tenant: Tenant, cfg: ControllerConfig): Resource {
  return resource(
    tenant,
    cfg.installation,
    'v1',
    'ResourceQuota',
    'di-apikeys-quota',
    names(tenant.metadata.name).apiKeysNamespace,
    {
      spec: {
        hard: {
          'count/secrets': String(tenant.spec.resources?.apiKeys ?? DEFAULT_API_KEYS),
          pods: '0',
        },
      },
    },
  );
}
/**
 * Egress of `di-tenant-network`: the tenant's own namespaces, cluster DNS, the platform's NATS
 * and registry, and public HTTPS. Tenant-auth pods get the same through `tenant-auth-network`.
 */
function tenantNetworkEgress(tenant: string, cfg: ControllerConfig): unknown[] {
  const n = names(tenant);
  return [
    {
      to: [n.namespace, n.runtimeNamespace].map((name) => ({
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
      })),
    },
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
          },
          podSelector: {
            matchExpressions: [{ key: 'k8s-app', operator: 'In', values: ['kube-dns', 'coredns'] }],
          },
        },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { 'kubernetes.io/metadata.name': cfg.namespace },
          },
        },
      ],
      ports: [
        { protocol: 'TCP', port: 4222 },
        { protocol: 'TCP', port: 5000 },
      ],
    },
    {
      to: [
        {
          ipBlock: { cidr: '0.0.0.0/0', except: [...PRIVATE_IPV4_RANGES] },
        },
      ],
      ports: [{ protocol: 'TCP', port: 443 }],
    },
  ];
}
function tenantResources(
  tenant: Tenant,
  cfg: ControllerConfig,
  schedulerSecret?: { data: Record<string, string> },
  storageKeys: string[] = [],
  tenantAuthQuota = false,
  registryQuota = false,
  /**
   * Whether this tenant's `tenant-auth-network` exists (#83): only then are the tenant-auth pods
   * left out of `di-tenant-network`, so an upgrade never isolates them before their own policy
   * is in place, and a failed tenant-auth step keeps them on the broad policy.
   */
  tenantAuthNetwork = false,
  /** How the hosts pull from the tenant registry (#83 `:host-pull`); absent, they do not. */
  hostPull?: HostPull,
  /** The registry's NATS account (#159); absent, `di-nats` has the `TENANT` account only. */
  registryNats?: RegistryNats,
): Resource[] {
  const n = names(tenant.metadata.name);
  const storage = hostStorage(tenant, cfg, storageKeys);
  const make = (
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string,
    body: Record<string, unknown>,
  ) => resource(tenant, cfg.installation, apiVersion, kind, name, namespace, body);
  const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
  const replicas = suspended ? 0 : (tenant.spec.runtime?.replicas ?? 1);
  // The migration Job (#159) is rendered, and its pod fits the runtime quota, only while the move
  // is under way.
  const migrationJob = registryNats?.stage === 'migrating' && !suspended;
  const workloadRead = {
    apiGroups: ['runtime.wasmcloud.dev'],
    resources: ['workloaddeployments', 'workloads', 'workloadreplicasets', 'artifacts'],
    verbs: readVerbs,
  };
  const result = [
    tenantQuota(tenant, cfg, registryQuota),
    runtimeQuota(tenant, cfg, tenantAuthQuota, migrationJob),
    apiKeysQuota(tenant, cfg),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-developer', n.namespace, {
      rules: [
        workloadRead,
        {
          apiGroups: ['runtime.wasmcloud.dev'],
          resources: ['workloaddeployments'],
          verbs: editVerbs,
        },
        {
          apiGroups: [GROUP],
          resources: ['backingservices', 'servicebindings'],
          verbs: editVerbs,
        },
        { apiGroups: [''], resources: ['services', 'configmaps'], verbs: editVerbs },
        // Write-only Secrets (#112): no get/list/watch, and no patch, whose response returns the
        // whole object. The tenant controller reads names and labels with its own ServiceAccount.
        { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'update', 'delete'] },
        { apiGroups: [''], resources: ['events'], verbs: readVerbs },
      ],
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-viewer', n.namespace, {
      rules: [
        workloadRead,
        {
          apiGroups: [GROUP],
          resources: ['backingservices', 'servicebindings'],
          verbs: readVerbs,
        },
        { apiGroups: [''], resources: ['services', 'configmaps', 'events'], verbs: readVerbs },
      ],
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-runtime-viewer', n.runtimeNamespace, {
      rules: [
        { apiGroups: [''], resources: ['pods', 'services', 'events'], verbs: readVerbs },
        { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
      ],
    }),
    make('rbac.authorization.k8s.io/v1', 'Role', 'di-runtime-developer', n.runtimeNamespace, {
      rules: [
        { apiGroups: [''], resources: ['pods', 'services', 'events'], verbs: readVerbs },
        { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
        { apiGroups: [''], resources: ['pods/portforward'], verbs: ['create'] },
      ],
    }),
    make('v1', 'ServiceAccount', 'di-runtime', n.runtimeNamespace, {
      automountServiceAccountToken: false,
    }),
    make('v1', 'ConfigMap', 'di-tenant-stock', n.namespace, {
      data: {
        backend: 'redis',
        url: `redis://di-redis.${n.runtimeNamespace}.svc.cluster.local:6379`,
        prefix: 'stock:',
      },
    }),
  ];
  for (const namespace of [n.namespace, n.runtimeNamespace])
    result.push(
      make('networking.k8s.io/v1', 'NetworkPolicy', 'di-tenant-network', namespace, {
        spec: {
          // Broad tenant↔runtime allow for non-backend pods. Backends use di-bs-backend-network;
          // the tenant controller and console use tenant-auth-network, which admits the tenant
          // hosts only to the controller's whoami (8789) and registry pull (8791) listeners (#83).
          podSelector: {
            matchExpressions: [
              {
                key: `${GROUP}/component`,
                operator: 'NotIn',
                values: [
                  'backing-service',
                  'backup-agent',
                  'backup-operator',
                  ...(tenantAuthNetwork ? ['tenant-auth'] : []),
                ],
              },
            ],
          },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [
            {
              from: [n.namespace, n.runtimeNamespace].map((name) => ({
                namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
              })),
            },
          ],
          egress: tenantNetworkEgress(tenant.metadata.name, cfg),
        },
      }),
    );
  // di-tenant-network admits only same-tenant traffic; the platform gateway is the one
  // outside client allowed to reach the tenant hosts' HTTP port.
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'di-tenant-gateway', n.runtimeNamespace, {
      spec: {
        podSelector: {
          matchLabels: {
            'wasmcloud.com/hostgroup': n.hostgroup,
            'wasmcloud.com/name': 'hostgroup',
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': cfg.namespace },
                },
                podSelector: { matchLabels: GATEWAY_POD_LABELS },
              },
            ],
            ports: [{ protocol: 'TCP', port: 9191 }],
          },
        ],
      },
    }),
  );
  if (cfg.routeUrlPattern)
    result.push(
      make('v1', 'ConfigMap', ROUTES_CONFIG_NAME, n.namespace, {
        data: {
          urlTemplate: cfg.routeUrlPattern.replaceAll('{tenant}', tenant.metadata.name),
          ...routedTenantAuthUrls(tenant.metadata.name, cfg),
        },
      }),
    );
  // Backend pods accept ingress from the tenant hostgroup and from backup-agent Jobs in
  // the same runtime namespace. Developers retain pods/portforward on runtime Roles.
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'di-bs-backend-network', n.runtimeNamespace, {
      spec: {
        podSelector: {
          matchLabels: { [`${GROUP}/component`]: 'backing-service' },
        },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': n.runtimeNamespace },
                },
                podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
              },
            ],
          },
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': n.runtimeNamespace },
                },
                podSelector: { matchLabels: { [`${GROUP}/component`]: 'backup-agent' } },
              },
            ],
            ports: [
              { protocol: 'TCP', port: 5432 },
              { protocol: 'TCP', port: 6379 },
              { protocol: 'TCP', port: 4222 },
            ],
          },
          // The registry object store migration Job reaches `di-nats` only (#159).
          ...(registryNats
            ? [
                {
                  from: [
                    {
                      namespaceSelector: {
                        matchLabels: { 'kubernetes.io/metadata.name': n.runtimeNamespace },
                      },
                      podSelector: {
                        matchLabels: {
                          [`${GROUP}/component`]: REGISTRY_NATS_MIGRATION_COMPONENT,
                        },
                      },
                    },
                  ],
                  ports: [{ protocol: 'TCP', port: 4222 }],
                },
              ]
            : []),
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
                },
                podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
              },
            ],
            ports: [
              { protocol: 'UDP', port: 53 },
              { protocol: 'TCP', port: 53 },
            ],
          },
        ],
      },
    }),
  );
  // The `di-nats` JetStream store lives on an unquotaed host path, so its server config caps
  // file and memory storage (#160). The ConfigMap is applied before the Deployment that mounts it.
  // The registry's account (#159) reads its password from the credentials Secret, which is
  // applied before the Deployment too.
  const natsConfig = runtimeNatsServerConfig(runtimeNatsLimits(cfg.runtimeNats), {
    registry: !!registryNats,
  });
  const registryAuth = registryNats ? registryNatsAuthDigest(registryNats.password) : undefined;
  if (registryNats)
    result.push(
      make('v1', 'Secret', REGISTRY_NATS_SECRET, n.runtimeNamespace, {
        type: 'kubernetes.io/basic-auth',
        data: registryNatsSecretData(registryNats.password),
      }),
    );
  result.push(
    make('v1', 'ConfigMap', RUNTIME_NATS_CONFIG, n.runtimeNamespace, {
      data: { 'nats.conf': natsConfig },
    }),
  );
  const natsConfigVolume = {
    annotations: {
      [RUNTIME_NATS_CONFIG_ANNOTATION]: createHash('sha256').update(natsConfig).digest('hex'),
      ...(registryAuth ? { [REGISTRY_NATS_AUTH_ANNOTATION]: registryAuth } : {}),
    },
    mounts: [{ name: 'config', mountPath: '/etc/nats', readOnly: true }],
    volumes: [{ name: 'config', configMap: { name: RUNTIME_NATS_CONFIG } }],
    env: registryNats
      ? [
          {
            name: REGISTRY_NATS_PASSWORD_ENV,
            valueFrom: { secretKeyRef: { name: REGISTRY_NATS_SECRET, key: 'password' } },
          },
        ]
      : [],
    // Clients without credentials land in the TENANT account, whose JetStream directory takes
    // over the global account's before the server starts (#159).
    initContainers: [
      {
        name: 'jetstream-accounts',
        image: RUNTIME_NATS_IMAGE,
        command: ['sh', '-c', JETSTREAM_ACCOUNT_INIT_SCRIPT],
        resources: {
          requests: { cpu: '10m', memory: '16Mi' },
          limits: { cpu: '100m', memory: '32Mi' },
        },
        volumeMounts: [{ name: 'data', mountPath: '/data' }],
      },
    ],
  };
  for (const [name, image, port, args, extra] of [
    // Runtime-internal data-plane NATS for hostgroup `--data-nats-url`.
    // Lifecycle is Tenant-owned; never created as an application BackingService.
    // Application messaging NATS instances are `di-bs-<name>` via reconcileBackingService.
    ['di-nats', RUNTIME_NATS_IMAGE, 4222, ['-c', '/etc/nats/nats.conf'], natsConfigVolume],
    // Transitional warehouse Redis + di-tenant-stock (#456 migrates to BackingService).
    // Independent Redis instances are provisioned separately as `di-bs-<name>`.
    [
      'di-redis',
      'redis:7.4.5-alpine',
      6379,
      ['redis-server', '--appendonly', 'yes', '--dir', '/data'],
      undefined,
    ],
  ] as const) {
    result.push(
      make('apps/v1', 'Deployment', name, n.runtimeNamespace, {
        spec: {
          replicas: suspended ? 0 : 1,
          strategy: { type: 'Recreate' },
          selector: { matchLabels: { app: name } },
          template: {
            metadata: {
              labels: { app: name, [`${GROUP}/component`]: 'backing-service' },
              ...(extra ? { annotations: extra.annotations } : {}),
            },
            spec: {
              automountServiceAccountToken: false,
              ...(extra ? { initContainers: extra.initContainers } : {}),
              containers: [
                {
                  name,
                  image,
                  args,
                  ...(extra?.env.length ? { env: extra.env } : {}),
                  ports: [{ containerPort: port }],
                  resources: {
                    requests: { cpu: '10m', memory: '32Mi' },
                    limits: { cpu: '250m', memory: BACKING_SERVICE_MEMORY_LIMIT },
                  },
                  readinessProbe: { tcpSocket: { port } },
                  volumeMounts: [
                    { name: 'data', mountPath: '/data' },
                    ...(extra ? extra.mounts : []),
                  ],
                },
              ],
              volumes: [
                {
                  name: 'data',
                  hostPath: {
                    path: `${cfg.storageRoot ?? '/var/lib/k0s'}/di-tenants/${tenant.metadata.uid}/${name}`,
                    type: 'DirectoryOrCreate',
                  },
                },
                ...(extra ? extra.volumes : []),
              ],
            },
          },
        },
      }),
    );
    result.push(
      make('v1', 'Service', name, n.runtimeNamespace, {
        spec: { selector: { app: name }, ports: [{ port, targetPort: port }] },
      }),
    );
  }
  if (schedulerSecret) {
    result.push(
      make('v1', 'Secret', 'di-scheduler-tls', n.runtimeNamespace, {
        type: 'Opaque',
        data: schedulerSecret.data,
      }),
    );
    result.push(
      make('apps/v1', 'Deployment', `hostgroup-${n.hostgroup}`, n.runtimeNamespace, {
        spec: {
          replicas,
          // The old host leaves before its replacement starts, never a surge pod. A storage
          // host owns node-local workload directories a second host must not share, and the
          // runtime quota (limits.cpu) leaves no room for a surge host, so a template change
          // would otherwise stall with the old host running. This stays RollingUpdate:
          // switching type to Recreate under server-side apply is rejected while the
          // defaulted rollingUpdate block remains.
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: { maxSurge: 0, maxUnavailable: 1 },
          },
          selector: {
            matchLabels: {
              'wasmcloud.com/hostgroup': n.hostgroup,
              'wasmcloud.com/name': 'hostgroup',
            },
          },
          template: {
            metadata: {
              labels: { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
              ...(hostPull?.caDigest || registryAuth
                ? {
                    annotations: {
                      ...(hostPull?.caDigest
                        ? { [REGISTRY_CA_ANNOTATION]: hostPull.caDigest }
                        : {}),
                      // A rotated registry password rolls the hosts (#159): the registry's pooled
                      // blobstore connection would reconnect with the password it read at first.
                      ...(registryAuth ? { [REGISTRY_NATS_AUTH_ANNOTATION]: registryAuth } : {}),
                    },
                  }
                : {}),
            },
            spec: {
              serviceAccountName: 'di-runtime',
              automountServiceAccountToken: false,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 65532,
                runAsGroup: 65532,
                fsGroup: 65532,
                seccompProfile: { type: 'RuntimeDefault' },
              },
              // Persistent workload directories (#11) are created by DirectoryOrCreate as root;
              // this step hands each one to the host uid before the host starts.
              ...(storage.initContainers.length ? { initContainers: storage.initContainers } : {}),
              containers: [
                {
                  name: 'host',
                  image: cfg.hostImage,
                  imagePullPolicy: cfg.hostImagePullPolicy ?? 'IfNotPresent',
                  args: [
                    'host',
                    '--host-name=$(WASMCLOUD_HOST_IP)',
                    `--host-group=${n.hostgroup}`,
                    `--environment=${n.namespace}`,
                    `--scheduler-nats-url=${cfg.schedulerNatsUrl}`,
                    '--scheduler-nats-tls-ca=/scheduler/ca.crt',
                    '--scheduler-nats-tls-cert=/scheduler/tls.crt',
                    '--scheduler-nats-tls-key=/scheduler/tls.key',
                    `--data-nats-url=nats://di-nats.${n.runtimeNamespace}.svc.cluster.local:4222`,
                    '--oci-cache-dir=/oci-cache',
                    '--http-addr=0.0.0.0:9191',
                    '--socket-egress=enforce',
                    // Plain HTTP only for these exact registries; never --allow-insecure-registries (#149).
                    ...(cfg.insecureRegistries ?? []).flatMap((r) => ['--insecure-registry', r]),
                    // The tenant registry's pull Service serves the controller certificate. The
                    // same CA is trusted for the components' outgoing wasi:http (on top of the
                    // webpki roots), so the registry calls the controller's whoami over https (#113).
                    ...(hostPull?.caDigest
                      ? [
                          '--oci-ca-path=/registry-ca/ca.crt',
                          '--http-client-ca-path=/registry-ca/ca.crt',
                        ]
                      : []),
                  ],
                  env: [
                    { name: 'HOME', value: '/tmp' },
                    {
                      name: 'WASMCLOUD_HOST_IP',
                      valueFrom: { fieldRef: { fieldPath: 'status.podIP' } },
                    },
                    { name: 'WASH_HOST_MAX_GUEST_MEMORY', value: '2Gi' },
                    { name: 'WASH_DEFAULT_HEAP_MEMORY', value: '512MiB' },
                    {
                      name: 'WASH_CORE_INSTANCES',
                      value: String(tenant.spec.runtime?.coreInstances ?? CORE_INSTANCES.default),
                    },
                    // wash reads registry credentials from `$DOCKER_CONFIG/config.json` on each
                    // pull, so a rotated pull Secret takes effect without a restart.
                    ...(hostPull ? [{ name: 'DOCKER_CONFIG', value: '/registry-auth' }] : []),
                  ],
                  ports: [{ name: 'http', containerPort: 9191 }],
                  readinessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 5 },
                  resources: {
                    requests: { cpu: '250m', memory: '256Mi' },
                    limits: { cpu: '1', memory: '2Gi' },
                  },
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                  volumeMounts: [
                    { name: 'scheduler', mountPath: '/scheduler', readOnly: true },
                    { name: 'tmp', mountPath: '/tmp' },
                    { name: 'cache', mountPath: '/oci-cache' },
                    ...(hostPull
                      ? [{ name: 'registry-auth', mountPath: '/registry-auth', readOnly: true }]
                      : []),
                    ...(hostPull?.caDigest
                      ? [{ name: 'registry-ca', mountPath: '/registry-ca', readOnly: true }]
                      : []),
                    // The registry's NATS credentials (#159), read by its blobstore entry only.
                    // Never a guest preopen: workload storage lives under its own root.
                    ...(registryNats
                      ? [
                          {
                            name: REGISTRY_NATS_VOLUME,
                            mountPath: REGISTRY_NATS_MOUNT,
                            readOnly: true,
                          },
                        ]
                      : []),
                    ...storage.volumeMounts,
                  ],
                },
              ],
              volumes: [
                { name: 'scheduler', secret: { secretName: 'di-scheduler-tls' } },
                { name: 'tmp', emptyDir: {} },
                { name: 'cache', emptyDir: {} },
                ...(hostPull
                  ? [
                      {
                        name: 'registry-auth',
                        // Optional, so a host still starts while the Secret is being rotated.
                        secret: {
                          secretName: REGISTRY_PULL_SECRET,
                          optional: true,
                          items: [{ key: 'config.json', path: 'config.json' }],
                        },
                      },
                    ]
                  : []),
                ...(hostPull?.caDigest
                  ? [
                      {
                        name: 'registry-ca',
                        configMap: {
                          name: 'tenant-controller-ca',
                          items: [{ key: 'ca.crt', path: 'ca.crt' }],
                        },
                      },
                    ]
                  : []),
                ...(registryNats
                  ? [
                      {
                        name: REGISTRY_NATS_VOLUME,
                        secret: {
                          secretName: REGISTRY_NATS_SECRET,
                          defaultMode: 0o440,
                          items: [
                            { key: 'username', path: 'username' },
                            { key: 'password', path: 'password' },
                          ],
                        },
                      },
                    ]
                  : []),
                ...storage.volumes,
              ],
            },
          },
        },
      }),
    );
    result.push(
      make('v1', 'Service', 'di-http', n.runtimeNamespace, {
        spec: {
          selector: { 'wasmcloud.com/hostgroup': n.hostgroup },
          ports: [{ name: 'http', port: 80, targetPort: 9191 }],
        },
      }),
    );
  }
  if (registryNats?.stage === 'migrated')
    result.push(
      make('v1', 'ConfigMap', REGISTRY_NATS_MIGRATION, n.runtimeNamespace, {
        data: { state: 'complete' },
      }),
    );
  else if (migrationJob) result.push(registryNatsMigrationJob(make, n.runtimeNamespace));
  return result;
}
/**
 * The one-shot Job that moves the registry's object store from the `TENANT` account into
 * `REGISTRY` (#159; the script is `REGISTRY_NATS_MIGRATION_SCRIPT`). It logs in anonymously for
 * the source and as the registry user for the destination. Kept a day after it finishes, by which
 * time the controller has recorded the result in `di-nats-registry-migration`.
 */
function registryNatsMigrationJob(
  make: (
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string,
    body: Record<string, unknown>,
  ) => Resource,
  namespace: string,
): Resource {
  const credential = (key: string) => ({
    valueFrom: { secretKeyRef: { name: REGISTRY_NATS_SECRET, key } },
  });
  return make('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB, namespace, {
    spec: {
      backoffLimit: 10,
      // A Job that cannot start (quota, scheduling) or hangs ends Failed (DeadlineExceeded), so
      // the stopped registry is reported as RegistryMigrationFailed instead of waiting forever.
      activeDeadlineSeconds: REGISTRY_NATS_MIGRATION_DEADLINE_SECONDS,
      ttlSecondsAfterFinished: 86400,
      template: {
        metadata: { labels: { [`${GROUP}/component`]: REGISTRY_NATS_MIGRATION_COMPONENT } },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'migrate',
              image: NATS_BOX_IMAGE,
              workingDir: '/tmp',
              command: ['sh', '-c', REGISTRY_NATS_MIGRATION_SCRIPT],
              env: [
                { name: 'NATS_URL', value: `nats://di-nats.${namespace}.svc.cluster.local:4222` },
                { name: 'HOME', value: '/tmp' },
                { name: 'REGISTRY_USER', ...credential('username') },
                { name: 'REGISTRY_PASSWORD', ...credential('password') },
              ],
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: REGISTRY_NATS_MIGRATION_LIMITS,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: {} }],
        },
      },
    },
  });
}
/** Whether the controller has reconciled the tenant's current spec. */
function tenantReady(tenant: Tenant): boolean {
  return !!tenant.status?.conditions?.some(
    (c) =>
      c.type === 'Ready' &&
      c.status === 'True' &&
      c.observedGeneration === tenant.metadata.generation,
  );
}
/**
 * Access a user should hold. A membership is granted once its tenant is Ready. While the tenant
 * is merely Not Ready (for example reconciling a new generation), a membership in `granted`
 * (already bound) is kept, so its token Secret survives. Missing, suspended and deleting tenants
 * always lose access.
 */
function userResources(
  user: User,
  tenants: Tenant[],
  cfg: ControllerConfig,
  granted: ReadonlySet<string> = new Set(),
): Resource[] {
  if (user.spec.suspended || user.metadata.deletionTimestamp) return [];
  const make = (
    apiVersion: string,
    kind: string,
    name: string,
    namespace: string,
    body: Record<string, unknown>,
  ) => resource(user, cfg.installation, apiVersion, kind, name, namespace, body);
  const account = `di-user-${user.metadata.name}`;
  const result = [
    make('v1', 'ServiceAccount', account, cfg.namespace, { automountServiceAccountToken: false }),
  ];
  for (const membership of user.spec.memberships) {
    const tenant = tenants.find((t) => t.metadata.name === membership.tenant);
    if (
      !tenant ||
      tenant.spec.suspended ||
      tenant.metadata.deletionTimestamp ||
      !(tenantReady(tenant) || granted.has(membership.tenant))
    )
      continue;
    const n = names(membership.tenant);
    for (const [namespace, role] of [
      [n.namespace, `di-${membership.role}`],
      [n.runtimeNamespace, `di-runtime-${membership.role}`],
    ] as const) {
      const binding = make('rbac.authorization.k8s.io/v1', 'RoleBinding', account, namespace, {
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role },
        subjects: [{ kind: 'ServiceAccount', name: account, namespace: cfg.namespace }],
      });
      binding.metadata.labels![TENANT] = membership.tenant;
      result.push(binding);
    }
    // A long-lived token for the user's tenant kubeconfig. Kubernetes fills `token` and
    // `ca.crt`, and deletes the Secret itself if the ServiceAccount goes away.
    const token = make(
      'v1',
      'Secret',
      userTokenSecretName(user.metadata.name, membership.tenant),
      cfg.namespace,
      { type: 'kubernetes.io/service-account-token' },
    );
    token.metadata = {
      ...token.metadata,
      labels: { ...token.metadata.labels, [TENANT]: membership.tenant },
      annotations: { 'kubernetes.io/service-account.name': account },
    };
    result.push(token);
  }
  return result;
}
/** ServiceAccount token Secret backing a user's kubeconfig for one tenant membership. */
function userTokenSecretName(user: string, tenant: string): string {
  return `di-user-${user}-${tenant}-token`;
}
/** Bun sends these names to loopback whatever DNS says, so pods reach them through a sidecar. */
function loopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
}
/** The controller URL users and CLIs see; `{tenant}` is replaced. */
function tenantControllerPublicUrl(tenant: string, auth: TenantAuthConfig | undefined): string {
  return expandTenant(auth?.controllerPublicUrl ?? 'https://127.0.0.1:8788', tenant);
}
/**
 * Names the controller's serving certificate covers: in-cluster, through a port-forward and the
 * host of `controllerPublicUrl`, so CLIs verify the hostname they were given.
 */
function tenantControllerCertNames(
  tenant: string,
  auth?: TenantAuthConfig,
): { dns: string[]; ips: string[] } {
  const ns = names(tenant).runtimeNamespace;
  const dns = [
    'tenant-controller',
    // The tenant registry's whoami callback (#113).
    registryWhoamiHost(tenant),
    `tenant-controller.${ns}.svc.cluster.local`,
    'localhost',
  ];
  const ips = ['127.0.0.1'];
  const host = URL.canParse(tenantControllerPublicUrl(tenant, auth))
    ? new URL(tenantControllerPublicUrl(tenant, auth)).hostname
    : '';
  // The registry front serves the same certificate, so it also names the registry's public host.
  const registry =
    auth?.registry && URL.canParse(tenantRegistryPublicUrl(tenant, auth))
      ? new URL(tenantRegistryPublicUrl(tenant, auth)).hostname
      : '';
  for (const name of [host, registry]) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) ips.push(name);
    else if (name && !name.startsWith('[')) dns.push(name);
  }
  // The hosts' pull Service (#83 `:host-pull`) serves it too.
  if (auth?.registry)
    dns.push(registryPullHost(tenant), `${registryPullHost(tenant)}.cluster.local`);
  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}
/**
 * The Secret in the tenant's runtime namespace that held the controller CA key before #170. The
 * tenant controller's ServiceAccount can read every Secret there, so the controller moves the key
 * to {@link tenantControllerCaSecret} and deletes this one.
 */
const TENANT_CONTROLLER_CA_KEY_SECRET = 'tenant-controller-ca-key';
/**
 * The Secret in the platform namespace that holds the tenant's controller CAs with their keys
 * (#170): `ca.crt` and `ca.key` sign the serving leaf; during a rotation `next.crt`/`next.key` and
 * `previous.crt` hold the other CAs in the trust bundle. No pod mounts it and no tenant
 * ServiceAccount or member can read it, and it survives deleting `tenant-controller-tls`.
 */
function tenantControllerCaSecret(tenant: string): string {
  return `tenant-controller-ca-${tenant}`;
}
/** Digest of the trust bundle on the console's pod template (#170). */
export const CA_BUNDLE_ANNOTATION = `${GROUP}/ca-bundle-sha256`;
/**
 * The PEM bundle clients trust (ConfigMap `tenant-controller-ca`): the CAs of `tls`, oldest first,
 * so switching which CA signs the leaf keeps the same bytes and does not roll the hosts.
 */
function controllerTrustBundle(tls: TenantAuthInputs['tls']): string {
  return [tls.caPrevious, tls.caCert, tls.caNext?.cert].filter(Boolean).join('');
}
/**
 * The tenant's members, published for the tenant controller's `/-/members` (#321), so it reads no
 * User for that listing:
 * - `entries`: every membership with its role and whether the user is suspended
 *   ({@link TenantMember}), sorted by name and role;
 * - `members`: the active members' names only, which tenant-auth images that predate `entries`
 *   read (each one's User by name: the controller may `get` only those Users).
 */
export const TENANT_MEMBERS_CONFIG = 'tenant-controller-members';
/** The ConfigMap data of {@link TENANT_MEMBERS_CONFIG}. */
function membersConfigData(members: TenantMember[], active: string[]): Record<string, string> {
  const entries = members
    .map(({ name, role, suspended }) => ({ name, role, suspended }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.role.localeCompare(b.role));
  return { members: JSON.stringify(active), entries: JSON.stringify(entries) };
}
/** Digest of the serving certificate; in both pod templates so a renewal rolls the pair. */
function tlsCertDigest(cert: string): string {
  return createHash('sha256').update(cert).digest('hex');
}
/** The issuer-proxy sidecar, pinned by digest (`alpine/socat:1.8.0.0`). */
export const ISSUER_PROXY_IMAGE =
  'alpine/socat@sha256:a6be4c0262b339c53ddad723cdd178a1a13271e1137c65e27f90a08c16de02b8';
/** The ServiceAccount token, CA and namespace, projected into the controller container only. */
const serviceAccountVolume = () => ({
  name: 'service-account',
  projected: {
    sources: [
      { serviceAccountToken: { path: 'token', expirationSeconds: 3607 } },
      { configMap: { name: 'kube-root-ca.crt', items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
      {
        downwardAPI: {
          items: [{ path: 'namespace', fieldRef: { fieldPath: 'metadata.namespace' } }],
        },
      },
    ],
  },
});
/**
 * The tenant's controller and console (#58), ported from `tenant-auth/scripts/deploy-local.ts`.
 * They run in the tenant's runtime namespace, next to the `di-http` Service the controller
 * proxies to; the runtime quota grows by {@link TENANT_AUTH_LIMITS} to hold them.
 */
function tenantAuthResources(
  tenant: Tenant,
  cfg: ControllerConfig,
  inputs: TenantAuthInputs,
): Resource[] {
  const auth = cfg.tenantAuth;
  if (!auth) return [];
  const name = tenant.metadata.name;
  const n = names(name);
  const namespace = n.runtimeNamespace;
  const suspended = tenant.spec.suspended || !!tenant.metadata.deletionTimestamp;
  const make = (
    apiVersion: string,
    kind: string,
    resourceName: string,
    ns: string | undefined,
    body: Record<string, unknown>,
  ) => {
    const value = resource(tenant, cfg.installation, apiVersion, kind, resourceName, ns, body);
    value.metadata.labels![COMPONENT] = 'tenant-auth';
    return value;
  };
  const rbac = 'rbac.authorization.k8s.io/v1';
  const subjects = [{ kind: 'ServiceAccount', name: 'tenant-controller', namespace }];
  const issuer = new URL(auth.issuer);
  const issuerPort = Number(issuer.port || (issuer.protocol === 'https:' ? 443 : 80));
  const issuerIp =
    auth.issuerIp ?? (/^\d+\.\d+\.\d+\.\d+$/.test(issuer.hostname) ? issuer.hostname : undefined);
  const loopback = loopbackHost(issuer.hostname);
  const sidecarTarget = auth.issuerUpstream ?? (auth.issuerIp && `${auth.issuerIp}:${issuerPort}`);
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };
  const deployment = (
    app: 'tenant-controller' | 'tenant-console',
    port: number,
    env: Record<string, string>,
    extraEnv: unknown[],
    volume: Record<string, unknown>,
    mountPath: string,
    extraPorts: { containerPort: number; name: string }[] = [],
  ) =>
    make('apps/v1', 'Deployment', app, namespace, {
      spec: {
        // One replica: the controller keeps proxy sessions in memory. Recreate, because a
        // surge pod would not fit the runtime quota.
        replicas: suspended ? 0 : 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app } },
        template: {
          metadata: {
            labels: { app, [COMPONENT]: 'tenant-auth', [TENANT]: name },
            // The image reference rolls the pods; the digest is repeated here for operators. Both
            // binaries read the certificate (or CA) once at start, so its digest rolls the pair.
            // The console also reads the trust bundle once and copies it into the kubeconfigs it
            // issues, so a bundle change during a CA rotation (#170) rolls it too.
            annotations: {
              [`${GROUP}/image-digest`]: auth.image.split('@')[1],
              [`${GROUP}/tls-cert-sha256`]: tlsCertDigest(inputs.tls.cert),
              ...(app === 'tenant-console'
                ? { [CA_BUNDLE_ANNOTATION]: tlsCertDigest(controllerTrustBundle(inputs.tls)) }
                : {}),
            },
          },
          spec: {
            serviceAccountName: app,
            // Never automounted: the controller's token is projected into its own container
            // only, so the issuer-proxy sidecar holds no credential.
            automountServiceAccountToken: false,
            ...(!loopback && auth.issuerIp
              ? { hostAliases: [{ ip: auth.issuerIp, hostnames: [issuer.hostname] }] }
              : {}),
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: app,
                image: auth.image,
                command: [
                  'bun',
                  `/app/${app === 'tenant-controller' ? 'controller' : 'console'}.js`,
                ],
                env: [
                  { name: 'TMPDIR', value: '/tmp' },
                  ...Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
                  ...extraEnv,
                ],
                ports: [{ containerPort: port, name: 'http' }, ...extraPorts],
                readinessProbe: {
                  httpGet:
                    app === 'tenant-controller'
                      ? { path: '/-/healthz', port, scheme: 'HTTPS' }
                      : { path: '/healthz', port, scheme: 'HTTP' },
                  periodSeconds: 5,
                },
                resources: {
                  requests: { cpu: '50m', memory: '96Mi' },
                  limits: { cpu: '200m', memory: '192Mi' },
                },
                securityContext,
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  { name: 'mounted', mountPath, readOnly: true },
                  ...(app === 'tenant-controller'
                    ? [
                        {
                          name: 'service-account',
                          mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
                          readOnly: true,
                        },
                      ]
                    : []),
                ],
              },
              ...(loopback && sidecarTarget
                ? [
                    {
                      name: 'issuer-proxy',
                      image: ISSUER_PROXY_IMAGE,
                      args: [
                        `TCP-LISTEN:${issuerPort},fork,reuseaddr,bind=127.0.0.1`,
                        `TCP:${sidecarTarget}`,
                      ],
                      resources: {
                        requests: { cpu: '10m', memory: '16Mi' },
                        limits: { cpu: '50m', memory: '32Mi' },
                      },
                      securityContext,
                    },
                  ]
                : []),
            ],
            volumes: [
              { name: 'tmp', emptyDir: {} },
              { name: 'mounted', ...volume },
              ...(app === 'tenant-controller' ? [serviceAccountVolume()] : []),
            ],
          },
        },
      },
    });
  const service = (app: string, port: number, extra: { port: number; name: string }[] = []) =>
    make('v1', 'Service', app, namespace, {
      spec: {
        selector: { app },
        ports: [{ port, targetPort: port, name: 'http' }, ...extra].map((value) => ({
          ...value,
          targetPort: value.port,
        })),
      },
    });
  const registry = auth.registry;
  const registryHost = registryHttpHost(auth);
  const hostPods = {
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
    podSelector: {
      matchLabels: { 'wasmcloud.com/hostgroup': n.hostgroup, 'wasmcloud.com/name': 'hostgroup' },
    },
  };
  const publicUrl = (pattern: string | undefined, fallback: string) =>
    expandTenant(pattern ?? fallback, name);
  const [upstreamHost = '', upstreamPort = '80'] = (auth.issuerUpstream ?? '').split(':');
  const egress: unknown[] = [];
  if (inputs.apiServer.addresses.length)
    egress.push({
      to: inputs.apiServer.addresses.map((ip) => ({
        ipBlock: { cidr: `${ip}/${ip.includes(':') ? 128 : 32}` },
      })),
      ports: [{ protocol: 'TCP', port: inputs.apiServer.port }],
    });
  if (auth.issuerUpstream)
    egress.push({
      to: [
        {
          namespaceSelector: {
            matchLabels: {
              'kubernetes.io/metadata.name': upstreamHost.split('.')[1] ?? cfg.namespace,
            },
          },
        },
      ],
      ports: [
        ...new Set([Number(upstreamPort), auth.issuerUpstreamPodPort ?? Number(upstreamPort)]),
      ].map((port) => ({ protocol: 'TCP', port })),
    });
  else if (issuerIp)
    egress.push({
      to: [{ ipBlock: { cidr: `${issuerIp}/32` } }],
      ports: [{ protocol: 'TCP', port: issuerPort }],
    });
  egress.push(
    // The service proxy (#56) reaches the tenant hosts through `di-http`; NetworkPolicy sees
    // the pod port after the Service's DNAT, 9191.
    {
      to: [
        {
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
          podSelector: {
            matchLabels: {
              'wasmcloud.com/hostgroup': n.hostgroup,
              'wasmcloud.com/name': 'hostgroup',
            },
          },
        },
      ],
      ports: [{ protocol: 'TCP', port: 9191 }],
    },
    {
      to: [
        { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
      ],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
  );
  const base64 = (text: string) => Buffer.from(text).toString('base64');
  // Active members only: a suspended member keeps its entry in the published list, not its access.
  const members = [...new Set(inputs.members.filter((m) => !m.suspended).map((m) => m.name))].sort(
    (a, b) => a.localeCompare(b),
  );
  const result: Resource[] = [
    make('v1', 'ServiceAccount', 'tenant-controller', namespace, {
      automountServiceAccountToken: false,
    }),
    make('v1', 'ServiceAccount', 'tenant-console', namespace, {
      automountServiceAccountToken: false,
    }),
    // The tenancy CRs it checks on every request: its own Tenant and its members' Users only
    // (#321). With no members there is no users rule: empty resourceNames would mean every name.
    make(rbac, 'ClusterRole', `di-tenant-controller-${name}`, undefined, {
      rules: [
        { apiGroups: [GROUP], resources: ['tenants'], verbs: ['get'], resourceNames: [name] },
        ...(members.length
          ? [{ apiGroups: [GROUP], resources: ['users'], verbs: ['get'], resourceNames: members }]
          : []),
      ],
    }),
    // TokenRequest only for the tenant's members, recomputed from the User CRs on every
    // reconcile. With no members there is no rule: empty resourceNames would mean every name.
    make(rbac, 'Role', `di-tenant-controller-${name}`, cfg.namespace, {
      rules: members.length
        ? [
            {
              apiGroups: [''],
              resources: ['serviceaccounts/token'],
              verbs: ['create'],
              resourceNames: members.map((m) => `di-user-${m}`),
            },
          ]
        : [],
    }),
    // In its own namespace, only the member list it reads for `/-/members`: no Secret rule
    // (#379). While API keys are still being moved out of it, it may also read them there; that
    // rule goes in the pass that finds none left (see `migrateApiKeys`).
    make(rbac, 'Role', 'tenant-controller-keys', namespace, {
      rules: [
        {
          apiGroups: [''],
          resources: ['configmaps'],
          verbs: ['get'],
          resourceNames: [TENANT_MEMBERS_CONFIG],
        },
        ...(inputs.legacyApiKeys
          ? [{ apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list'] }]
          : []),
      ],
    }),
    // API-key Secrets, in `di-apikeys-<tenant>`, which holds nothing else (#379). Secret names
    // are generated, so `resourceNames` cannot narrow these; the `tenant-controller-secrets`
    // admission policy limits its writes to API-key Secrets of its own tenant (#321).
    make(rbac, 'Role', 'tenant-controller-keys', n.apiKeysNamespace, {
      rules: [
        { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'create', 'delete'] },
      ],
    }),
    // Tenant developers can only write Secrets (#112), so `/v1` reads them as the controller;
    // writes still go through as the calling user.
    make(rbac, 'Role', 'tenant-controller-secret-reader', n.namespace, {
      rules: [{ apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list'] }],
    }),
  ];
  // A suspended tenant keeps the roles but loses the bindings (revoked with the members').
  if (!suspended)
    result.push(
      make(rbac, 'ClusterRoleBinding', `di-tenant-controller-${name}`, undefined, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: `di-tenant-controller-${name}`,
        },
        subjects,
      }),
      make(rbac, 'RoleBinding', `di-tenant-controller-${name}`, cfg.namespace, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: `di-tenant-controller-${name}`,
        },
        subjects,
      }),
      ...[namespace, n.apiKeysNamespace].map((ns) =>
        make(rbac, 'RoleBinding', 'tenant-controller-keys', ns, {
          roleRef: {
            apiGroup: 'rbac.authorization.k8s.io',
            kind: 'Role',
            name: 'tenant-controller-keys',
          },
          subjects,
        }),
      ),
      make(rbac, 'RoleBinding', 'tenant-controller-secret-reader', n.namespace, {
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'tenant-controller-secret-reader',
        },
        subjects,
      }),
    );
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'tenant-auth-egress', namespace, {
      spec: {
        podSelector: { matchLabels: { [COMPONENT]: 'tenant-auth' } },
        policyTypes: ['Egress'],
        egress,
      },
    }),
  );
  // The pair is left out of di-tenant-network, so this is all the traffic it is part of beyond
  // the gateway policies below: the same egress as the tenant's other pods, the console's calls
  // to the controller, and (with a registry) the tenant hosts' calls to the whoami (8789) and
  // registry pull (8791) listeners only.
  result.push(
    make('networking.k8s.io/v1', 'NetworkPolicy', 'tenant-auth-network', namespace, {
      spec: {
        podSelector: { matchLabels: { [COMPONENT]: 'tenant-auth' } },
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
                podSelector: { matchLabels: { app: 'tenant-console' } },
              },
            ],
            ports: [{ protocol: 'TCP', port: 8788 }],
          },
          ...(registry
            ? [
                {
                  from: [hostPods],
                  ports: [WHOAMI_PORT, REGISTRY_PULL_PORT].map((port) => ({
                    protocol: 'TCP',
                    port,
                  })),
                },
              ]
            : []),
        ],
        egress: tenantNetworkEgress(name, cfg),
      },
    }),
  );
  // The platform gateway reaches the routed ports only: the console over HTTP, the controller
  // and the registry front as TLS passthrough (they terminate with the controller certificate).
  const { routes } = tenantAuthRoutes(auth, cfg.routeUrlPattern);
  const routed = [
    ...(routes.console ? [['tenant-console', 'tenant-console', 8787] as const] : []),
    ...(routes.controller ? [['tenant-controller', 'tenant-controller', 8788] as const] : []),
    ...(routes.registry
      ? [['tenant-registry', 'tenant-controller', REGISTRY_FRONT_PORT] as const]
      : []),
  ];
  for (const [policy, app, port] of routed)
    result.push(
      make('networking.k8s.io/v1', 'NetworkPolicy', `${policy}-gateway`, namespace, {
        spec: {
          podSelector: { matchLabels: { app } },
          policyTypes: ['Ingress'],
          ingress: [
            {
              from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': cfg.namespace },
                  },
                  podSelector: { matchLabels: GATEWAY_POD_LABELS },
                },
              ],
              ports: [{ protocol: 'TCP', port }],
            },
          ],
        },
      }),
    );
  result.push(
    // Applied first, so a CA is never published (bundle, leaf) before its key is stored (#170).
    // Not mounted by any pod: lets a leaf renewal keep the CA (and so the hosts and kubeconfigs),
    // and keeps the CA when `tenant-controller-tls` is deleted. In the platform namespace, out of
    // the tenant controller's reach.
    make('v1', 'Secret', tenantControllerCaSecret(name), cfg.namespace, {
      type: 'Opaque',
      data: {
        'ca.crt': base64(inputs.tls.caCert),
        'ca.key': base64(inputs.tls.caKey),
        ...(inputs.tls.caNext
          ? {
              'next.crt': base64(inputs.tls.caNext.cert),
              'next.key': base64(inputs.tls.caNext.key),
            }
          : {}),
        ...(inputs.tls.caPrevious ? { 'previous.crt': base64(inputs.tls.caPrevious) } : {}),
      },
    }),
    make('v1', 'ConfigMap', TENANT_MEMBERS_CONFIG, namespace, {
      data: membersConfigData(inputs.members, members),
    }),
    // Every CA of a rotation, so hosts and clients that reload it accept the leaf on either side.
    make('v1', 'ConfigMap', 'tenant-controller-ca', namespace, {
      data: { 'ca.crt': controllerTrustBundle(inputs.tls) },
    }),
    make('v1', 'Secret', 'tenant-controller-tls', namespace, {
      type: 'kubernetes.io/tls',
      data: {
        'tls.crt': base64(inputs.tls.cert),
        'tls.key': base64(inputs.tls.key),
        'ca.crt': base64(inputs.tls.caCert),
      },
    }),
  );
  const hostPullToken = registry ? inputs.hostPullToken : undefined;
  if (hostPullToken)
    result.push(
      make('v1', 'Secret', REGISTRY_PULL_SECRET, namespace, {
        type: 'Opaque',
        data: registryPullSecretData(name, hostPullToken),
      }),
    );
  if (inputs.clientSecret)
    result.push(
      make('v1', 'Secret', 'tenant-console-oauth', namespace, {
        type: 'Opaque',
        data: { clientSecret: inputs.clientSecret },
      }),
    );
  result.push(
    deployment(
      'tenant-controller',
      8788,
      {
        TENANT_CONTROLLER_TENANT: name,
        TENANT_CONTROLLER_PLATFORM_NAMESPACE: cfg.namespace,
        TENANT_CONTROLLER_ISSUER: auth.issuer,
        TENANT_CONTROLLER_HOST: '0.0.0.0',
        TENANT_CONTROLLER_PORT: '8788',
        TENANT_CONTROLLER_TLS_CERT: '/tls/tls.crt',
        TENANT_CONTROLLER_TLS_KEY: '/tls/tls.key',
        ...(registry
          ? {
              TENANT_CONTROLLER_WHOAMI_PORT: String(WHOAMI_PORT),
              TENANT_CONTROLLER_REGISTRY_HOST: registryHost,
              TENANT_CONTROLLER_REGISTRY_PULL_HOST: registryPullHost(name),
              ...registryLimitsEnv(registry.limits),
            }
          : {}),
        ...(hostPullToken
          ? { TENANT_CONTROLLER_HOST_PULL_TOKEN_FILE: '/tls/host-pull-token' }
          : {}),
        ...(registry && inputs.registryServing
          ? {
              TENANT_CONTROLLER_REGISTRY_FRONT_PORT: String(REGISTRY_FRONT_PORT),
              TENANT_CONTROLLER_REGISTRY_URL: tenantRegistryPublicUrl(name, auth),
              TENANT_CONTROLLER_REGISTRY_PULL_PORT: String(REGISTRY_PULL_PORT),
            }
          : {}),
      },
      [],
      // The pull token is read from the file on every whoami call, so a rotation needs no restart.
      hostPullToken
        ? {
            projected: {
              sources: [
                { secret: { name: 'tenant-controller-tls' } },
                {
                  secret: {
                    name: REGISTRY_PULL_SECRET,
                    items: [{ key: 'token', path: 'host-pull-token' }],
                  },
                },
              ],
            },
          }
        : { secret: { secretName: 'tenant-controller-tls' } },
      '/tls',
      registry
        ? [
            { containerPort: WHOAMI_PORT, name: 'whoami' },
            { containerPort: REGISTRY_FRONT_PORT, name: 'registry' },
            { containerPort: REGISTRY_PULL_PORT, name: 'pull' },
          ]
        : [],
    ),
    deployment(
      'tenant-console',
      8787,
      {
        TENANT_CONSOLE_TENANT: name,
        TENANT_CONSOLE_ISSUER: auth.issuer,
        TENANT_CONSOLE_CLIENT_ID: auth.oauthClient.id,
        TENANT_CONSOLE_HOST: '0.0.0.0',
        TENANT_CONSOLE_PORT: '8787',
        TENANT_CONSOLE_PUBLIC_URL: publicUrl(auth.consolePublicUrl, 'http://127.0.0.1:8787'),
        TENANT_CONSOLE_CONTROLLER_URL: 'https://tenant-controller:8788',
        TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: tenantControllerPublicUrl(name, auth),
        TENANT_CONSOLE_CONTROLLER_CA: '/ca/ca.crt',
      },
      [
        {
          name: 'TENANT_CONSOLE_CLIENT_SECRET',
          valueFrom: { secretKeyRef: { name: 'tenant-console-oauth', key: 'clientSecret' } },
        },
      ],
      { configMap: { name: 'tenant-controller-ca' } },
      '/ca',
    ),
    service(
      'tenant-controller',
      8788,
      registry
        ? [
            { port: WHOAMI_PORT, name: 'whoami' },
            { port: REGISTRY_FRONT_PORT, name: 'registry' },
          ]
        : [],
    ),
    service('tenant-console', 8787),
  );
  // The hosts pull through this Service with no port in the reference: 443 (TLS).
  if (registry)
    result.push(
      make('v1', 'Service', REGISTRY_PULL_SERVICE, namespace, {
        spec: {
          selector: { app: 'tenant-controller' },
          ports: [
            {
              name: 'pull',
              port: 443,
              targetPort: REGISTRY_PULL_PORT,
            },
          ],
        },
      }),
      registryWorkload(tenant, cfg, registry, registryHost, inputs.registryNats),
    );
  return result;
}
/**
 * The tenant registry (#83): `platform/oci-registry` on the tenant's own hosts. Its storage is
 * the unnamed blobstore, configured with the NATS backend pointing to the tenant's `di-nats`
 * for persistent blob and manifest storage. The component reads the whoami URL and the tenant
 * through `wasmcloud:secrets` bind-time config; admission admits that interface from the
 * platform controller only, so a tenant cannot repoint it. The whoami URL is https to the
 * controller Service (#113): {@link registryWhoamiHost} is one of the controller certificate's
 * names, and the hosts trust the tenant CA through `--http-client-ca-path`.
 *
 * `nats` (#159): with `credentials` the blobstore entry logs in to the registry's own NATS
 * account from the files of the hosts' read-only Secret mount; while `stopped` it does not run,
 * so nothing writes to the store the Job moves and nothing recreates it in `TENANT`; absent, it
 * connects anonymously and lands in the `TENANT` account.
 */
function registryWorkload(
  tenant: Tenant,
  cfg: ControllerConfig,
  registry: TenantRegistryConfig,
  host: string,
  nats?: RegistryNatsMode,
): Resource {
  const name = tenant.metadata.name;
  const n = names(name);
  const suspended =
    tenant.spec.suspended || !!tenant.metadata.deletionTimestamp || nats === 'stopped';
  const whoami = `${registryWhoamiHost(name)}:${WHOAMI_PORT}`;
  const value = resource(
    tenant,
    cfg.installation,
    'runtime.wasmcloud.dev/v1alpha1',
    'WorkloadDeployment',
    REGISTRY_WORKLOAD,
    n.namespace,
    {
      spec: {
        replicas: suspended ? 0 : 1,
        template: {
          spec: {
            environment: n.namespace,
            hostSelector: { hostgroup: n.hostgroup },
            components: [
              {
                name: 'oci-registry',
                image: registry.component,
                // Hosts run with --socket-egress=enforce; the whoami call (https, the same
                // host and port) is the only egress.
                localResources: { allowedHosts: [whoami] },
              },
            ],
            hostInterfaces: [
              {
                namespace: 'wasi',
                package: 'http',
                version: '0.3.0',
                interfaces: ['handler'],
                config: { host },
              },
              {
                namespace: 'wasmcloud',
                package: 'blobstore',
                version: '0.1.0',
                interfaces: ['blobstore', 'container', 'types'],
                config: {
                  backend: 'nats',
                  url: `nats://di-nats.${n.runtimeNamespace}.svc.cluster.local:4222`,
                  ...(nats === 'credentials'
                    ? {
                        user_file: REGISTRY_NATS_USER_FILE,
                        password_file: REGISTRY_NATS_PASSWORD_FILE,
                      }
                    : {}),
                },
              },
              {
                namespace: 'wasmcloud',
                package: 'secrets',
                interfaces: ['store', 'reveal'],
                config: { 'tenant-controller-url': `https://${whoami}`, tenant: name },
              },
            ],
          },
        },
      },
    },
  );
  value.metadata.labels![COMPONENT] = 'tenant-auth';
  return value;
}

export type {
  BackingCapability,
  BackingProvider,
  BackingService,
  BackingServiceClass,
  BackingServiceClassSpec,
  BackingServiceClassStatus,
  BackingServiceSpec,
  BackingServiceStatus,
  ClassVisibility,
  DeletionPolicy,
  EndpointSummary,
  ServiceBinding,
  ServiceBindingSpec,
  ServiceBindingStatus,
  SizingParameters,
} from './backing-services';
export {
  assertUniqueDefaults,
  BINDING,
  backingServiceCrds,
  bindingMatchesService,
  CAPABILITIES,
  CLASS,
  COMPATIBLE,
  CREDENTIAL_STATUS_KEYS,
  classVisibleToTenant,
  compatibleProvider,
  DEFAULT_CLASS_NAMES,
  DELETION_POLICIES,
  defaultClassName,
  defaultClassSeed,
  PROVIDERS,
  resolveClassName,
  SERVICE,
  statusContainsCredentials,
  validateBindingSpec,
  validateClassSpec,
  validateServiceSpec,
} from './backing-services';
export {
  apiKeysQuota,
  COMPONENT,
  controllerTrustBundle,
  crds,
  FINALIZER,
  GATEWAY_NAME,
  GATEWAY_POD_LABELS,
  GROUP,
  INSTALLATION,
  NAMESPACE_ROLE,
  names,
  OWNER,
  ROUTES_CONFIG_NAME,
  registryWorkload,
  resource,
  runtimeQuota,
  TENANT,
  TENANT_CONTROLLER_CA_KEY_SECRET,
  tenantAuthResources,
  tenantControllerCaSecret,
  tenantControllerCertNames,
  tenantQuota,
  tenantResources,
  tlsCertDigest,
  USER,
  userResources,
  userTokenSecretName,
  VERSION,
  validName,
};
