import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATEWAY_DRAIN_SECONDS,
  GATEWAY_NAME,
  GATEWAY_PORT,
  GATEWAY_PRESTOP_SECONDS,
  GATEWAY_TERMINATION_GRACE_SECONDS,
  gatewayDeploymentSpec,
  gatewayNetworkPolicySpec,
  gatewayScriptHash,
  gatewayServiceSpec,
  loadGatewayScript,
  routeUrlPatternFor,
  validateRouteAliases,
  validateRouteUrlPattern,
} from '../src/gateway/install';
import { INSTALLATION, NAMESPACE_ROLE, TENANT } from '../src/tenancy/resources';

describe('route URL pattern', () => {
  it('derives the pattern from a loopback HTTP endpoint only', () => {
    expect(routeUrlPatternFor('http://127.0.0.1:28180')).toBe(
      'http://{host}.{tenant}.localhost:28180',
    );
    expect(routeUrlPatternFor('http://localhost:8080/')).toBe(
      'http://{host}.{tenant}.localhost:8080',
    );
    expect(routeUrlPatternFor('http://127.0.0.1')).toBe('http://{host}.{tenant}.localhost');
    for (const endpoint of [
      undefined,
      '',
      'not a url',
      'https://127.0.0.1:28180',
      'http://10.0.0.5:30080',
      'http://example.com',
    ])
      expect(routeUrlPatternFor(endpoint)).toBeUndefined();
  });

  it('accepts only patterns with the host and tenant placeholders', () => {
    expect(validateRouteUrlPattern(undefined)).toBeUndefined();
    expect(validateRouteUrlPattern('http://{host}.{tenant}.localhost:28180')).toBe(
      'http://{host}.{tenant}.localhost:28180',
    );
    expect(validateRouteUrlPattern('https://{host}.{tenant}.apps.example.com')).toBe(
      'https://{host}.{tenant}.apps.example.com',
    );
    for (const pattern of [
      'http://{tenant}.localhost:28180',
      'http://{host}.localhost',
      'ftp://{host}.{tenant}.localhost',
      'http://{host}.{tenant}.localhost/path',
      'http://{host}.{tenant}.',
    ])
      expect(() => validateRouteUrlPattern(pattern)).toThrow('routeUrlPattern must look like');
  });
});

describe('gateway resources', () => {
  it('loads and hashes the compiled script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-'));
    writeFileSync(join(dir, 'gateway.js'), 'console.log(1)');
    const script = loadGatewayScript(dir);
    expect(script).toEqual({ 'gateway.js': 'console.log(1)' });
    expect(gatewayScriptHash(script)).toMatch(/^[0-9a-f]{64}$/);
    expect(gatewayScriptHash({ 'gateway.js': 'x' })).not.toBe(gatewayScriptHash(script));
    expect(() => loadGatewayScript(join(dir, 'missing'))).toThrow();
  });

  it('runs the script hardened on the controller image without an API token', () => {
    const spec = gatewayDeploymentSpec('wasmcloud', 'abc');
    const pod = spec.template.spec;
    const container = pod.containers[0]!;
    expect(spec.template.metadata.annotations['di-framework.dev/script-hash']).toBe('abc');
    expect(spec.selector.matchLabels).toEqual({ app: GATEWAY_NAME });
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(container.image).toBe('node:22.18.0-alpine3.22');
    expect(container.command).toEqual(['node', '/gateway/gateway.js']);
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(container.resources.limits).toEqual({ cpu: '500m', memory: '128Mi' });
    expect(JSON.parse(container.env[0]!.value)).toEqual({
      port: GATEWAY_PORT,
      defaultUpstream: 'wasmcloud-http.wasmcloud.svc.cluster.local',
      drainTimeoutMs: GATEWAY_DRAIN_SECONDS * 1000,
    });
    expect(pod.volumes).toEqual([{ name: 'script', configMap: { name: GATEWAY_NAME } }]);
  });

  it('rolls without dropping capacity and drains the old pod before it stops (#223)', () => {
    const spec = gatewayDeploymentSpec('wasmcloud', 'abc', {}, { 'a.alpha': 'a.beta' });
    const pod = spec.template.spec;
    const [container] = pod.containers;
    if (!container) throw new Error('the gateway Deployment has no container');
    // Surge a new pod; never take the old one down before the new one is Ready.
    expect(spec.replicas).toBe(1);
    expect(spec.strategy).toEqual({
      type: 'RollingUpdate',
      rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    });
    expect(spec.minReadySeconds).toBeGreaterThan(0);
    expect(container.readinessProbe).toMatchObject({ tcpSocket: { port: 'http' } });
    // Keep serving while the endpoint removal propagates, then drain within the grace period.
    expect(container.lifecycle).toEqual({
      preStop: { exec: { command: ['sleep', String(GATEWAY_PRESTOP_SECONDS)] } },
    });
    expect(GATEWAY_PRESTOP_SECONDS).toBeGreaterThanOrEqual(5);
    const drainMs = JSON.parse(container.env[0]?.value ?? '{}').drainTimeoutMs;
    expect(drainMs).toBe(GATEWAY_DRAIN_SECONDS * 1000);
    expect(pod.terminationGracePeriodSeconds).toBe(GATEWAY_TERMINATION_GRACE_SECONDS);
    expect(pod.terminationGracePeriodSeconds * 1000).toBeGreaterThan(
      GATEWAY_PRESTOP_SECONDS * 1000 + drainMs,
    );
  });

  it('owns the published NodePort, or stays ClusterIP without one', () => {
    expect(gatewayServiceSpec(30180)).toMatchObject({
      type: 'NodePort',
      selector: { app: GATEWAY_NAME },
      ports: [{ port: 80, targetPort: 'http', nodePort: 30180 }],
    });
    const internal = gatewayServiceSpec(0);
    expect(internal.type).toBe('ClusterIP');
    expect(internal.ports[0]).not.toHaveProperty('nodePort');
  });

  it('limits gateway egress to DNS and host group HTTP of this installation', () => {
    const policy = gatewayNetworkPolicySpec('wasmcloud', 'di-test', {}, true);
    expect(policy.podSelector).toEqual({ matchLabels: { app: GATEWAY_NAME } });
    expect(policy.ingress).toEqual([{ ports: [{ protocol: 'TCP', port: GATEWAY_PORT }] }]);
    const hosts = policy.egress[1]!;
    expect(hosts.ports).toEqual([{ protocol: 'TCP', port: 9191 }]);
    expect(hosts.to).toEqual([
      {
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } },
        podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
      },
      {
        namespaceSelector: {
          matchLabels: { [INSTALLATION]: 'di-test' },
          matchExpressions: [{ key: TENANT, operator: 'Exists' }],
        },
        podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
      },
    ]);
  });
});

