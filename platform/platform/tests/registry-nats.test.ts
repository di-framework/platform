import { describe, expect, it, spyOn } from 'bun:test';
import {
  admissionResources,
  type HostInterfaceLike,
  hostInterfaceAllowed,
  MANAGED_CONFIG_KEYS_MESSAGE,
  managedConfigKeysAllowed,
  WORKLOAD_HOST_PATH_MESSAGE,
  workloadHostPathsAllowed,
} from '../src/tenancy/admission';
import { type Api, ApiError, Controller, collection } from '../src/tenancy/controller';
import { controllerClusterRoleRules } from '../src/tenancy/install';
import {
  hostImageSupportsNatsCredentials,
  JETSTREAM_ACCOUNT_INIT_SCRIPT,
  NATS_BOX_IMAGE,
  newRegistryNatsPassword,
  PRE_NATS_CREDENTIALS_HOST_IMAGE_DIGESTS,
  REGISTRY_NATS_AUTH_ANNOTATION,
  REGISTRY_NATS_MIGRATION,
  REGISTRY_NATS_MIGRATION_COMPONENT,
  REGISTRY_NATS_MIGRATION_JOB,
  REGISTRY_NATS_MIGRATION_SCRIPT,
  REGISTRY_NATS_MOUNT,
  REGISTRY_NATS_PASSWORD,
  REGISTRY_NATS_PASSWORD_ENV,
  REGISTRY_NATS_PASSWORD_FILE,
  REGISTRY_NATS_SECRET,
  REGISTRY_NATS_USER_FILE,
  registryNatsAuthDigest,
} from '../src/tenancy/registry-nats';
import {
  type Condition,
  type ControllerConfig,
  GROUP,
  INSTALLATION,
  REGISTRY_WORKLOAD,
  type RegistryNats,
  type RegistryNatsMode,
  type Resource,
  RUNTIME_NATS_CONFIG,
  runtimeNatsLimits,
  runtimeNatsServerConfig,
  type Tenant,
  type TenantAuthConfig,
  tenantAuthResources,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';
import { caCertificate, leafCertificate } from '../src/tenancy/tls';
import { HOST_MOUNT_ROOT, storagePatch } from '../src/tenancy/workload-storage';
import { evaluate } from './support/cel';

const PASSWORD = newRegistryNatsPassword();
/** `value`, or a failed test when it is missing. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${what}`);
  return value;
}
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
  hostImage: 'wash:test',
  schedulerNatsUrl: 'nats://nats:4222',
  routeUrlPattern: 'http://{host}.{tenant}.localhost:28180',
  tenantAuth: auth,
};
const readyCondition: Condition = {
  type: 'Ready',
  status: 'True',
  observedGeneration: 1,
  reason: 'Reconciled',
  message: '',
  lastTransitionTime: '2026-01-01T00:00:00Z',
};
function tenant(spec: Tenant['spec'] = {}): Tenant {
  return {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'test' },
    },
    spec,
    status: { conditions: [readyCondition] },
  };
}
const schedulerSecret = { data: { 'ca.crt': 'test' } };
type Container = {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
};
type PodTemplate = {
  metadata: { labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: {
    initContainers?: Container[];
    containers: Container[];
    volumes?: Record<string, unknown>[];
    securityContext?: Record<string, unknown>;
    automountServiceAccountToken?: boolean;
    restartPolicy?: string;
  };
};
type Workload = Resource & {
  spec: {
    replicas?: number;
    template: { spec: { hostInterfaces: HostInterfaceLike[] } };
  };
};
const natsConf = (resources: Resource[]) =>
  must(
    (find(resources, 'ConfigMap', RUNTIME_NATS_CONFIG).data as Record<string, string>)['nats.conf'],
    'nats.conf',
  );
const find = (resources: Resource[], kind: string, name: string) => {
  const found = resources.find((r) => r.kind === kind && r.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name}`);
  return found;
};
const has = (resources: Resource[], kind: string, name: string) =>
  resources.some((r) => r.kind === kind && r.metadata.name === name);
const template = (value: Resource) =>
  (value as unknown as { spec: { template: PodTemplate } }).spec.template;
const render = (registryNats?: RegistryNats, spec: Tenant['spec'] = {}) =>
  tenantResources(
    tenant(spec),
    cfg,
    schedulerSecret,
    [],
    false,
    false,
    false,
    undefined,
    registryNats,
  );
const blobstoreOf = (value: Resource) =>
  must(
    (value as Workload).spec.template.spec.hostInterfaces.find((h) => h.package === 'blobstore'),
    'blobstore entry',
  );
const tls = (() => {
  const ca = caCertificate('tenant-controller CA', 30);
  const leaf = leafCertificate('tenant-controller', ['tenant-controller'], [], 30, ca.cert, ca.key);
  return { ...leaf, caCert: ca.cert, caKey: ca.key };
})();
const registryWorkload = (registryNats?: RegistryNatsMode) =>
  find(
    tenantAuthResources(tenant(), cfg, {
      members: ['alice'],
      apiServer: { addresses: ['10.0.0.1'], port: 6443 },
      tls,
      clientSecret: 'c2VjcmV0',
      registryServing: true,
      ...(registryNats ? { registryNats } : {}),
    }),
    'WorkloadDeployment',
    REGISTRY_WORKLOAD,
  );

describe('registry NATS account rendering (#159)', () => {
  it('keeps clients without credentials in the TENANT account, and adds REGISTRY only with it', () => {
    const limits = runtimeNatsLimits(undefined);
    const plain = runtimeNatsServerConfig(limits);
    expect(plain).toContain('no_auth_user: "tenant"');
    expect(plain).toContain(
      '  TENANT {\n    jetstream: enabled\n    users: [ { user: "tenant" } ]',
    );
    expect(plain).not.toContain('REGISTRY');
    const registry = runtimeNatsServerConfig(limits, { registry: true });
    expect(registry.split('\n')).toEqual([
      'port: 4222',
      'jetstream {',
      '  store_dir: "/data"',
      `  max_file_store: ${limits.maxFileStore}`,
      `  max_memory_store: ${limits.maxMemoryStore}`,
      '}',
      'accounts {',
      '  TENANT {',
      '    jetstream: enabled',
      '    users: [ { user: "tenant" } ]',
      '  }',
      '  REGISTRY {',
      '    jetstream: enabled',
      `    users: [ { user: "registry", password: $${REGISTRY_NATS_PASSWORD_ENV} } ]`,
      '  }',
      '}',
      'no_auth_user: "tenant"',
      '',
    ]);
  });

  it('renders no registry account, Secret, mount or Job without registryNats', () => {
    const resources = render();
    const config = natsConf(resources);
    expect(config).not.toContain('REGISTRY');
    for (const [kind, name] of [
      ['Secret', REGISTRY_NATS_SECRET],
      ['Job', REGISTRY_NATS_MIGRATION_JOB],
      ['ConfigMap', REGISTRY_NATS_MIGRATION],
    ] as const)
      expect(has(resources, kind, name)).toBe(false);
    const nats = template(find(resources, 'Deployment', 'di-nats'));
    expect(nats.spec.containers[0]?.env).toBeUndefined();
    expect(nats.metadata.annotations).not.toHaveProperty(REGISTRY_NATS_AUTH_ANNOTATION);
    const host = template(find(resources, 'Deployment', 'hostgroup-tenant-alpha'));
    expect(JSON.stringify(host)).not.toContain(REGISTRY_NATS_MOUNT);
    expect(JSON.stringify(host)).not.toContain(REGISTRY_NATS_SECRET);
  });

  it('renames the global account store to TENANT before di-nats starts, always', () => {
    for (const resources of [
      render(),
      render({ password: PASSWORD, migrated: true, migrate: false }),
    ]) {
      const init = template(find(resources, 'Deployment', 'di-nats')).spec.initContainers;
      expect(init).toEqual([
        expect.objectContaining({
          name: 'jetstream-accounts',
          image: 'nats:2.12.8-alpine',
          command: ['sh', '-c', JETSTREAM_ACCOUNT_INIT_SCRIPT],
          volumeMounts: [{ name: 'data', mountPath: '/data' }],
        }),
      ]);
    }
    // Never overwrites a TENANT store that is already there.
    expect(JETSTREAM_ACCOUNT_INIT_SCRIPT).toContain('if [ -e "$store/TENANT" ]');
    expect(JETSTREAM_ACCOUNT_INIT_SCRIPT).toContain('mv "$store/\\$G" "$store/TENANT"');
  });

  it('feeds the password to nats-server from the Secret and to the hosts as a read-only mount', () => {
    const resources = render({ password: PASSWORD, migrated: false, migrate: false });
    const secret = find(resources, 'Secret', REGISTRY_NATS_SECRET);
    expect(secret.metadata.namespace).toBe('di-runtime-alpha');
    expect(secret.type).toBe('kubernetes.io/basic-auth');
    const data = secret.data as Record<string, string>;
    expect(Buffer.from(must(data.username, 'username'), 'base64').toString()).toBe('registry');
    expect(Buffer.from(must(data.password, 'password'), 'base64').toString()).toBe(PASSWORD);
    const index = (kind: string, name: string) =>
      resources.findIndex((r) => r.kind === kind && r.metadata.name === name);
    expect(index('Secret', REGISTRY_NATS_SECRET)).toBeLessThan(index('Deployment', 'di-nats'));
    expect(index('Secret', REGISTRY_NATS_SECRET)).toBeLessThan(
      index('Deployment', 'hostgroup-tenant-alpha'),
    );

    const nats = template(find(resources, 'Deployment', 'di-nats'));
    expect(nats.spec.containers[0]?.env).toEqual([
      {
        name: REGISTRY_NATS_PASSWORD_ENV,
        valueFrom: { secretKeyRef: { name: REGISTRY_NATS_SECRET, key: 'password' } },
      },
    ]);
    const config = natsConf(resources);
    expect(config).toContain(`password: $${REGISTRY_NATS_PASSWORD_ENV}`);

    const host = template(find(resources, 'Deployment', 'hostgroup-tenant-alpha'));
    expect(host.spec.containers[0]?.volumeMounts).toContainEqual({
      name: 'registry-nats',
      mountPath: REGISTRY_NATS_MOUNT,
      readOnly: true,
    });
    expect(host.spec.volumes).toContainEqual({
      name: 'registry-nats',
      secret: {
        secretName: REGISTRY_NATS_SECRET,
        defaultMode: 0o440,
        items: [
          { key: 'username', path: 'username' },
          { key: 'password', path: 'password' },
        ],
      },
    });
    // The mount holds exactly the two files the entry names.
    expect(REGISTRY_NATS_USER_FILE).toBe(`${REGISTRY_NATS_MOUNT}/username`);
    expect(REGISTRY_NATS_PASSWORD_FILE).toBe(`${REGISTRY_NATS_MOUNT}/password`);
    // Rotation restarts both the server and the hosts; the digest is not the password.
    const digest = registryNatsAuthDigest(PASSWORD);
    expect(nats.metadata.annotations?.[REGISTRY_NATS_AUTH_ANNOTATION]).toBe(digest);
    expect(host.metadata.annotations?.[REGISTRY_NATS_AUTH_ANNOTATION]).toBe(digest);
    expect(registryNatsAuthDigest(newRegistryNatsPassword())).not.toBe(digest);

    // The password is in the Secret only: nowhere else, in clear or in base64.
    for (const value of resources.filter((r) => r !== secret)) {
      const text = JSON.stringify(value);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(Buffer.from(PASSWORD).toString('base64'));
    }
  });

  it('admits the migration Job to di-nats only, on 4222', () => {
    const policy = (resources: Resource[]) =>
      (
        find(resources, 'NetworkPolicy', 'di-bs-backend-network') as unknown as {
          spec: {
            ingress: {
              from: { podSelector: { matchLabels: Record<string, string> } }[];
              ports?: unknown;
            }[];
          };
        }
      ).spec.ingress;
    const rule = policy(render({ password: PASSWORD, migrated: false, migrate: true })).find(
      (r) =>
        r.from[0]?.podSelector.matchLabels[`${GROUP}/component`] ===
        REGISTRY_NATS_MIGRATION_COMPONENT,
    );
    expect(rule?.ports).toEqual([{ protocol: 'TCP', port: 4222 }]);
    expect(JSON.stringify(policy(render()))).not.toContain(REGISTRY_NATS_MIGRATION_COMPONENT);
  });

  it('renders the Job only while the store may move, and the marker once it has', () => {
    const waiting = render({ password: PASSWORD, migrated: false, migrate: false });
    expect(has(waiting, 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBe(false);
    expect(has(waiting, 'ConfigMap', REGISTRY_NATS_MIGRATION)).toBe(false);
    const suspended = render(
      { password: PASSWORD, migrated: false, migrate: true },
      { suspended: true },
    );
    expect(has(suspended, 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBe(false);
    const done = render({ password: PASSWORD, migrated: true, migrate: false });
    expect(has(done, 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBe(false);
    expect(find(done, 'ConfigMap', REGISTRY_NATS_MIGRATION).data).toEqual({ state: 'complete' });

    const resources = render({ password: PASSWORD, migrated: false, migrate: true });
    const job = find(resources, 'Job', REGISTRY_NATS_MIGRATION_JOB) as Resource & {
      spec: { backoffLimit: number; ttlSecondsAfterFinished: number; template: PodTemplate };
    };
    expect(job.apiVersion).toBe('batch/v1');
    expect(job.metadata.namespace).toBe('di-runtime-alpha');
    expect(job.spec.backoffLimit).toBeGreaterThan(0);
    expect(job.spec.ttlSecondsAfterFinished).toBe(86400);
    const pod = job.spec.template;
    expect(pod.metadata.labels).toEqual({
      [`${GROUP}/component`]: REGISTRY_NATS_MIGRATION_COMPONENT,
    });
    expect(pod.spec.restartPolicy).toBe('Never');
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65532 });
    const [container] = pod.spec.containers;
    expect(container?.image).toBe(NATS_BOX_IMAGE);
    expect(NATS_BOX_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(container?.command).toEqual(['sh', '-c', REGISTRY_NATS_MIGRATION_SCRIPT]);
    expect(container?.env).toEqual([
      { name: 'NATS_URL', value: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222' },
      { name: 'HOME', value: '/tmp' },
      {
        name: 'REGISTRY_USER',
        valueFrom: { secretKeyRef: { name: REGISTRY_NATS_SECRET, key: 'username' } },
      },
      {
        name: 'REGISTRY_PASSWORD',
        valueFrom: { secretKeyRef: { name: REGISTRY_NATS_SECRET, key: 'password' } },
      },
    ]);
    expect(JSON.stringify(job)).not.toContain(PASSWORD);
  });

  it('switches the registry entry to the mounted credentials only once the store moved', () => {
    expect(blobstoreOf(registryWorkload()).config).toEqual({
      backend: 'nats',
      url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222',
    });
    expect((registryWorkload() as Workload).spec.replicas).toBe(1);
    // While the Job copies, the registry is stopped and still anonymous.
    const migrating = registryWorkload('migrating') as Workload;
    expect(migrating.spec.replicas).toBe(0);
    expect(blobstoreOf(migrating).config).toEqual(blobstoreOf(registryWorkload()).config);
    const switched = registryWorkload('credentials') as Workload;
    expect(switched.spec.replicas).toBe(1);
    expect(blobstoreOf(switched).config).toEqual({
      backend: 'nats',
      url: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222',
      user_file: REGISTRY_NATS_USER_FILE,
      password_file: REGISTRY_NATS_PASSWORD_FILE,
    });
    // The rendered entry passes admission for the controller.
    expect(
      hostInterfaceAllowed(blobstoreOf(switched), {
        username: 'system:serviceaccount:wasmcloud:di-platform-controller',
        controllerNamespace: 'wasmcloud',
        workloadNamespace: 'di-tenant-alpha',
      }),
    ).toBe(true);
  });

  it('generates passwords nats-server substitutes verbatim', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const value = newRegistryNatsPassword();
      expect(value).toMatch(REGISTRY_NATS_PASSWORD);
      // A leading digit, `-`, or a bare word nats-server reads as a number, size or boolean.
      expect(value).toMatch(/^[A-Za-z]/);
      seen.add(value);
    }
    expect(seen.size).toBe(500);
    for (const bad of ['12345', '-abc', 'true', '1MB', `${'a'.repeat(43)}`, `r${'a'.repeat(42)}=`])
      expect(REGISTRY_NATS_PASSWORD.test(bad)).toBe(false);
  });

  it('knows the published host images without wash patch 0003', () => {
    for (const digest of PRE_NATS_CREDENTIALS_HOST_IMAGE_DIGESTS)
      expect(
        hostImageSupportsNatsCredentials(`ghcr.io/di-framework/wash:2.8.0-wasi-tls@${digest}`),
      ).toBe(false);
    // The current default predates 0003 until the pin lands; the registry stays anonymous on it.
    // (`DEFAULT_HOST_IMAGE` in src/index.ts, asserted in platform.test.ts.)
    expect(
      hostImageSupportsNatsCredentials(
        'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:d88158b0b09edd9fc3e79d787762697c60f65baf134d895529e85d6c47cd80ad',
      ),
    ).toBe(false);
    expect(
      hostImageSupportsNatsCredentials(`ghcr.io/di-framework/wash@sha256:${'c'.repeat(64)}`),
    ).toBe(true);
    expect(hostImageSupportsNatsCredentials('wash:test')).toBe(true);
  });

  it('keeps the migration script from printing or passing the password on a command line', () => {
    expect(REGISTRY_NATS_MIGRATION_SCRIPT).not.toContain('--password');
    expect(REGISTRY_NATS_MIGRATION_SCRIPT).not.toMatch(/echo[^\n]*REGISTRY_PASSWORD/);
    expect(REGISTRY_NATS_MIGRATION_SCRIPT).not.toContain('set -x');
    expect(REGISTRY_NATS_MIGRATION_SCRIPT).toContain(
      'dst() { NATS_USER="$REGISTRY_USER" NATS_PASSWORD="$REGISTRY_PASSWORD" nats "$@"; }',
    );
    // Source and destination are checked to be different accounts before anything moves.
    const guard = REGISTRY_NATS_MIGRATION_SCRIPT.indexOf(
      'the anonymous login is not in the TENANT',
    );
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('object rm'));
    // The source is deleted only after the verification, and the marker written last.
    const verify = REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('objects differ');
    const remove = REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('src object rm');
    const marker = REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('kv put "$marker_bucket"');
    expect(verify).toBeLessThan(remove);
    expect(remove).toBeLessThan(marker);
  });
});

// ---- admission ---------------------------------------------------------------------------

const controllerUser = 'system:serviceaccount:wasmcloud:di-platform-controller';
const tenantUser = 'system:serviceaccount:wasmcloud:di-user-dev';
const users = [
  controllerUser,
  tenantUser,
  'system:serviceaccount:wasmcloud:di-platform-controller-x',
  'system:serviceaccount:other:di-platform-controller',
];
type Spec = {
  variables?: { name: string; expression: string }[];
  validations: { expression: string; message: string }[];
};
const policyResource = (name: string) =>
  must(
    admissionResources('test', 'wasmcloud').find(
      (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === `test-${name}`,
    ),
    `policy ${name}`,
  );
const policy = (name: string): Spec => policyResource(name).spec as Spec;
/** CEL result, an evaluation error counting as a denial (the policies fail closed). */
const allowed = (expression: string, context: Record<string, unknown>) => {
  try {
    return evaluate(expression, context) === true;
  } catch {
    return false;
  }
};
const workloadPolicy = policy('workloads');
const workloadVariables = (username: string, object: Record<string, unknown>) => {
  const request = { userInfo: { username }, operation: 'CREATE' };
  const variables: Record<string, unknown> = {};
  for (const name of ['w', 'controller']) {
    const { expression } = must(
      workloadPolicy.variables?.find((v) => v.name === name),
      `variable ${name}`,
    );
    variables[name] = evaluate(expression, { request, object, variables });
  }
  return { request, object, variables };
};
const workload = (namespace: string, spec: Record<string, unknown>) => ({
  metadata: { name: REGISTRY_WORKLOAD, namespace },
  spec: { template: { spec } },
});

describe('registry blobstore credential keys admission (#159)', () => {
  const rule = must(
    workloadPolicy.validations.find((v) => v.expression.includes('variables.w.hostInterfaces.all')),
    'host interface rule',
  );
  const url = 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222';
  const entry = (config: Record<string, unknown>): HostInterfaceLike => ({
    namespace: 'wasmcloud',
    package: 'blobstore',
    interfaces: ['blobstore', 'container', 'types'],
    config,
  });
  const credentials = {
    user_file: REGISTRY_NATS_USER_FILE,
    password_file: REGISTRY_NATS_PASSWORD_FILE,
  };
  const hostile: [string, Record<string, unknown>][] = [
    ['anonymous', { backend: 'nats', url }],
    ['credentials', { backend: 'nats', url, ...credentials }],
    ['user file only', { backend: 'nats', url, user_file: REGISTRY_NATS_USER_FILE }],
    ['password file only', { backend: 'nats', url, password_file: REGISTRY_NATS_PASSWORD_FILE }],
    [
      'swapped files',
      {
        backend: 'nats',
        url,
        user_file: REGISTRY_NATS_PASSWORD_FILE,
        password_file: REGISTRY_NATS_USER_FILE,
      },
    ],
    [
      'service account token',
      {
        backend: 'nats',
        url,
        ...credentials,
        password_file: '/var/run/secrets/kubernetes.io/serviceaccount/token',
      },
    ],
    [
      'scheduler key',
      { backend: 'nats', url, ...credentials, password_file: '/scheduler/tls.key' },
    ],
    [
      'trailing slash',
      { backend: 'nats', url, ...credentials, password_file: `${REGISTRY_NATS_PASSWORD_FILE}/` },
    ],
    [
      'dot segment',
      { backend: 'nats', url, ...credentials, password_file: `${REGISTRY_NATS_MOUNT}/./password` },
    ],
    [
      'dot-dot segment',
      {
        backend: 'nats',
        url,
        ...credentials,
        password_file: `${REGISTRY_NATS_MOUNT}/../registry-nats/password`,
      },
    ],
    [
      'double slash',
      { backend: 'nats', url, ...credentials, password_file: `/${REGISTRY_NATS_PASSWORD_FILE}` },
    ],
    ['relative', { backend: 'nats', url, ...credentials, password_file: 'password' }],
    [
      'upper case',
      { backend: 'nats', url, ...credentials, user_file: REGISTRY_NATS_USER_FILE.toUpperCase() },
    ],
    [
      'whitespace',
      { backend: 'nats', url, ...credentials, user_file: ` ${REGISTRY_NATS_USER_FILE}` },
    ],
    [
      'trailing newline',
      { backend: 'nats', url, ...credentials, password_file: `${REGISTRY_NATS_PASSWORD_FILE}\n` },
    ],
    [
      'NUL',
      {
        backend: 'nats',
        url,
        ...credentials,
        password_file: `${REGISTRY_NATS_PASSWORD_FILE}\u0000`,
      },
    ],
    ['empty', { backend: 'nats', url, ...credentials, user_file: '' }],
    ['number', { backend: 'nats', url, ...credentials, user_file: 1 }],
    ['null', { backend: 'nats', url, ...credentials, password_file: null }],
    [
      'list',
      { backend: 'nats', url, ...credentials, password_file: [REGISTRY_NATS_PASSWORD_FILE] },
    ],
    [
      'object',
      {
        backend: 'nats',
        url,
        ...credentials,
        password_file: { path: REGISTRY_NATS_PASSWORD_FILE },
      },
    ],
    ['extra key', { backend: 'nats', url, ...credentials, creds_file: '/x' }],
    ['credentials without url', { backend: 'nats', ...credentials }],
    [
      'credentials, other tenant url',
      { backend: 'nats', url: url.replace('alpha', 'beta'), ...credentials },
    ],
    ['credentials, other backend', { backend: 's3', url, ...credentials }],
    [
      'url userinfo',
      {
        backend: 'nats',
        url: 'nats://registry:x@di-nats.di-runtime-alpha.svc.cluster.local:4222',
        ...credentials,
      },
    ],
    ['credential keys alone', credentials],
    ['backend and two files', { backend: 'nats', ...credentials, url: undefined }],
  ];

  it('agrees with the TypeScript mirror on hostile values, for every requester and namespace', () => {
    let cases = 0;
    for (const username of users)
      for (const namespace of ['di-tenant-alpha', 'di-tenant-beta', 'default'])
        for (const [label, config] of hostile) {
          const h = entry(
            Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)),
          );
          const expected = hostInterfaceAllowed(h, {
            username,
            controllerNamespace: 'wasmcloud',
            workloadNamespace: namespace,
          });
          const actual = allowed(
            rule.expression,
            workloadVariables(username, workload(namespace, { hostInterfaces: [h] })),
          );
          if (actual !== expected)
            throw new Error(`CEL ${actual} vs TS ${expected}: ${username} ${namespace} ${label}`);
          cases++;
        }
    expect(cases).toBe(users.length * 3 * hostile.length);
  });

  it('admits exactly the anonymous and the pinned credential entry, from the controller only', () => {
    const admitted = hostile
      .filter(([, config]) =>
        allowed(
          rule.expression,
          workloadVariables(
            controllerUser,
            workload('di-tenant-alpha', { hostInterfaces: [entry(config)] }),
          ),
        ),
      )
      .map(([label]) => label);
    expect(admitted).toEqual(['anonymous', 'credentials']);
    for (const username of users.slice(1))
      for (const [, config] of hostile)
        expect(
          allowed(
            rule.expression,
            workloadVariables(
              username,
              workload('di-tenant-alpha', { hostInterfaces: [entry(config)] }),
            ),
          ),
        ).toBe(false);
  });

  it('never lets a tenant blobstore entry carry the keys, inline or through references', () => {
    for (const config of [credentials, { user_file: REGISTRY_NATS_USER_FILE }])
      for (const extra of [{}, { configFrom: [{ name: 'di-bs-files' }] }]) {
        const h = { ...entry(config), ...extra };
        expect(
          hostInterfaceAllowed(h, {
            username: tenantUser,
            controllerNamespace: 'wasmcloud',
            workloadNamespace: 'di-tenant-alpha',
          }),
        ).toBe(false);
        expect(
          allowed(
            rule.expression,
            workloadVariables(tenantUser, workload('di-tenant-alpha', { hostInterfaces: [h] })),
          ),
        ).toBe(false);
      }
  });
});

