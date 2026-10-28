/**
 * The platform operator's Helm chart (#272): it renders, carries the generated CRD and ClusterRole
 * unchanged (plus the keep annotation on the CRD), passes the operator flags main.go defines, pulls
 * the image by digest, and keeps the CRD, the state claim and the passphrase on `helm uninstall`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { helm } from '../platform/backup-destination/tests/support/helm.ts';
import { ARTIFACTS } from '../scripts/pin-artifact';

const operator = resolve(import.meta.dir, '..', 'platform', 'operator');
const chart = join(operator, 'chart');
const CRD = join(operator, 'config', 'crd', 'platform.di-framework.dev_platforminstances.yaml');
const ROLE = join(operator, 'config', 'rbac', 'role.yaml');
/** sha256 of headlamp-0.46.0.tgz: the `digest` of that release in the upstream index.yaml. */
const HEADLAMP_SHA256 = 'faa471a8c5c55125b3dceed1cf73000e1ced18f07e2088e5e12e75292fb9ae62';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const KEEP = { 'helm.sh/resource-policy': 'keep' };
/** The passphrase Secret the offline renders mount (`helm template` cannot reach a cluster). */
const PASSPHRASE = 'platform-operator-passphrase';

type Doc = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  // biome-ignore lint/suspicious/noExplicitAny: rendered manifests are read loosely.
  [key: string]: any;
};

const read = (path: string) => readFileSync(path, 'utf8');

