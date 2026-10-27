import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { GATEWAY_NAME, GATEWAY_PORT } from '../src/gateway/install';
import { platformIngressPolicies, RUNTIME_OPERATOR_SERVICE_PORT } from '../src/platform-ingress';
import { INSTALLATION, TENANT } from '../src/tenancy/resources';

const root = join(import.meta.dir, '..');

type Policy = {
  metadata: { name: string; namespace: string };
  spec: { ingress?: { from?: unknown[]; ports?: unknown[] }[] };
};

// Renders createPlatform against Pulumi mocks (from the built `dist`) and returns every
// NetworkPolicy it registers, with its inputs.
function renderPolicies(httpNodePort: number): Policy[] {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const resources = [];
    pulumi.runtime.setAllConfig({'project:tenants': JSON.stringify([{name:'alpha'}])});
    pulumi.runtime.setMocks({
      newResource: a => { resources.push(a); return {id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}; },
      call: a => a.inputs,
    }, 'project', 'test', false);
    pulumi.runtime.runInPulumiStack(async () => {
      const platform = require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', httpNodePort:${httpNodePort} });
      await platform.namespace.promise();
      const sentinel = new k8s.core.v1.Namespace('sentinel', {}, { provider: new k8s.Provider('sentinel-provider', {}) });
      await new Promise(r => sentinel.urn.apply(r));
    }).then(() => {
      console.log(JSON.stringify(resources.filter(r => r.type === 'kubernetes:networking.k8s.io/v1:NetworkPolicy').map(r => r.inputs)));
    }).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  return JSON.parse(output);
}

const platformPeer = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'wasmcloud' } },
};
const tenantNamespaces = {
  matchLabels: { [INSTALLATION]: 'di-test' },
  matchExpressions: [{ key: TENANT, operator: 'Exists' }],
};

describe('platform namespace ingress (#462)', () => {
  it('names the peers of nats, the default host group and the operator', () => {
    const policies = Object.fromEntries(
      platformIngressPolicies('wasmcloud', 'di-test').map((p) => [p.name, p.spec]),
    );
    expect(Object.keys(policies)).toEqual([
      'di-platform-nats',
      'di-platform-hostgroup-default',
      'di-platform-runtime-operator',
    ]);
    expect(policies['di-platform-nats']).toEqual({
      podSelector: { matchLabels: { 'wasmcloud.com/name': 'nats' } },
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            platformPeer,
            {
              namespaceSelector: tenantNamespaces,
              podSelector: { matchLabels: { 'wasmcloud.com/name': 'hostgroup' } },
            },
          ],
          ports: [{ protocol: 'TCP', port: 4222 }],
        },
      ],
    });
    expect(policies['di-platform-hostgroup-default']?.podSelector).toEqual({
      matchLabels: { 'wasmcloud.com/name': 'hostgroup', 'wasmcloud.com/hostgroup': 'default' },
    });
    expect(policies['di-platform-hostgroup-default']?.ingress).toEqual([
      { from: [platformPeer], ports: [{ protocol: 'TCP', port: 9191 }] },
    ]);
    expect(policies['di-platform-runtime-operator']?.ingress).toEqual([
      {
        from: [platformPeer],
        ports: [
          { protocol: 'TCP', port: 8082 },
          { protocol: 'TCP', port: RUNTIME_OPERATOR_SERVICE_PORT },
        ],
      },
    ]);
  });

  const walk = (policies: Policy[], exempt: string[]) => {
    const platform = policies.filter((p) => p.metadata.namespace === 'wasmcloud');
    expect(platform.map((p) => p.metadata.name).sort()).toEqual([
      'di-platform-gateway',
      'di-platform-hostgroup-default',
      'di-platform-nats',
      'di-platform-runtime-operator',
      'di-tenant-scheduler',
    ]);
    for (const policy of platform)
      for (const rule of policy.spec.ingress ?? []) {
        if (exempt.includes(policy.metadata.name)) continue;
        expect(rule.from?.length, policy.metadata.name).toBeGreaterThan(0);
        expect(JSON.stringify(rule.from)).not.toContain('"namespaceSelector":{}');
      }
    return platform;
  };

  it('renders no open ingress rule in the platform namespace when the gateway is unpublished', () => {
    walk(renderPolicies(0), []);
  }, 60_000);

  it('leaves only the published gateway open', () => {
    const platform = walk(renderPolicies(30080), [GATEWAY_NAME]);
    const gateway = platform.find((p) => p.metadata.name === GATEWAY_NAME);
    expect(gateway?.spec.ingress).toEqual([{ ports: [{ protocol: 'TCP', port: GATEWAY_PORT }] }]);
  }, 60_000);
});
