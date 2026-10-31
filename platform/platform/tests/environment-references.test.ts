import { describe, expect, it } from 'bun:test';
import { RUNTIME_SECRET } from '../../backup-destination/src/model';
import { secretName as apiKeySecretName } from '../../tenant-auth/src/keys';
import { secretObjectName } from '../../tenant-auth/src/v1/config';
import {
  admissionResources,
  DEPLOY_ENVS,
  ENV_LABEL,
  WORKLOAD_SECRET_SUFFIXES,
  workloadEnvironmentReferencesAllowed,
} from '../src/tenancy/admission';
import type { BackingService } from '../src/tenancy/backing-services';
import { postgresNames } from '../src/tenancy/postgres';
import {
  type ControllerConfig,
  INSTALLATION,
  type RegistryNats,
  type Resource,
  TENANT_HOST_SECRET,
  type Tenant,
  type TenantAuthConfig,
  tenantAuthResources,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';
import { caCertificate, leafCertificate } from '../src/tenancy/tls';
import { evaluate } from './support/cel';

const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
const controllerUser = 'system:serviceaccount:wasmcloud:di-platform-controller';
const base = { controllerNamespace: 'wasmcloud', workloadName: 'greeter-prod' };
const prod = { [ENV_LABEL]: 'prod' };

const env = (configFrom: string[] = [], secretFrom: string[] = []) => ({
  environment: {
    configFrom: configFrom.map((name) => ({ name })),
    secretFrom: secretFrom.map((name) => ({ name })),
  },
});

const allowed = (
  locals: Parameters<typeof workloadEnvironmentReferencesAllowed>[0]['locals'],
  labels: Record<string, string> | null = prod,
  username = tenantUser,
) =>
  workloadEnvironmentReferencesAllowed({ ...base, username, labels: labels ?? undefined, locals });

const policy = admissionResources('test', 'wasmcloud').find(
  (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === 'test-workloads',
) as Resource;
const spec = policy.spec as {
  variables: { name: string; expression: string }[];
  validations: { expression: string; message: string }[];
};
const rules = spec.validations.filter(
  (v) => v.message.includes('di-vars-<env>') || v.message.includes('imagePullSecret'),
);
const neededVariables = ['w', 'controller', 'env', 'locals', 'pullSecrets'];

/** Evaluates the policy's environment reference rules (CEL) for one request and object. */
const celAllowed = (request: unknown, object: unknown): boolean => {
  const variables: Record<string, unknown> = {};
  for (const name of neededVariables) {
    const expression = spec.variables.find((v) => v.name === name)?.expression as string;
    variables[name] = evaluate(expression, { request, object, variables });
  }
  return rules.every((rule) => evaluate(rule.expression, { request, object, variables }) === true);
};

describe('workload environment references (#88)', () => {
  it('admits the env vars ConfigMap and tenant secrets of the labelled env', () => {
    expect(allowed([env(['di-vars-prod'], ['db-password.prod', 'a.prod'])])).toBe(true);
    expect(
      allowed([env(['di-vars-staging'], ['api-key.staging'])], { [ENV_LABEL]: 'staging' }),
    ).toBe(true);
    expect(allowed([{}, { environment: {} }, { environment: { config: { A: '1' } } }])).toBe(true);
  });

  it('denies managed Secrets on any path, with or without the env suffix', () => {
    for (const name of [
      'di-binding-db-creds',
      'di-bs-cache',
      'di-binding-db-creds.prod',
      'di-bs-cache.prod',
    ]) {
      // First entry stands for a component, the second for the service (localsOf order).
      expect(allowed([env([], [name])])).toBe(false);
      expect(allowed([{}, env([], [name])])).toBe(false);
    }
    expect(
      workloadEnvironmentReferencesAllowed({
        ...base,
        workloadName: 'di-bs-x',
        username: tenantUser,
        locals: [env([], ['di-bs-x-control'])],
      }),
    ).toBe(false);
  });

  it('requires references to match the env label', () => {
    expect(allowed([env(['di-vars-staging'])])).toBe(false);
    expect(allowed([env([], ['db-password.staging'])])).toBe(false);
    expect(allowed([env(['di-tenant-stock'])])).toBe(false);
    expect(allowed([env([], ['db-password'])])).toBe(false);
    expect(allowed([env([], ['Db.prod'])])).toBe(false);
    expect(allowed([env([], ['1db.prod'])])).toBe(false);
    expect(allowed([env([], ['db-.prod'])])).toBe(false);
    expect(allowed([env([], [`${'a'.repeat(64)}.prod`])])).toBe(false);
    for (const labels of [null, {}, { [ENV_LABEL]: 'dev' }] as (Record<string, string> | null)[]) {
      expect(allowed([env(['di-vars-prod'])], labels)).toBe(false);
      expect(allowed([env([], ['db-password.prod'])], labels)).toBe(false);
      expect(allowed([{}], labels)).toBe(true);
    }
  });

  it('keeps the cli-plugin-platform control Secret allowed without an env label', () => {
    expect(allowed([env([], ['greeter-prod-control'])], null)).toBe(true);
    expect(allowed([env([], ['other-control'])], null)).toBe(false);
  });

  it('admits the identity guest shape: no env label, secretFrom identity-control', () => {
    expect(
      workloadEnvironmentReferencesAllowed({
        controllerNamespace: 'wasmcloud',
        workloadName: 'identity',
        username: tenantUser,
        locals: [{ environment: { secretFrom: [{ name: 'identity-control' }] } }],
      }),
    ).toBe(true);
  });

  it('denies managed Secrets as imagePullSecret', () => {
    const check = (imagePullSecrets: string[], username = tenantUser) =>
      workloadEnvironmentReferencesAllowed({ ...base, username, locals: [], imagePullSecrets });
    expect(check(['registry-creds'])).toBe(true);
    expect(check(['di-binding-db-creds'])).toBe(false);
    expect(check(['ok', 'di-bs-cache'])).toBe(false);
    expect(check(['di-bs-cache'], controllerUser)).toBe(true);
  });

  it('exempts the platform controller', () => {
    expect(allowed([env(['di-vars-x'], ['di-binding-db-creds'])], null, controllerUser)).toBe(true);
  });

  it('expresses the same rules in CEL', () => {
    const envVar = spec.variables.find((v) => v.name === 'env')?.expression;
    expect(envVar).toContain(`object.metadata.labels['${ENV_LABEL}'] in ['prod','staging']`);
    expect(envVar).toContain(": ''");
    const locals = spec.variables.find((v) => v.name === 'locals')?.expression;
    expect(locals).toContain('variables.w.components.filter(c, has(c.localResources))');
    expect(locals).toContain('variables.w.service.localResources');
    const rule = spec.validations.find((v) => v.message.includes('di-vars-<env>'))?.expression;
    expect(rule).toStartWith('variables.controller || variables.locals.all(l,');
    expect(rule).toContain("variables.env != '' && c.name == 'di-vars-' + variables.env");
    expect(rule).toContain("!s.name.startsWith('di-binding-') && !s.name.startsWith('di-bs-')");
    expect(rule).toContain("s.name == object.metadata.name + '-control'");
    expect(rule).toContain("s.name.endsWith('.' + variables.env)");
    expect(rule).toContain("s.name.matches('^[a-z]([-a-z0-9]{0,61}[a-z0-9])?[.](prod|staging)$')");
  });
});

/** One workload referencing `secretFrom`, optionally labelled and as a given user. */
interface SecretCase {
  workloadName: string;
  secretFrom: string[];
  labels?: Record<string, string>;
  username?: string;
}

const tsAllowed = ({ workloadName, secretFrom, labels, username = tenantUser }: SecretCase) =>
  workloadEnvironmentReferencesAllowed({
    controllerNamespace: 'wasmcloud',
    workloadName,
    username,
    labels,
    locals: [env([], secretFrom)],
  });

const celSecretAllowed = (
  { workloadName, secretFrom, labels, username = tenantUser }: SecretCase,
  path: 'component' | 'service',
): boolean => {
  const holder = {
    localResources: { environment: { secretFrom: secretFrom.map((name) => ({ name })) } },
  };
  const object = {
    metadata: { name: workloadName, ...(labels ? { labels } : {}) },
    spec: {
      template: { spec: path === 'component' ? { components: [holder] } : { service: holder } },
    },
  };
  return celAllowed({ userInfo: { username }, operation: 'CREATE' }, object);
};

/** Asserts the TS mirror and the policy's real CEL (component and service paths) agree on `want`. */
const expectSecretAllowed = (input: SecretCase, want: boolean) => {
  expect(tsAllowed(input)).toBe(want);
  expect(celSecretAllowed(input, 'component')).toBe(want);
  expect(celSecretAllowed(input, 'service')).toBe(want);
};

describe('<workload>-secrets as a second secretFrom (#203)', () => {
  it('lists exactly the control and app Secret suffixes', () => {
    expect([...WORKLOAD_SECRET_SUFFIXES]).toEqual(['-control', '-secrets']);
  });

  it('admits <workload>-control and <workload>-secrets together without an env label', () => {
    expectSecretAllowed(
      { workloadName: 'identity', secretFrom: ['identity-control', 'identity-secrets'] },
      true,
    );
    expectSecretAllowed({ workloadName: 'identity', secretFrom: ['identity-secrets'] }, true);
  });

  it('admits them alongside env Secrets on a labelled workload', () => {
    expectSecretAllowed(
      {
        workloadName: 'greeter-prod',
        labels: prod,
        secretFrom: ['greeter-prod-control', 'greeter-prod-secrets', 'db-password.prod'],
      },
      true,
    );
  });

  it("denies another workload's -secrets Secret", () => {
    expectSecretAllowed({ workloadName: 'identity', secretFrom: ['other-secrets'] }, false);
    expectSecretAllowed(
      { workloadName: 'identity', secretFrom: ['identity-control', 'greeter-secrets'] },
      false,
    );
    expectSecretAllowed(
      { workloadName: 'greeter-prod', labels: prod, secretFrom: ['greeter-secrets'] },
      false,
    );
  });

  it('denies workload `a` the Secrets of workloads `a-control` and `a-secrets`', () => {
    // `a-control-secrets` is `a-control`'s app Secret; `a-secrets-control` is `a-secrets`'s CLI one.
    for (const name of ['a-control-secrets', 'a-secrets-control', 'a-control-control'])
      expectSecretAllowed({ workloadName: 'a', secretFrom: [name] }, false);
    expectSecretAllowed({ workloadName: 'a-control', secretFrom: ['a-control-secrets'] }, true);
    expectSecretAllowed({ workloadName: 'a-control', secretFrom: ['a-secrets'] }, false);
    expectSecretAllowed({ workloadName: 'a-secrets', secretFrom: ['a-secrets-control'] }, true);
  });

  it('allows no other name derived from the workload (no wildcard)', () => {
    for (const name of [
      'identity-secret',
      'identity-secrets-2',
      'identity-secretsx',
      'identity-secrets.prod',
      'identity-other',
      'identitysecrets',
      'secrets',
      '-secrets',
      'xidentity-secrets',
      'IDENTITY-secrets',
    ])
      expectSecretAllowed({ workloadName: 'identity', secretFrom: [name] }, false);
  });

  it('still denies managed workload names', () => {
    expectSecretAllowed({ workloadName: 'di-bs-x', secretFrom: ['di-bs-x-secrets'] }, false);
    expectSecretAllowed(
      { workloadName: 'di-binding-x', secretFrom: ['di-binding-x-secrets'] },
      false,
    );
  });

  it('keeps the platform controller exempt', () => {
    expectSecretAllowed(
      { workloadName: 'identity', secretFrom: ['di-bs-x-secrets'], username: controllerUser },
      true,
    );
  });

  it('names the own Secrets in the denial message and keeps its prefix', () => {
    const rule = rules.find((r) => r.message.includes('di-vars-<env>'));
    expect(rule?.message).toStartWith(
      'Tenant guests may reference only di-vars-<env> and <name>.<env> Secrets matching their platform.di-framework.dev/env label (never di-binding-*/di-bs-*)',
    );
    expect(rule?.message).toContain('<workload>-control');
    expect(rule?.message).toContain('<workload>-secrets');
  });
});

/**
 * The rule above admits `<workload>-control` / `<workload>-secrets` for whichever workload name a
 * tenant picks, so it is only safe while no platform-owned Secret in a tenant namespace ends in
 * one of those suffixes. `di-binding-*` / `di-bs-*` Secrets are denied by prefix and exempt.
 */
describe('platform-owned Secret names avoid the workload Secret suffixes (#325)', () => {
  const managedPrefixes = ['di-binding-', 'di-bs-'];
  const auth: TenantAuthConfig = {
    image: `ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`,
    issuer: 'http://identity.alpha.localhost:28180',
    oauthClient: { id: 'access', secretName: 'tenant-auth-oauth' },
    issuerUpstream: 'di-platform-gateway.wasmcloud.svc.cluster.local:80',
    issuerUpstreamPodPort: 8080,
    consolePublicUrl: 'http://console.{tenant}.localhost:28180',
    registry: {
      component: `ghcr.io/di-framework/oci-registry@sha256:${'b'.repeat(64)}`,
      publicUrl: 'https://registry.{tenant}.localhost:28180',
    },
  };
  const cfg: ControllerConfig = {
    installation: 'test',
    namespace: 'wasmcloud',
    hostImage: `ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:${'c'.repeat(64)}`,
    schedulerNatsUrl: 'nats://nats:4222',
    routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
    tenantAuth: auth,
  };
  const tenant: Tenant = {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec: {},
  };
  const ca = caCertificate('tenant-controller CA', 30);
  const leaf = leafCertificate('tenant-controller', ['tenant-controller'], [], 30, ca.cert, ca.key);
  const registryNats = (stage: RegistryNats['stage']): RegistryNats => ({
    password: 'p'.repeat(32),
    stage,
    credentials: true,
  });

  it('renders no Secret ending in a workload Secret suffix', () => {
    const rendered = [
      ...tenantResources(tenant, cfg),
      // Positional flags after the registry data are the optional tenant features (stage, TLS, pull).
      ...tenantResources(tenant, cfg, { digest: 'test' }, [], true, true, true, {}),
      ...(['migrating', 'rollout', 'migrated'] as const).flatMap((stage) =>
        tenantResources(tenant, cfg, undefined, [], true, true, true, {}, registryNats(stage)),
      ),
      ...tenantAuthResources(tenant, cfg, {
        members: [{ name: 'alice', role: 'developer', suspended: false }],
        apiServer: { addresses: ['10.0.0.1'], port: 6443 },
        tls: { ...leaf, caCert: ca.cert, caKey: ca.key },
        clientSecret: 'c2VjcmV0',
        hostPullToken: 'token',
      }),
    ];
    const names = new Set(rendered.filter((r) => r.kind === 'Secret').map((r) => r.metadata.name));
    // Producers outside tenantResources/tenantAuthResources create Secrets in tenant namespaces
    // at runtime; their names come from the real helpers.
    const postgres = (name: string): BackingService => ({
      apiVersion: VERSION,
      kind: 'BackingService',
      metadata: { name, uid: `${name}-uid` } as BackingService['metadata'],
      spec: { type: 'postgres' } as BackingService['spec'],
    });
    for (const name of ['db', 'x'.repeat(63)]) {
      const pg = postgresNames(postgres(name));
      names.add(pg.credentials);
      names.add(pg.connection);
    }
    names.add(RUNTIME_SECRET);
    // Issued by the controller rather than rendered (#541 m6c), and mounted by the hosts (m6e).
    names.add(TENANT_HOST_SECRET);
    names.add(apiKeySecretName('0123456789abcdef'));
    for (const env of DEPLOY_ENVS)
      for (const name of ['db', 'secrets', 'a-control']) names.add(secretObjectName(name, env));
    // The scan has to see the Secrets it is about, so a fixture cannot silently drop them.
    for (const expected of [
      'di-nats-registry',
      TENANT_HOST_SECRET,
      'tenant-controller-tls',
      // In the platform namespace since #170, so no workload can name it; checked all the same.
      'tenant-controller-ca-alpha',
      'di-tenant-registry-pull',
      'tenant-console-oauth',
      'di-backup-destination',
    ])
      expect(names.has(expected)).toBe(true);
    expect([...names].some((n) => /^di-pg-.+-auth$/.test(n))).toBe(true);
    expect([...names].some((n) => /^di-pg-.+-conn$/.test(n))).toBe(true);
    expect([...names].some((n) => n.startsWith('di-apikey-'))).toBe(true);
    expect(names.has('db.prod')).toBe(true);
    const offending = [...names].filter(
      (name) =>
        !managedPrefixes.some((prefix) => name.startsWith(prefix)) &&
        WORKLOAD_SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    );
    expect(offending).toEqual([]);
  });
});

/** Evaluates the policy's real CEL against the TS mirror over a generated case matrix. */
describe('CEL parity with workloadEnvironmentReferencesAllowed (#88)', () => {
  it('finds both rules', () => expect(rules).toHaveLength(2));

  const labelStates: (Record<string, string> | null)[] = [
    null,
    {},
    { other: 'x' },
    { [ENV_LABEL]: 'prod' },
    { [ENV_LABEL]: 'staging' },
    { [ENV_LABEL]: 'dev' },
    { [ENV_LABEL]: '' },
  ];
  // `a-control`, `a-secrets` and `x.prod` have the shape of another workload's Secret names.
  const workloadNames = [
    'greeter-prod',
    'identity',
    'di-bs-x',
    'a',
    'a-control',
    'a-secrets',
    'x.prod',
  ];
  const users = [tenantUser, controllerUser];
  const configNames = [undefined, 'di-vars-prod', 'di-vars-staging', 'di-tenant-stock'];
  const secretNames = [
    undefined,
    'db-password.prod',
    'db-password.staging',
    'db-password',
    'Db.prod',
    '1db.prod',
    `${'a'.repeat(64)}.prod`,
    'di-binding-x.prod',
    'di-bs-x',
    'greeter-prod-control',
    'identity-control',
    'identity-secret',
    'identity-secrets',
    'identity-secrets-x',
    'greeter-prod-secrets',
    'greeter-prod-secret',
    'di-bs-x-control',
    'other-control',
    'a-control',
    'a-secrets',
    'a-control-secrets',
    'a-secrets-control',
    'x.prod-secrets',
    'x.prod',
  ];
  const pullNames = [undefined, 'registry', 'di-binding-x', 'di-bs-y'];
  const paths = ['component', 'service'] as const;

  it('agrees on every case', () => {
    let cases = 0;
    for (const labels of labelStates)
      for (const name of workloadNames)
        for (const username of users)
          for (const path of paths)
            for (const configName of configNames)
              for (const secretName of secretNames)
                for (const pullName of pullNames) {
                  const local = {
                    environment: {
                      ...(configName ? { configFrom: [{ name: configName }] } : {}),
                      ...(secretName ? { secretFrom: [{ name: secretName }] } : {}),
                    },
                  };
                  const pull = pullName ? { imagePullSecret: { name: pullName } } : {};
                  const holder = { ...pull, localResources: local };
                  const object = {
                    metadata: { name, ...(labels ? { labels } : {}) },
                    spec: {
                      template: {
                        spec: path === 'component' ? { components: [holder] } : { service: holder },
                      },
                    },
                  };
                  const expected = workloadEnvironmentReferencesAllowed({
                    ...base,
                    workloadName: name,
                    username,
                    labels: labels ?? undefined,
                    locals: [local],
                    imagePullSecrets: pullName ? [pullName] : [],
                  });
                  const actual = celAllowed(
                    { userInfo: { username }, operation: 'CREATE' },
                    object,
                  );
                  if (actual !== expected)
                    throw new Error(
                      `CEL ${actual} vs TS ${expected}: ${JSON.stringify({ labels, name, username, path, configName, secretName, pullName })}`,
                    );
                  cases++;
                }
    expect(cases).toBeGreaterThan(5000);
  });
});