describe('controller-managed ConfigMaps and Secrets never carry the credential keys (#159)', () => {
  const spec = policy('managed-config-keys');
  const rule = must(spec.validations[0], 'managed-config-keys rule');
  const cases: [
    string,
    Record<string, unknown> | undefined,
    Record<string, unknown> | undefined,
  ][] = [
    ['di-bs-files', { backend: 'nats', url: 'nats://x:4222' }, undefined],
    ['di-bs-files', { backend: 'nats', user_file: '/x' }, undefined],
    ['di-bs-files', { password_file: '/x' }, undefined],
    ['di-binding-files', { backend: 'nats', url: 'nats://x:4222', password_file: '/x' }, undefined],
    ['di-binding-files-creds', undefined, { user_file: 'eA==' }],
    ['di-binding-files', undefined, undefined],
    ['di-binding-files', {}, {}],
    ['app-config', { user_file: '/x', password_file: '/y' }, undefined],
    ['di-tenant-stock', { backend: 'redis' }, undefined],
    ['di-bs-files', { USER_FILE: '/x', 'user_file ': '/y' }, undefined],
  ];

  it('matches the mirror for every requester, ConfigMaps and Secrets alike', () => {
    expect(rule.message).toBe(MANAGED_CONFIG_KEYS_MESSAGE);
    const deny = (
      name: string,
      data?: Record<string, unknown>,
      binaryData?: Record<string, unknown>,
    ) => !managedConfigKeysAllowed({ name, data, binaryData });
    for (const username of users)
      for (const [name, data, binaryData] of cases) {
        const object = {
          metadata: { name },
          ...(data ? { data } : {}),
          ...(binaryData ? { binaryData } : {}),
        };
        const actual = allowed(rule.expression, { request: { userInfo: { username } }, object });
        expect(actual).toBe(!deny(name, data, binaryData));
      }
    expect(
      cases.filter(([n, d, b]) => !managedConfigKeysAllowed({ name: n, data: d, binaryData: b })),
    ).toHaveLength(4);
  });

  it('applies to ConfigMaps and Secrets on create and update, in tenant namespaces', () => {
    const value = policyResource('managed-config-keys');
    expect(
      (value.spec as { matchConstraints: { resourceRules: unknown[] } }).matchConstraints
        .resourceRules,
    ).toEqual([
      {
        apiGroups: [''],
        apiVersions: ['v1'],
        operations: ['CREATE', 'UPDATE'],
        resources: ['configmaps', 'secrets'],
      },
    ]);
  });
});

