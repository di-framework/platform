import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  NATS_BOX_IMAGE,
  newRegistryNatsPassword,
  REGISTRY_BUCKET,
  REGISTRY_NATS_MIGRATION_JOB,
  REGISTRY_NATS_PASSWORD_ENV,
  REGISTRY_NATS_SECRET,
} from '../src/tenancy/registry-nats';
import {
  type ControllerConfig,
  INSTALLATION,
  type Resource,
  RUNTIME_NATS_CONFIG,
  RUNTIME_NATS_IMAGE,
  type Tenant,
  tenantResources,
  VERSION,
} from '../src/tenancy/resources';

/**
 * uid-65532 smoke test of the registry migration Job (#397, after #391).
 *
 * Renders the Job exactly as the controller does, then runs its container (image, command,
 * workingDir, env, user) against a throwaway nats-server started from the rendered `di-nats`
 * config, with a seeded registry object store in the TENANT account, and checks that the store
 * moved to REGISTRY.
 *
 * The container runs as the pod does: as the Job's `runAsUser` / `runAsGroup`, with a read-only
 * root filesystem, an emptyDir-like tmpfs at /tmp, all capabilities dropped and no privilege
 * escalation. The runtime enters the working directory (the Job's `workingDir`, else the image's
 * WORKDIR `/root`, mode 0700) before switching user, as runc does, so a Job without `workingDir`
 * fails with `stat .: permission denied` (#391). The check fails if the Job spec loses `workingDir`.
 *
 * It needs docker or podman and pulls two images, so it runs only with REGISTRY_NATS_SMOKE=1 (the
 * `registry-nats-smoke` job in .github/workflows/ci.yml). CONTAINER_RUNTIME picks the runtime;
 * docker is the default when it is on PATH.
 */

const enabled = process.env.REGISTRY_NATS_SMOKE === '1';
const runtime = !enabled
  ? 'docker'
  : (process.env.CONTAINER_RUNTIME ??
    (spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0 ? 'docker' : 'podman'));

const PASSWORD = newRegistryNatsPassword();
const id = randomBytes(4).toString('hex');
const network = `registry-nats-smoke-${id}`;
const server = `registry-nats-smoke-server-${id}`;
/** Seeded registry objects: a name and the shell that writes the content (one spans chunks). */
const OBJECTS = [
  { name: 'blobs/sha256:aaaa', write: "head -c 300000 /dev/zero | tr '\\0' a" },
  { name: 'manifests/alpha/latest', write: `printf '%s' '{"schemaVersion":2}'` },
];

type Container = {
  image: string;
  workingDir?: string;
  command: string[];
  env: {
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef: { name: string; key: string } };
  }[];
};
type Job = Resource & {
  spec: {
    template: {
      spec: {
        securityContext: { runAsUser: number; runAsGroup: number };
        containers: Container[];
      };
    };
  };
};

function render(): Resource[] {
  const tenant: Tenant = {
    apiVersion: VERSION,
    kind: 'Tenant',
    metadata: {
      name: 'alpha',
      uid: 'alpha-uid',
      generation: 1,
      labels: { [INSTALLATION]: 'smoke' },
    },
    spec: {},
    status: {
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          observedGeneration: 1,
          reason: 'Reconciled',
          message: '',
          lastTransitionTime: '2026-01-01T00:00:00Z',
        },
      ],
    },
  };
  const cfg: ControllerConfig = {
    installation: 'smoke',
    namespace: 'wasmcloud',
    hostImage:
      'ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:e27812beefa4ff8ad7a6ae6f5c64eaf67d6d4719ed36c5880bda6106e24b84ab',
    schedulerNatsUrl: 'nats://nats:4222',
  };
  return tenantResources(
    tenant,
    cfg,
    { data: { 'ca.crt': 'smoke' } },
    [],
    false,
    false,
    false,
    undefined,
    {
      password: PASSWORD,
      stage: 'migrating',
      credentials: true,
    },
  );
}

function find<T extends Resource>(resources: Resource[], kind: string, name: string): T {
  const found = resources.find((r) => r.kind === kind && r.metadata.name === name);
  if (!found) throw new Error(`no ${kind} ${name} rendered`);
  return found as T;
}

/** Runs the container runtime; `env` is added to the environment `-e NAME` flags read from. */
function container(args: string[], env: Record<string, string> = {}) {
  const child = spawnSync(runtime, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300_000,
  });
  return {
    status: child.status,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
    error: child.error,
  };
}
function mustRun(args: string[], env: Record<string, string> = {}) {
  const result = container(args, env);
  if (result.status !== 0)
    throw new Error(
      `${runtime} ${args.slice(0, 2).join(' ')} failed: ${result.error ?? ''}${result.stderr}`,
    );
  return result;
}

/** A nats-box shell as root in /tmp on the smoke network; `registry` logs in as the registry user. */
function natsBox(script: string, registry = false) {
  return container(
    [
      'run',
      '--rm',
      '--network',
      network,
      '--workdir',
      '/tmp',
      '-e',
      'NATS_URL',
      ...(registry ? ['-e', 'NATS_USER', '-e', 'NATS_PASSWORD'] : []),
      '--entrypoint',
      'sh',
      NATS_BOX_IMAGE,
      '-c',
      `set -eu\n${script}`,
    ],
    {
      NATS_URL: `nats://${server}:4222`,
      ...(registry ? { NATS_USER: 'registry', NATS_PASSWORD: PASSWORD } : {}),
    },
  );
}