/** The YAML documents in a multi-document stream, comments and empty documents dropped. */
function docs(text: string): Doc[] {
  return text
    .split(/^---\s*$/m)
    .map((part) => Bun.YAML.parse(part) as Doc | null)
    .filter((doc): doc is Doc => doc !== null && typeof doc === 'object');
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([await helm(), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** `helm template` with only the given --set values: no cluster, so lookup sees nothing. */
function offline(...set: string[]) {
  const args = ['template', 'platform-operator', chart, '--namespace', 'platform-operator'];
  for (const value of set) args.push('--set', value);
  return run(args);
}

/**
 * Renders offline with a valid digest and an existing passphrase Secret, the two values an offline
 * render needs; `set` comes after them, so it can override either.
 */
async function template(...set: string[]): Promise<Doc[]> {
  const out = await offline(
    `image.digest=${DIGEST}`,
    `passphrase.existingSecret=${PASSPHRASE}`,
    ...set,
  );
  if (out.code !== 0) throw new Error(`helm template failed: ${out.stderr}`);
  return docs(out.stdout);
}

/** The three lookups passphrase.yaml makes, each replaced by a value in the mocked chart. */
const LOOKUPS = {
  namespace: 'lookup "v1" "Namespace" "" "kube-system"',
  secret: 'lookup "v1" "Secret" .Release.Namespace $name',
  claim:
    'lookup "v1" "PersistentVolumeClaim" .Release.Namespace (include "platform-operator.stateClaim" .)',
} as const;

/**
 * A copy of the chart whose passphrase lookups read `.Values.mock.<name>` instead of the cluster,
 * so `helm template` can render the online paths (helm-unittest-style lookup mocks without the
 * plugin). Every lookup must appear exactly once, or the mock would silently miss it.
 */
function mockedChart(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'operator-chart-')), 'chart');
  cpSync(chart, dir, { recursive: true });
  const file = join(dir, 'templates', 'passphrase.yaml');
  let source = read(file);
  for (const [name, call] of Object.entries(LOOKUPS)) {
    expect(source.split(call).length - 1).toBe(1);
    source = source.replace(call, `.Values.mock.${name}`);
  }
  expect(source).not.toMatch(/lookup "/);
  writeFileSync(file, source);
  return dir;
}

/** Renders the mocked chart as if online: kube-system exists, plus the given Secret and claim. */
function online(dir: string, mock: { secret?: unknown; claim?: unknown }) {
  const mocks = { namespace: { metadata: { name: 'kube-system' } }, ...mock };
  return run([
    'template',
    'platform-operator',
    dir,
    '--namespace',
    'platform-operator',
    '--set',
    `image.digest=${DIGEST}`,
    '--set-json',
    `mock=${JSON.stringify(mocks)}`,
  ]);
}

const CLAIM = { metadata: { name: 'platform-operator-state' } };

function find(rendered: Doc[], kind: string, name?: string): Doc {
  const doc = rendered.find(
    (d) => d.kind === kind && (name === undefined || d.metadata.name === name),
  );
  if (!doc) throw new Error(`no ${kind} ${name ?? ''} rendered`);
  return doc;
}

/** The operator Deployment (Headlamp, when enabled, renders one too). */
const operatorDeployment = (rendered: Doc[]) => find(rendered, 'Deployment', 'platform-operator');

/** The flags cmd/platform-operator/main.go defines with the standard flag package. */
function mainFlags(): string[] {
  const source = read(join(operator, 'cmd', 'platform-operator', 'main.go'));
  return [...source.matchAll(/flag\.(?:String|Duration|Int|Bool)\("([a-z-]+)"/g)].map(
    (m) => m[1] ?? '',
  );
}

describe('platform-operator chart', () => {
  test('helm lint passes', async () => {
    const out = await run(['lint', chart]);
    expect(out.stderr + out.stdout).not.toContain('[ERROR]');
    expect(out.code).toBe(0);
  }, 60000);

  test('renders with defaults: the operator and its keep-annotated state, no Headlamp', async () => {
    const rendered = await template();
    expect(rendered.map((d) => d.kind).sort()).toEqual([
      'ClusterRole',
      'ClusterRoleBinding',
      'ClusterRoleBinding',
      'CustomResourceDefinition',
      'Deployment',
      'PersistentVolumeClaim',
      'ServiceAccount',
    ]);
    expect(JSON.stringify(rendered)).not.toContain('headlamp');
  }, 60000);

  test('headlamp.enabled=true adds the vendored Headlamp chart', async () => {
    const rendered = await template('headlamp.enabled=true');
    const headlamp = find(rendered, 'Deployment', 'platform-operator-headlamp');
    expect(JSON.stringify(headlamp)).toContain('ghcr.io/headlamp-k8s/headlamp:v0.46.0');
    expect(operatorDeployment(rendered)).toBeDefined();
  }, 60000);

  test('the vendored Headlamp chart is the upstream release, as Chart.lock records', () => {
    const tgz = readFileSync(join(chart, 'charts', 'headlamp-0.46.0.tgz'));
    expect(createHash('sha256').update(tgz).digest('hex')).toBe(HEADLAMP_SHA256);
    const meta = Bun.YAML.parse(read(join(chart, 'Chart.yaml'))) as {
      dependencies: { name: string; version: string; repository: string; condition: string }[];
    };
    const lock = Bun.YAML.parse(read(join(chart, 'Chart.lock'))) as {
      dependencies: { name: string; version: string; repository: string }[];
    };
    expect(meta.dependencies).toEqual([
      {
        name: 'headlamp',
        version: '0.46.0',
        repository: 'https://kubernetes-sigs.github.io/headlamp/',
        condition: 'headlamp.enabled',
      },
    ]);
    expect(lock.dependencies).toEqual([
      {
        name: 'headlamp',
        version: '0.46.0',
        repository: 'https://kubernetes-sigs.github.io/headlamp/',
      },
    ]);
  });

  test('the CRD is config/crd plus helm.sh/resource-policy: keep, in templates/', async () => {
    const [expected] = docs(read(CRD));
    if (!expected) throw new Error('config/crd is empty');
    expected.metadata.annotations = { ...expected.metadata.annotations, ...KEEP };
    expect(find(await template(), 'CustomResourceDefinition')).toEqual(expected);
    // Byte for byte too: the generated file is the source with one line added and a header.
    const generated = read(join(chart, 'templates', 'crd.yaml')).split('\n');
    expect(generated[0]).toStartWith('# Generated by `make generate`');
    expect(
      generated
        .slice(1)
        .filter((line) => line !== '    helm.sh/resource-policy: keep')
        .join('\n'),
    ).toBe(read(CRD));
  }, 60000);

  test('the ClusterRole is config/rbac, bound to the operator with cluster-admin beside it', async () => {
    const rendered = await template();
    const [expected] = docs(read(ROLE));
    expect(find(rendered, 'ClusterRole')).toEqual(expected as Doc);
    const subject = {
      kind: 'ServiceAccount',
      name: 'platform-operator',
      namespace: 'platform-operator',
    };
    expect(find(rendered, 'ServiceAccount').metadata.name).toBe('platform-operator');
    const bindings = rendered.filter((d) => d.kind === 'ClusterRoleBinding');
    expect(bindings.map((b) => b.roleRef.name).sort()).toEqual([
      'cluster-admin',
      'platform-operator',
    ]);
    for (const binding of bindings) expect(binding.subjects).toEqual([subject]);
  }, 60000);

  test('the Deployment passes only flags main.go defines, and every one the chart owns', async () => {
    const defined = mainFlags();
    expect(defined).toContain('state-dir');
    const deployment = operatorDeployment(await template());
    const container = deployment.spec.template.spec.containers[0];
    const args = container.args as string[];
    const names = args.map((arg) => /^--([a-z-]+)=/.exec(arg)?.[1]);
    for (const name of names) expect(defined).toContain(name as string);
    // npm and the baked project and plugins (#431) keep their image defaults, and cleanup-namespace
    // (#426) defaults to the operator's own namespace unless cleanupNamespace is set; everything
    // else is set from values.
    const imageDefaults = ['npm', 'baked-project', 'baked-plugins', 'cleanup-namespace'];
    expect(names.sort()).toEqual(defined.filter((f) => !imageDefaults.includes(f)).sort());
    // Nothing reads POD_NAMESPACE: the operator takes its namespace from the ServiceAccount.
    expect(container.env).toBeUndefined();
    expect(args).toContain('--state-dir=/var/lib/platform-operator');
    expect(args).toContain('--passphrase-file=/etc/platform-operator/passphrase');
    expect(args).toContain('--storage-root-base=/var/lib/kubesolo/instances');
    expect(args).toContain('--install-timeout=30m');
    expect(args).toContain('--leader-elect=true');
    expect(args).toContain('--health-probe-bind-address=:8081');
    const mounts = Object.fromEntries(
      (container.volumeMounts as { name: string; mountPath: string }[]).map((m) => [
        m.name,
        m.mountPath,
      ]),
    );
    expect(mounts.state).toBe('/var/lib/platform-operator');
    expect(mounts.passphrase).toBe('/etc/platform-operator');
    const custom = operatorDeployment(
      await template(
        'storageRootBase=/srv/instances',
        'installTimeout=1h',
        'leaderElect=false',
        'cleanupNamespace=pi-cleanup',
      ),
    ).spec.template.spec.containers[0].args as string[];
    expect(custom).toContain('--cleanup-namespace=pi-cleanup');
    expect(custom).toContain('--storage-root-base=/srv/instances');
    expect(custom).toContain('--install-timeout=1h');
    expect(custom).toContain('--leader-elect=false');
  }, 60000);

  test('probes hit 8081 and the pod runs as the image user (node, uid 1000)', async () => {
    expect(read(join(operator, 'Dockerfile'))).toMatch(/^USER node$/m);
    const pod = operatorDeployment(await template()).spec.template.spec;
    const container = pod.containers[0];
    expect(container.livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'probes' });
    expect(container.readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'probes' });
    expect(container.ports).toContainEqual({ name: 'probes', containerPort: 8081 });
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000,
    });
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
  }, 60000);

  test('the image is pulled by digest; the default is a pinned digest pin-artifact maintains', async () => {
    const values = Bun.YAML.parse(read(join(chart, 'values.yaml'))) as {
      image: { repository: string; digest: string };
    };
    expect(values.image.repository).toBe('ghcr.io/di-framework/platform-operator');
    // A placeholder must never reach a release: the chart job skips an unpinned digest.
    expect(values.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The image pin PR rewrites values.yaml along with the README, so the pin cannot go stale.
    expect(ARTIFACTS['platform-operator']?.map((t) => t.file)).toContain(
      'platform/operator/chart/values.yaml',
    );
    const pinned = operatorDeployment(await template(`image.digest=${DIGEST}`));
    expect(pinned.spec.template.spec.containers[0].image).toBe(
      `ghcr.io/di-framework/platform-operator@${DIGEST}`,
    );
    const rejected = [
      'latest',
      'sha256:<pinned by the platform-operator image pin PR>',
      'sha256:zz',
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(65)}`,
      `sha256:${'A'.repeat(64)}`,
      `x${DIGEST}`,
    ];
    for (const digest of rejected) {
      const out = await offline(
        `passphrase.existingSecret=${PASSPHRASE}`,
        `image.digest=${digest}`,
      );
      expect(out.code).not.toBe(0);
      expect(out.stderr).toContain('image.digest must be a sha256 digest');
    }
  }, 60000);

  test('the default values render: the checked-in digest is pinned', async () => {
    const out = await offline(`passphrase.existingSecret=${PASSPHRASE}`);
    expect(out.code).toBe(0);
  }, 60000);

  test('replicaCount > 1 requires leader election', async () => {
    const out = await offline(
      `image.digest=${DIGEST}`,
      `passphrase.existingSecret=${PASSPHRASE}`,
      'replicaCount=2',
      'leaderElect=false',
    );
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('replicaCount > 1 requires leaderElect');
    expect(operatorDeployment(await template('replicaCount=2')).spec.replicas).toBe(2);
    expect(operatorDeployment(await template('leaderElect=false')).spec.replicas).toBe(1);
  }, 60000);

  test('an offline render without passphrase.existingSecret fails instead of generating one', async () => {
    // helm template never sees a cluster, like client-side --dry-run and Argo CD: a generated
    // passphrase there would overwrite the live one when applied.
    const out = await offline(`image.digest=${DIGEST}`);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('this render cannot see the cluster');
    expect(out.stderr).toContain('passphrase.existingSecret');
    expect(out.stdout).not.toContain('kind: Secret');
  }, 60000);

  test('online: the passphrase is reused when its Secret exists, generated only on a first install', async () => {
    const dir = mockedChart();
    const kept = Buffer.from('the-original-passphrase').toString('base64');
    const reused = await online(dir, { secret: { data: { passphrase: kept } }, claim: CLAIM });
    expect(reused.stderr).toBe('');
    expect(find(docs(reused.stdout), 'Secret').data.passphrase).toBe(kept);
    const fresh = await online(dir, {});
    expect(fresh.code).toBe(0);
    const secret = find(docs(fresh.stdout), 'Secret');
    expect(secret.metadata.annotations).toMatchObject(KEEP);
    expect(Buffer.from(secret.data.passphrase, 'base64').toString()).toMatch(/^[A-Za-z0-9]{48}$/);
  }, 60000);

  test('online: a kept state claim without its Secret, or a Secret without the key, fails (S8)', async () => {
    const dir = mockedChart();
    const orphan = await online(dir, { claim: CLAIM });
    expect(orphan.code).not.toBe(0);
    expect(orphan.stderr).toContain(
      'the state claim platform-operator/platform-operator-state exists',
    );
    expect(orphan.stdout).not.toContain('kind: Secret');
    for (const claim of [CLAIM, undefined]) {
      const keyless = await online(dir, { secret: { data: { other: 'eA==' } }, claim });
      expect(keyless.code).not.toBe(0);
      expect(keyless.stderr).toContain('exists but has no `passphrase` key');
    }
  }, 60000);

  test('state.existingClaim without passphrase.existingSecret fails up front (S10)', async () => {
    const message = 'state.existingClaim requires passphrase.existingSecret';
    // Offline, before the cannot-see-the-cluster guard.
    const offlineOut = await offline(`image.digest=${DIGEST}`, 'state.existingClaim=my-empty-pvc');
    expect(offlineOut.code).not.toBe(0);
    expect(offlineOut.stderr).toContain(message);
    expect(offlineOut.stderr).not.toContain('this render cannot see the cluster');
    // Online, with an empty pre-provisioned claim: no misleading unknown-passphrase message.
    const dir = mockedChart();
    const out = await run([
      'template',
      'platform-operator',
      dir,
      '--namespace',
      'platform-operator',
      '--set',
      `image.digest=${DIGEST}`,
      '--set',
      'state.existingClaim=my-empty-pvc',
      '--set-json',
      `mock=${JSON.stringify({ namespace: { metadata: { name: 'kube-system' } }, claim: { metadata: { name: 'my-empty-pvc' } } })}`,
    ]);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain(message);
    expect(out.stderr).not.toContain('a passphrase this chart cannot see');
    expect(out.stdout).not.toContain('kind: Secret');
  }, 60000);

  test('ephemeral storage is requested and limited, and both emptyDirs are size-limited', async () => {
    const pod = operatorDeployment(await template()).spec.template.spec;
    expect(pod.containers[0].resources.requests['ephemeral-storage']).toBe('1Gi');
    expect(pod.containers[0].resources.limits['ephemeral-storage']).toBe('6Gi');
    const volumes = Object.fromEntries(
      (pod.volumes as { name: string; emptyDir?: { sizeLimit: string } }[]).map((v) => [
        v.name,
        v.emptyDir,
      ]),
    );
    expect(volumes.home).toEqual({ sizeLimit: '4Gi' });
    expect(volumes.tmp).toEqual({ sizeLimit: '1Gi' });
  }, 60000);

  test('rbac.clusterAdmin=false drops only the cluster-admin binding', async () => {
    const bindings = (await template('rbac.clusterAdmin=false')).filter(
      (d) => d.kind === 'ClusterRoleBinding',
    );
    expect(bindings.map((b) => b.roleRef.name)).toEqual(['platform-operator']);
  }, 60000);

  test('the Headlamp plugin manager is pinned: a pluginctl version and a node image by digest', async () => {
    const values = Bun.YAML.parse(read(join(chart, 'values.yaml'))) as {
      headlamp: { pluginsManager: { version: string; baseImage: string } };
    };
    expect(values.headlamp.pluginsManager.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(values.headlamp.pluginsManager.baseImage).toMatch(/^node:[^@]+@sha256:[0-9a-f]{64}$/);
    const rendered = await template(
      'headlamp.enabled=true',
      'headlamp.pluginsManager.enabled=true',
      'headlamp.pluginsManager.configContent=plugins: []',
    );
    const headlamp = JSON.stringify(find(rendered, 'Deployment', 'platform-operator-headlamp'));
    expect(headlamp).toContain(values.headlamp.pluginsManager.baseImage);
    expect(headlamp).toContain(`@headlamp-k8s/pluginctl@${values.headlamp.pluginsManager.version}`);
  }, 60000);

  test('with Headlamp on, Headlamp watches for the plugin the sidecar writes later (#451)', async () => {
    const rendered = await template('headlamp.enabled=true');
    const deployment = find(rendered, 'Deployment', 'platform-operator-headlamp');
    const container = deployment.spec.template.spec.containers.find(
      (c: { name: string }) => c.name === 'headlamp',
    );
    expect(container.args).toContain('-watch-plugins-changes');
  }, 60000);

  test('with Headlamp on, the plugin manager installs the plugin from Artifact Hub (#435)', async () => {
    const rendered = await template('headlamp.enabled=true');
    const config = find(rendered, 'ConfigMap', 'platform-operator-headlamp-plugin-config');
    expect(Bun.YAML.parse(config.data['plugin.yml'])).toEqual({
      plugins: [
        {
          name: 'di-framework-platform',
          source:
            'https://artifacthub.io/packages/headlamp/di-framework-platform/di-framework-platform',
          version: JSON.parse(read(join(operator, 'headlamp-plugin', 'package.json'))).version,
        },
      ],
    });
    const headlamp = JSON.stringify(find(rendered, 'Deployment', 'platform-operator-headlamp'));
    expect(headlamp).toContain('pluginctl@0.1.1 install --config /config/plugin.yml');
    expect(headlamp).toContain('platform-operator-headlamp-plugin-config');
  }, 60000);

  test('the CRD, the state claim and the passphrase Secret survive helm uninstall', async () => {
    const rendered = await template();
    for (const kind of ['CustomResourceDefinition', 'PersistentVolumeClaim']) {
      expect(find(rendered, kind).metadata.annotations).toMatchObject(KEEP);
    }
    for (const doc of rendered.filter(
      (d) => !['CustomResourceDefinition', 'PersistentVolumeClaim'].includes(d.kind),
    )) {
      expect(doc.metadata.annotations?.['helm.sh/resource-policy']).toBeUndefined();
    }
    // The generated Secret renders only against a cluster, which helm template never reaches, so
    // its template is checked as text: kept on uninstall, reused through lookup when it exists,
    // and generated only otherwise, after the offline-render guard.
    const source = read(join(chart, 'templates', 'passphrase.yaml'));
    expect(source).toContain('    helm.sh/resource-policy: keep');
    const lines = source.split('\n');
    const at = (line: string) => {
      expect(lines.filter((l) => l === line)).toHaveLength(1);
      return lines.indexOf(line);
    };
    const guard = at(`{{- if not (${LOOKUPS.namespace}) }}`);
    const reuse = at('{{- if and $existing $existing.data (hasKey $existing.data "passphrase") }}');
    const take = at('{{- $passphrase = index $existing.data "passphrase" }}');
    const generate = at('{{- $passphrase = randAlphaNum 48 | b64enc }}');
    expect(guard).toBeLessThan(reuse);
    expect(take).toBe(reuse + 1);
    expect(take).toBeLessThan(generate);
  }, 60000);

  test('existing claim and passphrase Secret are used instead of created', async () => {
    const rendered = await template(
      'state.existingClaim=my-state',
      'passphrase.existingSecret=my-pass',
    );
    expect(rendered.some((d) => d.kind === 'PersistentVolumeClaim' || d.kind === 'Secret')).toBe(
      false,
    );
    const volumes = operatorDeployment(rendered).spec.template.spec.volumes as {
      name: string;
      persistentVolumeClaim?: { claimName: string };
      secret?: { secretName: string };
    }[];
    expect(volumes.find((v) => v.name === 'state')?.persistentVolumeClaim?.claimName).toBe(
      'my-state',
    );
    expect(volumes.find((v) => v.name === 'passphrase')?.secret?.secretName).toBe('my-pass');
  }, 60000);

  test('make generate syncs the CRD and ClusterRole into the chart and make check diffs them', () => {
    const makefile = read(join(operator, 'Makefile'));
    expect(makefile).toMatch(/^generate:[\s\S]*?\$\(MAKE\) chart-sync$/m);
    expect(makefile).toContain('git diff --exit-code -- api config chart/templates');
  });
});