describe('workload host volumes name platform storage only (#159)', () => {
  const rule = must(
    workloadPolicy.validations.find((v) => v.message === WORKLOAD_HOST_PATH_MESSAGE),
    'host path rule',
  );
  const paths: unknown[] = [
    `${HOST_MOUNT_ROOT}/app`,
    `${HOST_MOUNT_ROOT}/app-1`,
    REGISTRY_NATS_MOUNT,
    REGISTRY_NATS_PASSWORD_FILE,
    '/var/run/secrets/di-framework',
    '/var/run/secrets',
    '/var/run',
    '/',
    '/scheduler',
    '/registry-auth',
    HOST_MOUNT_ROOT,
    `${HOST_MOUNT_ROOT}/`,
    `${HOST_MOUNT_ROOT}/../../../run/secrets/di-framework/registry-nats`,
    `${HOST_MOUNT_ROOT}/app/../../x`,
    `${HOST_MOUNT_ROOT}/App`,
    `${HOST_MOUNT_ROOT}/app\n`,
    `/x${HOST_MOUNT_ROOT}/app`,
    '',
    7,
    undefined,
  ];
  const volumes = (path: unknown) => [{ name: 'v', hostPath: path === undefined ? {} : { path } }];

  it('agrees with the mirror for every requester, the controller included', () => {
    for (const username of users)
      for (const path of paths) {
        const expected = workloadHostPathsAllowed(volumes(path));
        const actual = allowed(
          rule.expression,
          workloadVariables(username, workload('di-tenant-alpha', { volumes: volumes(path) })),
        );
        if (actual !== expected)
          throw new Error(`CEL ${actual} vs TS ${expected}: ${username} ${String(path)}`);
      }
    expect(paths.filter((p) => workloadHostPathsAllowed(volumes(p)))).toEqual([
      `${HOST_MOUNT_ROOT}/app`,
      `${HOST_MOUNT_ROOT}/app-1`,
    ]);
    // Other volume kinds and no volumes are unaffected.
    expect(workloadHostPathsAllowed([{ name: 'tmp', emptyDir: {} }])).toBe(true);
    expect(workloadHostPathsAllowed(undefined)).toBe(true);
    expect(
      allowed(rule.expression, workloadVariables(controllerUser, workload('di-tenant-alpha', {}))),
    ).toBe(true);
  });

  it('admits the storage volume the controller patches in', () => {
    const patch = storagePatch({
      apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
      kind: 'WorkloadDeployment',
      metadata: {
        name: 'app',
        namespace: 'di-tenant-alpha',
        annotations: { 'di-framework.dev/persistent-storage': 'true' },
      },
      spec: { template: { spec: { components: [{ name: 'app', image: 'x' }] } } },
    });
    if (!patch) throw new Error('no storage patch');
    const spec = (patch.spec as { template: { spec: { volumes: { name: string }[] } } }).template
      .spec;
    expect(workloadHostPathsAllowed(spec.volumes)).toBe(true);
    expect(
      allowed(
        rule.expression,
        workloadVariables(controllerUser, workload('di-tenant-alpha', spec)),
      ),
    ).toBe(true);
  });
});

