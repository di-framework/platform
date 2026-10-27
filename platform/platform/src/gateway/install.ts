import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { platformNamespacePeer, tenantNamespacesPeer } from '../platform-ingress';
import {
  GATEWAY_NAME,
  GATEWAY_POD_LABELS,
  NAMESPACE_ROLE,
  type TenantAuthRoutes,
} from '../tenancy/resources';
import type { GatewayConfig } from './gateway';
import { parseRoute, reservedRouteHosts } from './gateway';

export { GATEWAY_NAME, GATEWAY_POD_LABELS };
export const GATEWAY_PORT = 8080;

type Selector = {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
};

/** Placeholders a route URL pattern must carry, e.g. `http://{host}.{tenant}.localhost:28180`. */
export function validateRouteUrlPattern(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  if (!/^https?:\/\/\{host\}\.\{tenant\}\.[^/]+$/.test(pattern))
    throw new Error(
      `routeUrlPattern must look like http://{host}.{tenant}.localhost:<port>; received ${pattern}`,
    );
  return pattern;
}

/** What `validateRouteAliases` checks aliases against. */
export interface RouteAliasRules {
  /** Configured console, controller and registry route hosts; both alias sides must avoid them. */
  tenantAuthRoutes?: TenantAuthRoutes;
  /** Declared tenant names; when given, every alias target must name one of them. */
  tenants?: readonly string[];
}

const ALIAS_SHAPE = 'an object mapping "<route-host>.<tenant>" to "<route-host>.<tenant>"';

/**
 * Validate admin route aliases (#217) and return them normalized: sources and targets lower-cased
 * and sources sorted, so the deployed `GATEWAY_CONFIG` and its config hash depend on neither the
 * spelling nor the order of the configured keys. Unset is `{}`. Throws when the value is not
 * such an object, a side is not `<route-host>.<tenant>` with DNS-1123 labels, a side uses a
 * reserved route host (`console`, `controller`, `registry` and the configured tenant-auth hosts),
 * a target names an undeclared tenant, two sources differ only in case, or a target is another
 * alias's source (a chain; every cycle is also a chain). A self-alias is a no-op and allowed.
 */