describe('gateway ingress (#457, #462)', () => {
  it('admits only the platform and tenant namespaces when not published', () => {
    expect(gatewayNetworkPolicySpec('wasmcloud', 'di-test').ingress).toEqual([
      {
        from: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } } },
          {
            namespaceSelector: {
              matchLabels: { [INSTALLATION]: 'di-test' },
              matchExpressions: [{ key: TENANT, operator: 'Exists' }],
            },
          },
        ],
        ports: [{ protocol: 'TCP', port: GATEWAY_PORT }],
      },
    ]);
  });
});

describe('tenant-auth gateway routes (#58:routes)', () => {
  const routes = { console: 'console', controller: 'controller' };

  it('passes the routes to the gateway only when there are any', () => {
    const env = (spec: ReturnType<typeof gatewayDeploymentSpec>) =>
      JSON.parse(spec.template.spec.containers[0]!.env[0]!.value);
    expect(env(gatewayDeploymentSpec('wasmcloud', 'abc', routes)).tenantAuthRoutes).toEqual(routes);
    expect(env(gatewayDeploymentSpec('wasmcloud', 'abc', {}))).not.toHaveProperty(
      'tenantAuthRoutes',
    );
  });

  it('lets the gateway reach the routed console and controller ports and nothing more', () => {
    // Only runtime namespaces, not every namespace of the tenant.
    const tenants = {
      matchLabels: { [INSTALLATION]: 'di-test', [NAMESPACE_ROLE]: 'runtime' },
      matchExpressions: [{ key: TENANT, operator: 'Exists' }],
    };
    const policy = gatewayNetworkPolicySpec('wasmcloud', 'di-test', routes);
    expect(policy.egress.slice(2)).toEqual([
      {
        to: [
          { namespaceSelector: tenants, podSelector: { matchLabels: { app: 'tenant-console' } } },
        ],
        ports: [{ protocol: 'TCP', port: 8787 }],
      },
      {
        to: [
          {
            namespaceSelector: tenants,
            podSelector: { matchLabels: { app: 'tenant-controller' } },
          },
        ],
        ports: [{ protocol: 'TCP', port: 8788 }],
      },
    ]);
    expect(
      gatewayNetworkPolicySpec('wasmcloud', 'di-test', { console: 'console' }).egress,
    ).toHaveLength(3);
    expect(gatewayNetworkPolicySpec('wasmcloud', 'di-test').egress).toHaveLength(2);
  });

  it('reaches the controller registry front when the registry is routed (#83)', () => {
    const egress = gatewayNetworkPolicySpec('wasmcloud', 'di-test', { registry: 'registry' })
      .egress as { to: { podSelector: unknown }[]; ports: unknown[] }[];
    expect(egress).toHaveLength(3);
    expect(egress[2]?.to[0]?.podSelector).toEqual({ matchLabels: { app: 'tenant-controller' } });
    expect(egress[2]?.ports).toEqual([{ protocol: 'TCP', port: 8790 }]);
  });
});