// ---- controller ---------------------------------------------------------------------------

/** An in-memory API: server-side apply merges, Deployments roll out at once unless held. */
class FakeApi implements Api {
  objects = new Map<string, Resource>();
  verbs = new Set<string>();
  held = new Set<string>();
  seed(value: Resource | Tenant): void {
    this.objects.set(
      `${collection(value.apiVersion, value.kind, value.metadata.namespace)}/${value.metadata.name}`,
      structuredClone(value) as Resource,
    );
  }
  get(apiVersion: string, kind: string, name: string, namespace = 'di-runtime-alpha') {
    return this.objects.get(`${collection(apiVersion, kind, namespace)}/${name}`);
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, 'https://kubernetes');
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.indexOf('namespaces');
    const plural = at >= 0 ? parts[at + 2] : parts[parts[0] === 'api' ? 2 : 3];
    if (method === 'GET' && url.searchParams.has('labelSelector')) {
      this.verbs.add(`list ${plural}`);
      const labels =
        url.searchParams
          .get('labelSelector')
          ?.split(',')
          .map((v) => v.split('=')) ?? [];
      return {
        items: [...this.objects.values()]
          .filter(
            (v) =>
              [
                collection(v.apiVersion, v.kind),
                collection(v.apiVersion, v.kind, v.metadata.namespace),
              ].includes(url.pathname) &&
              labels.every(([k = '', x]) => v.metadata.labels?.[k] === x),
          )
          .map(({ apiVersion: _a, kind: _k, ...item }) => item),
      } as T;
    }
    const target = url.pathname.replace(/\/status$/, '');
    const existing = this.objects.get(target);
    this.verbs.add(
      `${method === 'GET' ? 'get' : method === 'DELETE' ? 'delete' : existing ? 'patch' : 'create'} ${plural}`,
    );
    if (method === 'GET') {
      if (!existing) throw new ApiError(404, 'Not found');
      return structuredClone(existing) as T;
    }
    if (method === 'DELETE') {
      this.objects.delete(target);
      return {} as T;
    }
    const data = structuredClone(body) as Resource;
    const value = {
      ...existing,
      ...data,
      metadata: { ...existing?.metadata, ...data.metadata },
    } as Resource;
    value.metadata.uid ??= `${value.metadata.name}-uid`;
    value.metadata.generation = 1;
    if (value.kind === 'Deployment') {
      const replicas = (value.spec as { replicas: number }).replicas;
      value.status = this.held.has(value.metadata.name)
        ? { observedGeneration: 1, replicas, updatedReplicas: 0, readyReplicas: 0 }
        : { observedGeneration: 1, replicas, updatedReplicas: replicas, readyReplicas: replicas };
    }
    this.objects.set(target, value);
    return structuredClone(value) as T;
  }
}
function cluster(config: ControllerConfig = cfg) {
  const api = new FakeApi();
  const t = tenant();
  api.seed(t);
  api.seed({
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'Host',
    metadata: { name: 'alpha-host', namespace: 'wasmcloud', labels: { hostgroup: 'tenant-alpha' } },
    environment: 'di-tenant-alpha',
    status: { conditions: [readyCondition] },
  });
  for (const [name, data] of [
    ['wasmcloud-runtime-tls', { 'ca.crt': 'test' }],
    ['tenant-auth-oauth', { clientSecret: 'c2hhcmVk' }],
  ] as const)
    api.seed({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace: 'wasmcloud' },
      data,
    });
  api.seed({
    apiVersion: 'discovery.k8s.io/v1',
    kind: 'EndpointSlice',
    metadata: {
      name: 'kubernetes',
      namespace: 'default',
      labels: { 'kubernetes.io/service-name': 'kubernetes' },
    },
    endpoints: [{ addresses: ['10.0.0.1'] }],
    ports: [{ port: 6443 }],
  });
  return { api, t, controller: new Controller(api, config) };
}
/** `data` of a core object in the runtime namespace; throws when it is missing. */
const dataOf = (api: FakeApi, kind: string, name: string) => {
  const value = api.get('v1', kind, name);
  if (!value) throw new Error(`no ${kind} ${name}`);
  return value.data as Record<string, string>;
};
const password = (api: FakeApi) =>
  Buffer.from(
    must(dataOf(api, 'Secret', REGISTRY_NATS_SECRET).password, 'password'),
    'base64',
  ).toString();