export function validateRouteAliases(
  aliases: unknown,
  rules: RouteAliasRules = {},
): Record<string, string> {
  if (aliases === undefined || aliases === null) return {};
  if (typeof aliases !== 'object' || Array.isArray(aliases))
    throw new Error(`routeAliases must be ${ALIAS_SHAPE}`);
  const reserved = reservedRouteHosts(rules.tenantAuthRoutes);
  const normalized = new Map<string, string>();
  for (const [rawSource, rawTarget] of Object.entries(aliases)) {
    if (typeof rawTarget !== 'string')
      throw new Error(`routeAliases["${rawSource}"] must be a "<route-host>.<tenant>" string`);
    const source = rawSource.toLowerCase();
    const target = rawTarget.toLowerCase();
    aliasSide('source', source, reserved);
    const route = aliasSide('target', target, reserved);
    if (rules.tenants && !rules.tenants.includes(route.tenant))
      throw new Error(`Route alias target "${target}" names undeclared tenant ${route.tenant}`);
    if (normalized.has(source))
      throw new Error(`Duplicate route alias source "${source}" (sources are case-insensitive)`);
    normalized.set(source, target);
  }
  for (const [source, target] of normalized)
    if (target !== source && normalized.has(target))
      throw new Error(`Chained route aliases are not allowed: ${source} -> ${target} -> ...`);
  return Object.fromEntries([...normalized].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** One side of an alias, parsed; throws unless it is a valid, unreserved route. */
function aliasSide(
  side: 'source' | 'target',
  value: string,
  reserved: Set<string>,
): { host: string; tenant: string } {
  const route = parseRoute(value);
  if (!route)
    throw new Error(
      `Invalid route alias ${side} "${value}": expected <route-host>.<tenant> with DNS-1123 labels`,
    );
  if (reserved.has(route.host))
    throw new Error(`Route alias ${side} "${value}" uses the reserved route host ${route.host}`);
  return route;
}

/** Route pattern for a loopback HTTP endpoint (the gateway's published port); otherwise none. */
export function routeUrlPatternFor(httpEndpoint: string | undefined): string | undefined {
  if (!httpEndpoint) return undefined;
  let url: URL;
  try {
    url = new URL(httpEndpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    return undefined;
  return `http://{host}.{tenant}.localhost${url.port ? `:${url.port}` : ''}`;
}

/** Load the compiled gateway script from the package dist (`tsc` emit under `gateway/`). */
export function loadGatewayScript(gatewayDir: string = __dirname): Record<string, string> {
  return { 'gateway.js': readFileSync(path.join(gatewayDir, 'gateway.js'), 'utf8') };
}

export function gatewayScriptHash(scripts: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(scripts)).digest('hex');
}

/**
 * Hash of the routing config (tenant-auth routes and route aliases) for the pod template's
 * `di-framework.dev/config-hash` annotation, so changing either rolls the gateway. Pass aliases
 * already normalized by `validateRouteAliases`, so reordering keys does not change the hash.
 */
export function gatewayConfigHash(
  tenantAuthRoutes?: TenantAuthRoutes,
  routeAliases?: Record<string, string>,
): string {
  const configData = {
    tenantAuthRoutes: tenantAuthRoutes ?? {},
    routeAliases: routeAliases ?? {},
  };
  return createHash('sha256').update(JSON.stringify(configData)).digest('hex');
}

/**
 * Rollout drain timing (#223). On termination the pod first sleeps `GATEWAY_PRESTOP_SECONDS` while
 * still serving, so the Service endpoint removal reaches every node's proxy before the listener
 * closes. Then SIGTERM drains for at most `GATEWAY_DRAIN_SECONDS`. The grace period covers both
 * with a margin, so the kubelet never kills a drain that is within its bound.
 */
export const GATEWAY_PRESTOP_SECONDS = 10;
export const GATEWAY_DRAIN_SECONDS = 20;
export const GATEWAY_TERMINATION_GRACE_SECONDS =
  GATEWAY_PRESTOP_SECONDS + GATEWAY_DRAIN_SECONDS + 5;

/**
 * Gateway Deployment spec. It needs no Kubernetes API access, so it mounts no token. A rollout
 * surges a new pod and keeps the old one until the new one has been Ready for `minReadySeconds`
 * (`maxUnavailable: 0`), and the old pod drains as described above, so a roll (a `routeAliases`
 * change, say) drops no requests.
 */
export function gatewayDeploymentSpec(
  namespace: string,
  scriptHash: string,
  tenantAuthRoutes: TenantAuthRoutes = {},
  routeAliases?: Record<string, string>,
) {
  const config: GatewayConfig = {
    port: GATEWAY_PORT,
    defaultUpstream: `wasmcloud-http.${namespace}.svc.cluster.local`,
    ...(Object.keys(tenantAuthRoutes).length ? { tenantAuthRoutes } : {}),
    ...(routeAliases && Object.keys(routeAliases).length ? { routeAliases } : {}),
    drainTimeoutMs: GATEWAY_DRAIN_SECONDS * 1000,
  };
  const configHash = gatewayConfigHash(tenantAuthRoutes, routeAliases);
  return {
    replicas: 1,
    strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
    // Lets the new pod's endpoint reach every node's proxy before the old pod starts terminating.
    minReadySeconds: 5,
    selector: { matchLabels: GATEWAY_POD_LABELS },
    template: {
      metadata: {
        labels: GATEWAY_POD_LABELS,
        annotations: {
          'di-framework.dev/script-hash': scriptHash,
          'di-framework.dev/config-hash': configHash,
        },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: GATEWAY_TERMINATION_GRACE_SECONDS,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'gateway',
            // The controller image: no extra pull for the gateway.
            image: 'node:22.18.0-alpine3.22',
            command: ['node', '/gateway/gateway.js'],
            env: [{ name: 'GATEWAY_CONFIG', value: JSON.stringify(config) }],
            ports: [{ name: 'http', containerPort: GATEWAY_PORT }],
            readinessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 2 },
            livenessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 10 },
            // The image's busybox `sleep`: keep serving until the endpoint removal propagates.
            lifecycle: {
              preStop: { exec: { command: ['sleep', String(GATEWAY_PRESTOP_SECONDS)] } },
            },
            resources: {
              requests: { cpu: '20m', memory: '32Mi' },
              limits: { cpu: '500m', memory: '128Mi' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
            volumeMounts: [{ name: 'script', mountPath: '/gateway', readOnly: true }],
          },
        ],
        volumes: [{ name: 'script', configMap: { name: GATEWAY_NAME } }],
      },
    },
  };
}

/** The published HTTP port belongs to the gateway; `wasmcloud-http` stays its ClusterIP backend. */
export function gatewayServiceSpec(nodePort: number) {
  return {
    type: nodePort ? 'NodePort' : 'ClusterIP',
    selector: GATEWAY_POD_LABELS,
    ports: [
      {
        name: 'http',
        port: 80,
        targetPort: 'http',
        ...(nodePort ? { nodePort } : {}),
        protocol: 'TCP',
      },
    ],
  };
}

/** Gateway egress: cluster DNS and host group HTTP only (default and tenant runtimes), plus the
 * routed tenant console (8787), controller (8788) and registry front (8790) ports when
 * tenant-auth routes are set. Ingress is open only when `published` (a NodePort is set).
 * Tenant runtimes admit it through their own `di-tenant-gateway` / `tenant-*-gateway` policies. */
export function gatewayNetworkPolicySpec(
  namespace: string,
  installation: string,
  tenantAuthRoutes: TenantAuthRoutes = {},
  published = false,
) {
  const tenantNamespaces: Selector = tenantNamespacesPeer(installation);
  const routed = [
    ...(tenantAuthRoutes.console ? [['tenant-console', 8787] as const] : []),
    ...(tenantAuthRoutes.controller ? [['tenant-controller', 8788] as const] : []),
    // The tenant registry's TLS front runs in the controller pod (#83:reconcile).
    ...(tenantAuthRoutes.registry ? [['tenant-controller', 8790] as const] : []),
  ].map(([app, port]) => ({
    to: [
      {
        // Only this installation's `di-runtime-<tenant>` namespaces run the pair.
        namespaceSelector: {
          ...tenantNamespaces,
          matchLabels: { ...tenantNamespaces.matchLabels, [NAMESPACE_ROLE]: 'runtime' },
        },
        podSelector: { matchLabels: { app } },
      },
    ],
    ports: [{ protocol: 'TCP', port }],
  }));
  const hostgroup: Selector = { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } };
  const hosts: { namespaceSelector: Selector; podSelector: Selector }[] = [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } },
      podSelector: hostgroup,
    },
    { namespaceSelector: tenantNamespaces, podSelector: hostgroup },
  ];
  return {
    podSelector: { matchLabels: GATEWAY_POD_LABELS },
    policyTypes: ['Ingress', 'Egress'],
    // Published through a NodePort, the gateway is the instance's entry point and admits any
    // source. Otherwise only this instance's platform and tenant namespaces reach it (#457).
    ingress: [
      {
        ...(published
          ? {}
          : {
              from: [
                platformNamespacePeer(namespace),
                { namespaceSelector: tenantNamespacesPeer(installation) },
              ],
            }),
        ports: [{ protocol: 'TCP', port: GATEWAY_PORT }],
      },
    ],
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: {
              matchExpressions: [
                { key: 'k8s-app', operator: 'In', values: ['kube-dns', 'coredns'] },
              ],
            },
          },
        ],
        ports: [
          { protocol: 'UDP', port: 53 },
          { protocol: 'TCP', port: 53 },
        ],
      },
      { to: hosts, ports: [{ protocol: 'TCP', port: 9191 }] },
      ...routed,
    ],
  };
}