describe('route alias validation (#217)', () => {
  const rules = { tenantAuthRoutes: { console: 'auth' }, tenants: ['alpha', 'beta'] };

  it('normalizes case and sorts sources', () => {
    const normalized = validateRouteAliases(
      { 'Web.Alpha': 'WEB.beta', 'api.ALPHA': 'api.Beta', 'same.alpha': 'same.alpha' },
      rules,
    );
    expect(Object.entries(normalized)).toEqual([
      ['api.alpha', 'api.beta'],
      ['same.alpha', 'same.alpha'], // a self-alias is a no-op
      ['web.alpha', 'web.beta'],
    ]);
    for (const unset of [undefined, null, {}]) expect(validateRouteAliases(unset)).toEqual({});
  });

  it.each([
    ['a string', 'site.alpha', 'routeAliases must be an object'],
    ['an array', ['site.alpha'], 'routeAliases must be an object'],
    ['a nested map', { site: { alpha: 'site.beta' } }, 'routeAliases["site"] must be a'],
    ['a numeric target', { 'site.alpha': 1 }, 'routeAliases["site.alpha"] must be a'],
    ['a source without a tenant', { site: 'site.beta' }, 'Invalid route alias source "site"'],
    ['a non-DNS-1123 source', { 'my_site.alpha': 'site.beta' }, 'alias source "my_site.alpha"'],
    ['an invalid target tenant', { 'site.alpha': 'site.1beta' }, 'Invalid route alias target'],
    ['a fixed reserved source', { 'registry.alpha': 'site.beta' }, 'reserved route host registry'],
    ['a configured reserved source', { 'auth.alpha': 'site.beta' }, 'source "auth.alpha" uses'],
    ['a fixed reserved target', { 'site.alpha': 'controller.beta' }, 'reserved route host'],
    ['a configured reserved target', { 'site.alpha': 'auth.beta' }, 'target "auth.beta" uses'],
    ['an undeclared target tenant', { 'site.alpha': 'site.gamma' }, 'undeclared tenant gamma'],
    ['sources differing in case', { 'site.alpha': 'a.beta', 'SITE.alpha': 'b.beta' }, 'Duplicate'],
    ['a chain', { 'a.alpha': 'b.beta', 'b.beta': 'c.alpha' }, 'Chained route aliases'],
    ['a cycle', { 'a.alpha': 'b.beta', 'b.beta': 'a.alpha' }, 'Chained route aliases'],
  ])('rejects %s', (_, aliases, message) => {
    expect(() => validateRouteAliases(aliases, rules)).toThrow(message);
  });

  it('rolls the gateway when aliases change, but not when keys are reordered', () => {
    const spec = (aliases: Record<string, string>, routes = {}) =>
      gatewayDeploymentSpec('wasmcloud', 'abc', routes, validateRouteAliases(aliases));
    const hash = (s: ReturnType<typeof spec>) =>
      s.template.metadata.annotations['di-framework.dev/config-hash'];
    const env = (s: ReturnType<typeof spec>) => s.template.spec.containers[0]?.env[0]?.value ?? '';
    const both = spec({ 'site.alpha': 'site.beta', 'web.alpha': 'web.beta' });
    const reordered = spec({ 'WEB.alpha': 'web.beta', 'site.alpha': 'site.beta' });
    expect(hash(both)).toMatch(/^[0-9a-f]{64}$/);
    expect([hash(reordered), env(reordered)]).toEqual([hash(both), env(both)]);
    expect(JSON.parse(env(both)).routeAliases).toEqual({
      'site.alpha': 'site.beta',
      'web.alpha': 'web.beta',
    });
    // Removing an alias, or every alias, changes both the hash and GATEWAY_CONFIG.
    const one = spec({ 'site.alpha': 'site.beta' });
    const none = spec({});
    expect(new Set([hash(both), hash(one), hash(none)]).size).toBe(3);
    expect(JSON.parse(env(none))).not.toHaveProperty('routeAliases');
    expect(hash(spec({}, { console: 'console' }))).not.toBe(hash(none));
  });
});