const natsConfigOf = (api: FakeApi) => dataOf(api, 'ConfigMap', RUNTIME_NATS_CONFIG)['nats.conf'];
const registry = (api: FakeApi) =>
  api.get(
    'runtime.wasmcloud.dev/v1alpha1',
    'WorkloadDeployment',
    REGISTRY_WORKLOAD,
    'di-tenant-alpha',
  ) as Workload;
const tenantAuthCondition = (api: FakeApi) => {
  const value = api.objects.get(`${collection(VERSION, 'Tenant')}/alpha`);
  const status = value?.status as { conditions?: Condition[] } | undefined;
  return status?.conditions?.find((c) => c.type === 'TenantAuthReady');
};
const succeed = (api: FakeApi) => {
  const job = must(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB), 'Job');
  job.status = { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] };
};

describe('controller: registry NATS account and migration (#159)', () => {
  it('rolls out the account, then stops the registry and runs the Job, then switches it', async () => {
    const { api, t, controller } = cluster();
    // Until di-nats and the hosts rolled out with the password, the registry stays anonymous.
    api.held.add('hostgroup-tenant-alpha');
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    const first = password(api);
    expect(first).toMatch(REGISTRY_NATS_PASSWORD);
    expect(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBeUndefined();
    expect(registry(api).spec.replicas).toBe(1);
    expect(Object.keys(blobstoreOf(registry(api)).config ?? {})).toEqual(['backend', 'url']);
    const natsConfig = natsConfigOf(api);
    expect(natsConfig).toContain('REGISTRY {');

    // Rolled out: the Job runs and the registry is stopped meanwhile.
    api.held.clear();
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    expect(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBeDefined();
    expect(registry(api).spec.replicas).toBe(0);
    expect(tenantAuthCondition(api)).toMatchObject({
      status: 'False',
      reason: 'RegistryMigrating',
    });

    // Once the Job exists, a host roll (a rotation, say) does not restart the registry under it.
    api.held.add('hostgroup-tenant-alpha');
    await controller.reconcileTenant(t, []);
    expect(registry(api).spec.replicas).toBe(0);
    api.held.clear();

    // A Job that gave up is reported; the registry stays stopped.
    must(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB), 'Job').status = {
      conditions: [{ type: 'Failed', status: 'True' }],
    };
    await controller.reconcileTenant(t, []);
    expect(tenantAuthCondition(api)).toMatchObject({ reason: 'RegistryMigrationFailed' });
    expect(registry(api).spec.replicas).toBe(0);

    // Succeeded: the marker is written and the registry runs with the mounted credentials.
    succeed(api);
    await controller.reconcileTenant(t, []);
    expect(api.get('v1', 'ConfigMap', REGISTRY_NATS_MIGRATION)?.data).toEqual({
      state: 'complete',
    });
    expect(registry(api).spec.replicas).toBe(1);
    expect(blobstoreOf(registry(api)).config).toMatchObject({
      user_file: REGISTRY_NATS_USER_FILE,
      password_file: REGISTRY_NATS_PASSWORD_FILE,
    });
    expect(tenantAuthCondition(api)?.reason).not.toMatch(/^RegistryMigrat/);
    expect(password(api)).toBe(first);

    // The marker holds even after the Job is cleaned up; the Job is not recreated.
    api.objects.delete(
      `${collection('batch/v1', 'Job', 'di-runtime-alpha')}/${REGISTRY_NATS_MIGRATION_JOB}`,
    );
    await controller.reconcileTenant(t, []);
    expect(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBeUndefined();
    expect(registry(api).spec.replicas).toBe(1);

    // The Job verbs it used are granted to the platform controller.
    const granted = controllerClusterRoleRules()
      .filter((r) => r.resources.includes('jobs'))
      .flatMap((r) => r.verbs);
    const used = [...api.verbs].filter((v) => v.endsWith(' jobs')).map((v) => v.slice(0, -5));
    expect(used.sort()).toEqual(['create', 'get', 'patch']);
    for (const verb of used) expect(granted).toContain(verb);

    // The password is in the credentials Secret only.
    for (const [key, value] of api.objects) {
      if (key.endsWith(`/secrets/${REGISTRY_NATS_SECRET}`)) continue;
      expect(JSON.stringify(value)).not.toContain(first);
    }
  });

  it('rotates the password when the Secret is deleted, restarting di-nats and the hosts', async () => {
    const { api, t, controller } = cluster();
    await controller.reconcileTenant(t, []);
    const annotation = (name: string) =>
      (api.get('apps/v1', 'Deployment', name) as unknown as { spec: { template: PodTemplate } })
        .spec.template.metadata.annotations?.[REGISTRY_NATS_AUTH_ANNOTATION];
    const before = password(api);
    expect(annotation('di-nats')).toBe(registryNatsAuthDigest(before));
    expect(annotation('hostgroup-tenant-alpha')).toBe(registryNatsAuthDigest(before));
    await controller.reconcileTenant(t, []);
    expect(password(api)).toBe(before);
    api.objects.delete(`${collection('v1', 'Secret', 'di-runtime-alpha')}/${REGISTRY_NATS_SECRET}`);
    await controller.reconcileTenant(t, []);
    const after = password(api);
    expect(after).not.toBe(before);
    expect(annotation('di-nats')).toBe(registryNatsAuthDigest(after));
    expect(annotation('hostgroup-tenant-alpha')).toBe(registryNatsAuthDigest(after));
    // A malformed value is replaced too.
    dataOf(api, 'Secret', REGISTRY_NATS_SECRET).password = Buffer.from('12345').toString('base64');
    await controller.reconcileTenant(t, []);
    expect(password(api)).toMatch(REGISTRY_NATS_PASSWORD);
  });

  it('keeps the registry anonymous in TENANT on a host image without patch 0003, and says so once', async () => {
    const old = `ghcr.io/di-framework/wash:2.8.0-wasi-tls@${PRE_NATS_CREDENTIALS_HOST_IMAGE_DIGESTS[1]}`;
    const { api, t, controller } = cluster({ ...cfg, hostImage: old });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await controller.reconcileTenant(t, []);
      await controller.reconcileTenant(t, []);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('predates wash patch 0003');
    } finally {
      warn.mockRestore();
    }
    expect(api.get('v1', 'Secret', REGISTRY_NATS_SECRET)).toBeUndefined();
    expect(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBeUndefined();
    const natsConfig = natsConfigOf(api);
    expect(natsConfig).toContain('no_auth_user: "tenant"');
    expect(natsConfig).not.toContain('REGISTRY');
    expect(registry(api).spec.replicas).toBe(1);
    expect(Object.keys(blobstoreOf(registry(api)).config ?? {})).toEqual(['backend', 'url']);
  });

  it('removes the credentials Secret with the registry, and keeps the marker', async () => {
    const { api, t, controller } = cluster();
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    succeed(api);
    await controller.reconcileTenant(t, []);
    expect(api.get('v1', 'ConfigMap', REGISTRY_NATS_MIGRATION)).toBeDefined();
    const { registry: _registry, ...withoutRegistry } = auth;
    const off = new Controller(api, { ...cfg, tenantAuth: withoutRegistry });
    await off.reconcileTenant(t, []);
    expect(api.get('v1', 'Secret', REGISTRY_NATS_SECRET)).toBeUndefined();
    expect(api.get('v1', 'ConfigMap', REGISTRY_NATS_MIGRATION)).toBeDefined();
    const natsConfig = natsConfigOf(api);
    expect(natsConfig).not.toContain('REGISTRY');
    const host = (
      api.get('apps/v1', 'Deployment', 'hostgroup-tenant-alpha') as unknown as {
        spec: { template: PodTemplate };
      }
    ).spec.template;
    expect(JSON.stringify(host)).not.toContain(REGISTRY_NATS_MOUNT);
  });

  it('does not run the Job for a suspended tenant', async () => {
    const { api, controller } = cluster();
    const t = tenant({ suspended: true });
    api.seed(t);
    await controller.reconcileTenant(t, []);
    await controller.reconcileTenant(t, []);
    expect(api.get('batch/v1', 'Job', REGISTRY_NATS_MIGRATION_JOB)).toBeUndefined();
  });
});