describe.skipIf(!enabled)('registry migration Job as uid 65532 against nats-server (#397)', () => {
  const resources = render();
  const job = find<Job>(resources, 'Job', REGISTRY_NATS_MIGRATION_JOB);
  const pod = job.spec.template.spec;
  const [migrate] = pod.containers;
  if (!migrate) throw new Error('the migration Job has no container');
  const secret = find<Resource & { data: Record<string, string> }>(
    resources,
    'Secret',
    REGISTRY_NATS_SECRET,
  );
  const natsConf = (find<Resource & { data: Record<string, string> }>(
    resources,
    'ConfigMap',
    RUNTIME_NATS_CONFIG,
  ).data['nats.conf'] ?? '') as string;
  const natsUrl = migrate.env.find((e) => e.name === 'NATS_URL')?.value ?? '';
  const natsHost = new URL(natsUrl).hostname;

  beforeAll(() => {
    mustRun(['network', 'create', network]);
    // di-nats as rendered: its config and the registry password from the Secret, reachable under
    // the Job's NATS_URL host name.
    mustRun(
      [
        'run',
        '-d',
        '--name',
        server,
        '--network',
        network,
        '--network-alias',
        natsHost,
        '--tmpfs',
        '/data',
        '-e',
        'NATS_CONF',
        '-e',
        REGISTRY_NATS_PASSWORD_ENV,
        '--entrypoint',
        'sh',
        RUNTIME_NATS_IMAGE,
        '-c',
        'printf "%s" "$NATS_CONF" > /tmp/nats.conf && exec nats-server -c /tmp/nats.conf',
      ],
      { NATS_CONF: natsConf, [REGISTRY_NATS_PASSWORD_ENV]: PASSWORD },
    );
    // The registry's store in TENANT, as the anonymous host data client left it.
    const files = OBJECTS.map(
      (o, i) =>
        `${o.write} > o${i}\nnats object put ${REGISTRY_BUCKET} o${i} --name '${o.name}' --no-progress -f >/dev/null`,
    ).join('\n');
    const seeded =
      natsBox(`for i in $(seq 1 60); do nats account info >/dev/null 2>&1 && break; sleep 1; done
nats object add ${REGISTRY_BUCKET} >/dev/null
${files}
nats object ls ${REGISTRY_BUCKET} --names`);
    if (seeded.status !== 0) throw new Error(`seeding failed: ${seeded.stderr}`);
  }, 300_000);

  afterAll(() => {
    container(['rm', '-f', server]);
    container(['network', 'rm', network]);
  });

  it('runs the Job container as rendered and moves the store into REGISTRY', () => {
    const user = pod.securityContext.runAsUser;
    const group = pod.securityContext.runAsGroup;
    expect(user).toBe(65532);
    // The Job's env: plain values as flags; Secret references resolved from the rendered Secret
    // and passed by name, so the password is never on a command line.
    const flags: string[] = [];
    const env: Record<string, string> = {};
    for (const e of migrate.env) {
      const ref = e.valueFrom?.secretKeyRef;
      if (!ref) {
        flags.push('-e', `${e.name}=${e.value ?? ''}`);
        continue;
      }
      if (ref.name !== REGISTRY_NATS_SECRET) throw new Error(`unexpected Secret ${ref.name}`);
      env[e.name] = Buffer.from(secret.data[ref.key] ?? '', 'base64').toString();
      flags.push('-e', e.name);
    }
    const [shell, flag, script] = migrate.command;
    expect([shell, flag]).toEqual(['sh', '-c']);
    const result = container(
      [
        'run',
        '--rm',
        '--network',
        network,
        // As in the pod: the Job's user, read-only root fs, no capabilities, no escalation.
        '--user',
        `${user}:${group}`,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        // As in the pod: an emptyDir /tmp (world-writable).
        '--tmpfs',
        '/tmp:rw,mode=1777',
        ...(migrate.workingDir ? ['--workdir', migrate.workingDir] : []),
        ...flags,
        '--entrypoint',
        'sh',
        migrate.image,
        '-c',
        script ?? '',
      ],
      env,
    );
    const output = `${result.stdout}${result.stderr}`;
    console.log(`migration Job (workingDir ${migrate.workingDir ?? 'unset'}):\n${output}`);
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain('permission denied');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`verified ${OBJECTS.length} objects`);
    expect(result.stdout).toContain('registry migration: complete');

    // The store is gone from TENANT and whole in REGISTRY, and the marker is written.
    const tenant = natsBox('nats stream ls --names');
    expect(tenant.status).toBe(0);
    expect(tenant.stdout).not.toContain(`OBJ_${REGISTRY_BUCKET}`);
    const registry = natsBox(
      `nats object ls ${REGISTRY_BUCKET} --names | sort
nats kv get di-platform-migrations registry-object-store --raw`,
      true,
    );
    expect(registry.status).toBe(0);
    expect(registry.stdout.trim().split('\n')).toEqual([
      ...OBJECTS.map((o) => o.name).sort(),
      'complete',
    ]);
  }, 300_000);
});
