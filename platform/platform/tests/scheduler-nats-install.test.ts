import { beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { loadAll } from 'js-yaml';
import { HELM_KEEP, installSchedulerNats } from '../src/scheduler-nats-install';
import {
  SCHEDULER_NATS_DEPLOYMENT,
  schedulerNatsServerResources,
} from '../src/scheduler-nats-server';
import { SCHEDULER_PKI_JOB } from '../src/scheduler-pki-bootstrap';

// #541 m6e: the platform-owned scheduler NATS is installed before the Helm release, and the
// Service `nats` is adopted through a provider of its own (owner decision 2).

interface RegisterRequest {
  getName(): string;
  getType(): string;
  getProvider(): string;
  getDependenciesList(): string[];
  getObject(): { toJavaScript(): Record<string, unknown> } | undefined;
}
type Registered = {
  type: string;
  provider: string;
  dependencies: string[];
  inputs: Record<string, unknown>;
};

/** Registers `install` against Pulumi mocks in a stack of its own and returns what it registered. */
async function capture(
  stack: string,
  install: () => pulumi.Resource,
): Promise<Map<string, Registered>> {
  const registered = new Map<string, Registered>();
  await pulumi.runtime.setMocks(
    { newResource: (args) => ({ id: args.name, state: args.inputs }), call: (args) => args.inputs },
    'project',
    stack,
    false,
  );
  const monitor = (
    pulumi.runtime as unknown as {
      getMonitor(): { registerResource(request: RegisterRequest, callback: unknown): unknown };
    }
  ).getMonitor();
  const register = monitor.registerResource.bind(monitor);
  monitor.registerResource = (request, callback) => {
    registered.set(request.getName(), {
      type: request.getType(),
      provider: request.getProvider(),
      dependencies: request.getDependenciesList(),
      inputs: request.getObject()?.toJavaScript() ?? {},
    });
    return register(request, callback);
  };
  const last = install();
  await new Promise((resolve) => last.urn.apply(resolve));
  return registered;
}

const urn = (stack: string, type: string, name: string) =>
  `urn:pulumi:${stack}::project::${type}::${name}`;
/** A resource's URN under `runInPulumiStack`'s root Stack in stack `test`. */
const inStack = (type: string, name: string) =>
  `urn:pulumi:test::project::pulumi:pulumi:Stack$${type}::${name}`;

describe('installSchedulerNats', () => {
  let adopted: Map<string, Registered>;
  let fresh: Map<string, Registered>;
  beforeAll(async () => {
    const setup = (kubeconfig?: string) => () => {
      const provider = new k8s.Provider('main', {});
      const namespace = new k8s.core.v1.Namespace('wasmcloud', {}, { provider });
      const job = new k8s.batch.v1.Job('pki', {}, { provider });
      return installSchedulerNats({
        namespace: 'wasmcloud',
        provider,
        kubeconfig,
        kubeContext: 'admin',
        dependsOn: [namespace, job],
      }).deployment;
    };
    adopted = await capture('adopt', setup('kubeconfig: yes'));
    fresh = await capture('fresh', setup());
  });

  it('applies the rendered ConfigMap, ServiceAccount and Deployment after the PKI Job', () => {
    const [config, account, deployment] = schedulerNatsServerResources({ namespace: 'wasmcloud' });
    const job = urn('adopt', 'kubernetes:batch/v1:Job', 'pki');
    const ns = urn('adopt', 'kubernetes:core/v1:Namespace', 'wasmcloud');
    const service = urn('adopt', 'kubernetes:core/v1:Service', 'scheduler-nats-service');
    for (const [name, value] of [
      ['scheduler-nats-config', config],
      ['scheduler-nats-account', account],
    ] as const) {
      expect(adopted.get(name)?.dependencies.sort()).toEqual([job, ns, service].sort());
      expect(adopted.get(name)?.inputs.metadata).toEqual(value?.metadata);
    }
    const workload = [...adopted.entries()].find(
      ([, r]) => r.type === 'kubernetes:apps/v1:Deployment',
    )?.[1];
    expect(workload?.inputs.metadata).toEqual(deployment?.metadata);
    expect((workload?.inputs.metadata as { name: string } | undefined)?.name).toBe(
      SCHEDULER_NATS_DEPLOYMENT,
    );
    // Awaited Ready: no skipAwait.
    expect(JSON.stringify(workload?.inputs)).not.toContain('skipAwait');
    expect(workload?.dependencies).toEqual(
      expect.arrayContaining([
        job,
        ns,
        service,
        urn('adopt', 'kubernetes:core/v1:ConfigMap', 'scheduler-nats-config'),
        urn('adopt', 'kubernetes:core/v1:ServiceAccount', 'scheduler-nats-account'),
      ]),
    );
  });

  it('adopts the Service `nats` before the server, through a provider used for it alone', () => {
    const service = adopted.get('scheduler-nats-service');
    const rendered = schedulerNatsServerResources({ namespace: 'wasmcloud' })[3];
    expect(service?.type).toBe('kubernetes:core/v1:Service');
    // The chart's metadata and spec, plus the keep annotation.
    expect(service?.inputs.spec).toEqual(rendered?.spec);
    // Not awaited: on a fresh install it has no endpoints before the server is Ready.
    expect(service?.inputs.metadata).toEqual({
      ...rendered?.metadata,
      annotations: { ...HELM_KEEP, 'pulumi.com/skipAwait': 'true' },
    });
    expect(HELM_KEEP).toEqual({ 'helm.sh/resource-policy': 'keep' });
    // Before the server: an upgrade that cannot adopt it fails before any traffic moves.
    expect(service?.dependencies.sort()).toEqual(
      [
        urn('adopt', 'kubernetes:batch/v1:Job', 'pki'),
        urn('adopt', 'kubernetes:core/v1:Namespace', 'wasmcloud'),
      ].sort(),
    );
    const adopt = adopted.get('scheduler-nats-service');
    const provider = [...adopted.entries()].find(
      ([name, r]) => r.type === 'pulumi:providers:kubernetes' && name === 'scheduler-nats-adopt',
    )?.[1];
    // The admin kubeconfig enters the state as a secret (C1 of the #613 review).
    expect(provider?.inputs.kubeconfig).toEqual({
      [pulumi.runtime.specialSigKey]: pulumi.runtime.specialSecretSig,
      value: 'kubeconfig: yes',
    });
    expect(provider?.inputs).toMatchObject({
      context: 'admin',
      enableServerSideApply: 'true',
      upsertExistingObjects: 'true',
    });
    expect(adopt?.provider).toStartWith(
      urn('adopt', 'pulumi:providers:kubernetes', 'scheduler-nats-adopt'),
    );
    // Every other object goes through the main provider, which never upserts.
    const others = [...adopted.entries()].filter(
      ([name, r]) => name !== 'scheduler-nats-service' && !r.type.startsWith('pulumi:providers:'),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const [, r] of others)
      expect(r.provider).toStartWith(urn('adopt', 'pulumi:providers:kubernetes', 'main'));
  });

  it('creates the Service through the main provider without a kubeconfig', () => {
    expect(fresh.get('scheduler-nats-service')?.provider).toStartWith(
      urn('fresh', 'pulumi:providers:kubernetes', 'main'),
    );
    expect(
      [...fresh.values()].filter((r) => r.type === 'pulumi:providers:kubernetes'),
    ).toHaveLength(1);
  });
});

it('createPlatform orders PKI Job, NATS, Service `nats`, release, ingress and tenancy (#541 m6e)', () => {
  const output = execFileSync(
    'node',
    [
      '-e',
      `
    const pulumi = require('@pulumi/pulumi');
    const k8s = require('@pulumi/kubernetes');
    const registered = {};
    pulumi.runtime.setAllConfig({'project:tenants': JSON.stringify([{name:'alpha'}])});
    pulumi.runtime.setMocks({ newResource: a => ({id:a.name, state:{...a.inputs, metadata:{...a.inputs.metadata, name:a.inputs.metadata?.name ?? a.name}}}), call: a => a.inputs }, 'project', 'test', false);
    const monitor = pulumi.runtime.getMonitor();
    const register = monitor.registerResource.bind(monitor);
    monitor.registerResource = (request, callback) => {
      const inputs = request.getObject()?.toJavaScript() ?? {};
      registered[request.getName()] = { type: request.getType(), provider: request.getProvider(), dependencies: request.getDependenciesList(), postrender: inputs.postrender };
      return register(request, callback);
    };
    pulumi.runtime.runInPulumiStack(async () => {
      const platform = require('./dist').createPlatform({ provider:new k8s.Provider('test', {}), installation:'di-test', kubeconfig: 'apiVersion: v1' });
      await platform.release.urn.promise();
      await Promise.all(platform.tenantResources.map(t => t.urn.promise()));
    }).then(() => console.log(JSON.stringify(registered))).catch(e => {console.error(e);process.exitCode=1;});
  `,
    ],
    { cwd: join(import.meta.dir, '..'), encoding: 'utf8' },
  );
  const all = JSON.parse(output) as Record<
    string,
    { type: string; provider: string; dependencies: string[]; postrender?: string }
  >;
  const urnOf = (name: string) => {
    const found = all[name];
    if (!found) throw new Error(`${name} was not registered`);
    return inStack(found.type, name);
  };
  const job = `scheduler-pki-job-wasmcloud-scheduler-pki-${SCHEDULER_PKI_JOB}`;
  const nats = ['scheduler-nats-config', 'scheduler-nats-account', 'scheduler-nats-service'].map(
    urnOf,
  );
  // The NATS waits for the Job; the server for the adopted Service.
  expect(all['scheduler-nats-config']?.dependencies).toContain(urnOf(job));
  expect(all['scheduler-nats-service']?.dependencies).toContain(urnOf(job));
  expect(all['scheduler-nats']?.dependencies).toContain(urnOf('scheduler-nats-service'));
  // The release waits for all of them, not for the tenant namespaces, and has no post-renderer.
  const release = all.wasmcloud;
  expect(release?.type).toBe('kubernetes:helm.sh/v3:Release');
  expect(release?.dependencies).toEqual(
    expect.arrayContaining([
      urnOf(job),
      ...nats,
      inStack('kubernetes:apps/v1:Deployment', 'scheduler-nats'),
    ]),
  );
  expect(release?.dependencies.filter((d) => d.includes('alpha'))).toEqual([]);
  expect(release?.postrender).toBeUndefined();
  // The platform ingress policies and the tenancy follow the release.
  expect(all['di-platform-nats']?.dependencies).toEqual([urnOf('wasmcloud')]);
  expect(all['configmap-di-platform-controller']?.dependencies).toContain(urnOf('wasmcloud'));
  // The adopting provider serves the Service `nats` and nothing else.
  const adopt = urnOf('scheduler-nats-adopt');
  expect(
    Object.entries(all)
      .filter(([, r]) => r.provider?.startsWith(adopt))
      .map(([name, r]) => `${r.type} ${name}`),
  ).toEqual(['kubernetes:core/v1:Service scheduler-nats-service']);
  // The Helm values come from the static platformValues (design-541 §4.1).
  expect(readFileSync(join(import.meta.dir, '../src/index.ts'), 'utf8')).not.toContain(
    'postrender',
  );
}, 60_000);

it('the Deployment, ConfigMap and ServiceAccount render names that never collide with the chart', () => {
  const chart = (
    loadAll(
      readFileSync(join(import.meta.dir, 'fixtures/runtime-operator-2.8.0-nats.yaml'), 'utf8'),
    ) as { kind: string; metadata: { name: string } }[]
  ).filter(Boolean);
  const ours = schedulerNatsServerResources({ namespace: 'wasmcloud' });
  for (const value of ours.filter((v) => v.kind !== 'Service'))
    expect(
      chart.some((c) => c.kind === value.kind && c.metadata.name === value.metadata.name),
    ).toBe(false);
});
