import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  GATEWAY_NAME,
  GATEWAY_POD_LABELS,
  INSTALLATION,
  NAMESPACE_ROLE,
  TENANT,
  type TenantAuthRoutes,
} from '../tenancy/resources';
import type { GatewayConfig } from './gateway';

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

/** Gateway Deployment spec. It needs no Kubernetes API access, so it mounts no token. */
export function gatewayDeploymentSpec(
  namespace: string,
  scriptHash: string,
  tenantAuthRoutes: TenantAuthRoutes = {},
) {
  const config: GatewayConfig = {
    port: GATEWAY_PORT,
    defaultUpstream: `wasmcloud-http.${namespace}.svc.cluster.local`,
    ...(Object.keys(tenantAuthRoutes).length ? { tenantAuthRoutes } : {}),
  };
  return {
    replicas: 1,
    selector: { matchLabels: GATEWAY_POD_LABELS },
    template: {
      metadata: {
        labels: GATEWAY_POD_LABELS,
        annotations: { 'di-framework.dev/script-hash': scriptHash },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
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
            readinessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 5 },
            livenessProbe: { tcpSocket: { port: 'http' }, initialDelaySeconds: 10 },
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
 * tenant-auth routes are set.
 * Tenant runtimes admit it through their own `di-tenant-gateway` / `tenant-*-gateway` policies. */
export function gatewayNetworkPolicySpec(
  namespace: string,
  installation: string,
  tenantAuthRoutes: TenantAuthRoutes = {},
) {
  const tenantNamespaces: Selector = {
    matchLabels: { [INSTALLATION]: installation },
    matchExpressions: [{ key: TENANT, operator: 'Exists' }],
  };
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
    ingress: [{ ports: [{ protocol: 'TCP', port: GATEWAY_PORT }] }],
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
