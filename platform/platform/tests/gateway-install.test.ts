import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATEWAY_NAME,
  GATEWAY_PORT,
  gatewayDeploymentSpec,
  gatewayNetworkPolicySpec,
  gatewayScriptHash,
  gatewayServiceSpec,
  loadGatewayScript,
  routeUrlPatternFor,
  validateRouteUrlPattern,
} from '../src/gateway/install';
import { INSTALLATION, TENANT } from '../src/tenancy/resources';

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
    });
    expect(pod.volumes).toEqual([{ name: 'script', configMap: { name: GATEWAY_NAME } }]);
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
    const policy = gatewayNetworkPolicySpec('wasmcloud', 'di-test');
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
