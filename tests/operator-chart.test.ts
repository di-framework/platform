/**
 * The platform operator's Helm chart (#272): it renders, carries the generated CRD and ClusterRole
 * unchanged (plus the keep annotation on the CRD), passes the operator flags main.go defines, pulls
 * the image by digest, and keeps the CRD, the state claim and the passphrase on `helm uninstall`.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { helm } from '../platform/backup-destination/tests/support/helm.ts';

const operator = resolve(import.meta.dir, '..', 'platform', 'operator');
const chart = join(operator, 'chart');
const CRD = join(operator, 'config', 'crd', 'platform.di-framework.dev_platforminstances.yaml');
const ROLE = join(operator, 'config', 'rbac', 'role.yaml');
/** sha256 of headlamp-0.46.0.tgz: the `digest` of that release in the upstream index.yaml. */
const HEADLAMP_SHA256 = 'faa471a8c5c55125b3dceed1cf73000e1ced18f07e2088e5e12e75292fb9ae62';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const KEEP = { 'helm.sh/resource-policy': 'keep' };

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

async function template(...set: string[]): Promise<Doc[]> {
  const args = ['template', 'platform-operator', chart, '--namespace', 'platform-operator'];
  for (const value of set) args.push('--set', value);
  const out = await run(args);
  if (out.code !== 0) throw new Error(`helm template failed: ${out.stderr}`);
  return docs(out.stdout);
}

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
      'Secret',
      'ServiceAccount',
    ]);
    expect(JSON.stringify(rendered)).not.toContain('headlamp');
  }, 60000);

  test('headlamp.enabled=true adds the vendored Headlamp chart', async () => {
    const rendered = await template('headlamp.enabled=true');
    const headlamp = find(rendered, 'Deployment', 'platform-operator-headlamp');
    expect(JSON.stringify(headlamp)).toContain('ghcr.io/headlamp-k8s/headlamp:v0.46.0');
    expect(operatorDeployment(rendered)).toBeDefined();
    // The plugin manager stub stays off until the plugin (#273) is published.
    expect(JSON.stringify(headlamp)).not.toContain('headlamp-plugin');
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
    // npm keeps its image default; everything else is set from values.
    expect(names.sort()).toEqual(defined.filter((f) => f !== 'npm').sort());
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
      await template('storageRootBase=/srv/instances', 'installTimeout=1h', 'leaderElect=false'),
    ).spec.template.spec.containers[0].args as string[];
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

  test('the image is pulled by digest; the default is a placeholder pin-artifact can rewrite', async () => {
    const values = Bun.YAML.parse(read(join(chart, 'values.yaml'))) as {
      image: { repository: string; digest: string };
    };
    expect(values.image.repository).toBe('ghcr.io/di-framework/platform-operator');
    // pin-artifact.ts's placeholder form: sha256:<...>.
    expect(values.image.digest).toMatch(/^sha256:<[^>\n]*>$/);
    const pinned = operatorDeployment(await template(`image.digest=${DIGEST}`));
    expect(pinned.spec.template.spec.containers[0].image).toBe(
      `ghcr.io/di-framework/platform-operator@${DIGEST}`,
    );
    const tagged = await run([
      'template',
      'platform-operator',
      chart,
      '--set',
      'image.digest=latest',
    ]);
    expect(tagged.code).not.toBe(0);
    expect(tagged.stderr).toContain('image.digest must be a sha256 digest');
  }, 60000);

  test('the CRD, the state claim and the passphrase Secret survive helm uninstall', async () => {
    const rendered = await template();
    for (const kind of ['CustomResourceDefinition', 'PersistentVolumeClaim', 'Secret']) {
      expect(find(rendered, kind).metadata.annotations).toMatchObject(KEEP);
    }
    for (const doc of rendered.filter(
      (d) => !['CustomResourceDefinition', 'PersistentVolumeClaim', 'Secret'].includes(d.kind),
    )) {
      expect(doc.metadata.annotations?.['helm.sh/resource-policy']).toBeUndefined();
    }
    const secret = find(rendered, 'Secret');
    expect(Buffer.from(secret.data.passphrase, 'base64').toString()).toMatch(/^[A-Za-z0-9]{48}$/);
    // The passphrase is generated only when no Secret exists (lookup), never on every upgrade.
    expect(read(join(chart, 'templates', 'passphrase.yaml'))).toContain(
      'lookup "v1" "Secret" .Release.Namespace $name',
    );
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
