import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const version = '3.18.4';
const checksums: Record<string, string> = {
  'darwin-arm64': '041849741550b20710d7ad0956e805ebd960b483fe978864f8e7fdd03ca84ec8',
  'darwin-amd64': '860a7238285b44b5dc7b3c4dad6194316885d7015d77c34e23177e0e9554af8f',
  'linux-arm64': 'c0a45e67eef0c7416a8a8c9e9d5d2d30d70e4f4d3f7bea5de28241fffa8f3b89',
  'linux-amd64': 'f8180838c23d7c7d797b208861fecb591d9ce1690d8704ed1e4cb8e2add966c1',
};

async function helm(): Promise<string> {
  const found = Bun.which('helm');
  if (found) return found;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const key = `${os}-${arch}`;
  const expected = checksums[key];
  if (!expected) throw new Error(`no helm checksum for ${key}`);
  const dir = join(import.meta.dir, '..', '.tools');
  const binary = join(dir, 'helm');
  try {
    await stat(binary);
    return binary;
  } catch {
    await mkdir(dir, { recursive: true });
  }
  const archive = `helm-v${version}-${key}.tar.gz`;
  const response = await fetch(`https://get.helm.sh/${archive}`);
  if (!response.ok) throw new Error(`helm download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected) throw new Error(`helm checksum mismatch: ${digest}`);
  const tar = join(dir, archive);
  await Bun.write(tar, bytes);
  const extracted = Bun.spawn(['tar', '-xzf', tar, '-C', dir], { stdout: 'pipe', stderr: 'pipe' });
  if ((await extracted.exited) !== 0) throw new Error('helm extract failed');
  const nested = join(dir, `${os}-${arch}`, 'helm');
  await Bun.write(binary, await Bun.file(nested).arrayBuffer());
  await chmod(binary, 0o755);
  return binary;
}

const destinations = (out: string) =>
  out
    .split('\n---\n')
    .filter((doc) => /^kind: BackupDestination$/m.test(doc))
    .join('\n---\n');

/** Renders with `schedule: 0 2 * * *` (required since #250) unless a test overrides it; null omits a value. */
async function template(
  namespace: string,
  values: Record<string, string | null>,
  typed: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [
    await helm(),
    'template',
    'backups',
    join(import.meta.dir, '..', 'chart'),
    '--namespace',
    namespace,
    '--include-crds',
  ];
  for (const [key, value] of Object.entries({ schedule: '0 2 * * *', ...values })) {
    if (value !== null) args.push('--set-string', `${key}=${value.replaceAll(',', '\\,')}`);
  }
  for (const [key, value] of Object.entries(typed)) args.push('--set', `${key}=${value}`);
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const code = await child.exited;
  return {
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

describe('backup-destination chart', () => {
  test('renders into an existing tenant namespace and refuses to invent one', async () => {
    const rendered = await template('di-tenant-alpha', {
      bucket: 'tenant-alpha-backups',
      existingSecret: 'di-backup-s3',
      endpoint: 'http://rustfs.wasmcloud.svc.cluster.local:9000',
    });
    expect(rendered.code).toBe(0);
    expect(rendered.stdout).toContain('kind: Deployment');
    expect(rendered.stdout).toContain('kind: Service');
    expect(rendered.stdout).toContain('kind: BackupDestination');
    expect(rendered.stdout).toContain('kind: CustomResourceDefinition');
    expect(rendered.stdout).toContain('namespace: di-runtime-alpha');
    expect(rendered.stdout).toContain('di-backup-agent-network');
    expect(rendered.stdout).not.toContain('kind: Namespace');
    expect(rendered.stdout).not.toContain('kind: Secret');
    expect(rendered.stdout).not.toContain('kind: ClusterRole');
    const demo = await template('di-tenant-alpha', {
      bucket: 'tenant-alpha-backups',
      accessKeyId: 'demo-key',
      secretAccessKey: 'demo-secret',
    });
    expect(demo.stdout).toContain('kind: Secret');
    expect(demo.stdout).toContain('di-backup-s3');
    const wrong = await template('wasmcloud', {
      bucket: 'tenant-alpha-backups',
      existingSecret: 'di-backup-s3',
    });
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain('wasmCloud tenant namespace');
    const missing = await template('di-tenant-alpha', {});
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('bucket is required');
  }, 30000);

  test('every string field with a CEL rule declares maxLength (the API server cost budget)', async () => {
    const text = await Bun.file(`${import.meta.dir}/../chart/crds/backups.yaml`).text();
    const offenders: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      if (
        schema.type === 'string' &&
        Array.isArray(schema['x-kubernetes-validations']) &&
        typeof schema.maxLength !== 'number'
      )
        offenders.push(path);
      for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`);
    };
    for (const doc of text.split(/^---$/m)) walk(Bun.YAML.parse(doc), 'crd');
    expect(offenders).toEqual([]);
  });

  test('prefix rejects only . and .. segments, so a leading slash stays valid', async () => {
    const text = await Bun.file(`${import.meta.dir}/../chart/crds/backups.yaml`).text();
    expect(text).toContain("!self.split('/').exists(p, p == '..' || p == '.')");
    expect(text).not.toContain("!self.startsWith('/')");
  });

  test('schedule is required for s3, pvc, and both, with no default (#250)', async () => {
    const kinds: Record<string, Record<string, string>> = {
      s3: { bucket: 'b', existingSecret: 's' },
      pvc: { type: 'pvc', 'volumeClaimTemplate.size': '1Gi' },
      both: { type: 'both', bucket: 'b', existingSecret: 's', 'volumeClaimTemplate.size': '1Gi' },
    };
    for (const values of Object.values(kinds)) {
      for (const schedule of [null, '', '  ']) {
        const missing = await template('di-tenant-alpha', { ...values, schedule });
        expect(missing.code).not.toBe(0);
        expect(missing.stderr).toContain('schedule is required');
        expect(missing.stderr).toContain('"none" for on-demand backups only');
      }
      const bad = await template('di-tenant-alpha', { ...values, schedule: 'nightly' });
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('schedule "nightly" must be a five-field UTC cron');
      const short = await template('di-tenant-alpha', { ...values, schedule: '0 2 * *' });
      expect(short.code).not.toBe(0);
      const none = await template('di-tenant-alpha', { ...values, schedule: 'none' });
      expect(none.code).toBe(0);
      expect(destinations(none.stdout)).toContain('kind: BackupDestination');
      expect(destinations(none.stdout)).not.toContain('schedule:');
    }
    const values = await Bun.file(`${import.meta.dir}/../chart/values.yaml`).text();
    expect(values).toMatch(/^schedule: ""$/m);
  });

  test('schedule rejects crons the operator can never fire, and accepts valid ones', async () => {
    const base = { bucket: 'b', existingSecret: 's' };
    for (const schedule of [
      '60 * * * *',
      '*/0 * * * *',
      '5- * * * *',
      '- - - - -',
      '* 24 * * *',
      '* * 0 * *',
      '* * 32 * *',
      '* * * 13 *',
      '* * * * 8',
      '1,,2 * * * *',
      '*-5 * * * *',
      '0  2 * * *',
      '0 2 * * * *',
    ]) {
      const result = await template('di-tenant-alpha', { ...base, schedule });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('must be a five-field UTC cron');
    }
    for (const schedule of [
      '0 2 * * *',
      '*/15 0-2 1,15 1-6 1-5',
      '30 3 * * 7',
      '0 0 29 2 *',
      '59 23 31 12 0-7/7',
      'none',
    ]) {
      const result = await template('di-tenant-alpha', { ...base, schedule });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    }
  });

  test('an explicit cron is written to every rendered destination', async () => {
    const s3 = await template('di-tenant-alpha', { bucket: 'b', existingSecret: 's' });
    expect(destinations(s3.stdout).match(/schedule: "0 2 \* \* \*"/g)?.length).toBe(1);
    const pvc = await template('di-tenant-alpha', {
      type: 'pvc',
      'volumeClaimTemplate.size': '1Gi',
      schedule: '30 3 * * 0',
    });
    expect(destinations(pvc.stdout)).toContain('schedule: "30 3 * * 0"');
    const both = await template('di-tenant-alpha', {
      type: 'both',
      bucket: 'b',
      existingSecret: 's',
      'volumeClaimTemplate.size': '1Gi',
      schedule: '*/15 1-5 * * 1-3',
    });
    expect(both.code).toBe(0);
    expect(destinations(both.stdout).match(/schedule: "\*\/15 1-5 \* \* 1-3"/g)?.length).toBe(2);
  });

  test('schedules are written trimmed and held to the CRD maxLength (#254 S1, S2)', async () => {
    const base = { bucket: 'b', existingSecret: 's', 'sources[0].workloadName': 'identity' };
    const padded = await template('di-tenant-alpha', {
      ...base,
      schedule: '  0 2 * * *  ',
      'sources[0].schedule': ' 30 3 * * * ',
    });
    expect(padded.stderr).toBe('');
    expect(padded.code).toBe(0);
    const written = destinations(padded.stdout);
    expect(written).toContain('schedule: "0 2 * * *"\n');
    expect(written).toContain('- kind: workload-volume\n      schedule: 30 3 * * *\n');
    const paddedNone = await template('di-tenant-alpha', {
      ...base,
      'sources[0].schedule': ' none ',
    });
    expect(destinations(paddedNone.stdout)).toContain('      schedule: none\n');
    // Every value the chart writes matches the CRD pattern, so `kubectl apply` cannot refuse it.
    const crd = await Bun.file(`${import.meta.dir}/../chart/crds/backups.yaml`).text();
    const pattern = new RegExp(/pattern: '(\^\(none\|[^']+)'/.exec(crd)?.[1] ?? '$^');
    for (const value of written.matchAll(/schedule: "?([^"\n]+)"?\n/g)) {
      expect(pattern.test(value[1] ?? '')).toBe(true);
    }
    // 128 characters is the CRD limit, for the destination and every source.
    const longest = `10${',0'.repeat(59)} * * * *`;
    const tooLong = `0${',0'.repeat(60)} * * * *`;
    expect([longest.length, tooLong.length]).toEqual([128, 129]);
    const fits = await template('di-tenant-alpha', {
      ...base,
      schedule: longest,
      'sources[0].schedule': ` ${longest} `,
    });
    expect(fits.stderr).toBe('');
    expect(fits.code).toBe(0);
    const destinationLong = await template('di-tenant-alpha', {
      ...base,
      schedule: tooLong,
      'sources[0].schedule': 'none',
    });
    expect(destinationLong.code).not.toBe(0);
    expect(destinationLong.stderr).toContain(
      'schedule must be at most 128 characters (it has 129)',
    );
    const sourceLong = await template('di-tenant-alpha', {
      ...base,
      'sources[0].schedule': tooLong,
    });
    expect(sourceLong.code).not.toBe(0);
    expect(sourceLong.stderr).toContain(
      'source identity: schedule must be at most 128 characters (it has 129)',
    );
  }, 30000);

  test('the CRD describes schedule without a default', async () => {
    const text = await Bun.file(`${import.meta.dir}/../chart/crds/backups.yaml`).text();
    expect(text).toContain('There is no default');
    expect(text).toContain('NoSchedule');
  });

  test('renders a PVC destination, both destinations, and refuses an incomplete one', async () => {
    const created = await template('di-tenant-alpha', {
      type: 'pvc',
      'volumeClaimTemplate.size': '20Gi',
      'volumeClaimTemplate.storageClassName': 'local-path',
    });
    expect(created.code).toBe(0);
    const claim = created.stdout
      .split('\n---\n')
      .find((doc) => doc.includes('kind: PersistentVolumeClaim'));
    expect(claim).toContain('name: di-backup-pvc');
    expect(claim).toContain('namespace: di-runtime-alpha');
    expect(claim).toContain('helm.sh/resource-policy: keep');
    expect(claim).toContain('storageClassName: "local-path"');
    expect(claim).toContain('storage: "20Gi"');
    const [only, ...others] = created.stdout
      .split('\n---\n')
      .filter((doc) => doc.includes('v1alpha1\nkind: BackupDestination\n'));
    expect(others).toEqual([]);
    expect(only).toContain('type: pvc');
    expect(only).toContain('name: pvc');
    expect(only).not.toContain('name: default');
    expect(only).not.toContain('bucket:');
    expect(only).not.toContain('credentialsSecretRef');
    expect(created.stdout).not.toContain('kind: Secret');

    const existing = await template('di-tenant-alpha', { type: 'pvc', existingClaimName: 'mine' });
    expect(existing.code).toBe(0);
    expect(existing.stdout).toContain('existingClaimName: "mine"');
    expect(existing.stdout).not.toContain('kind: PersistentVolumeClaim');

    const both = await template('di-tenant-alpha', {
      type: 'both',
      bucket: 'tenant-alpha-backups',
      existingSecret: 'di-backup-s3',
      'volumeClaimTemplate.size': '5Gi',
    });
    expect(both.code).toBe(0);
    const destinations = both.stdout
      .split('\n---\n')
      .filter((doc) => doc.includes('v1alpha1\nkind: BackupDestination\n'));
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).toContain('name: default');
    expect(destinations[0]).toContain('type: s3');
    expect(destinations[1]).toContain('name: pvc');
    expect(destinations[1]).toContain('type: pvc');

    const incomplete = await template('di-tenant-alpha', { type: 'pvc' });
    expect(incomplete.code).not.toBe(0);
    expect(incomplete.stderr).toContain('existingClaimName or volumeClaimTemplate.size');
    const unknown = await template('di-tenant-alpha', { type: 'nfs' });
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('type must be s3, pvc, or both');
  }, 30000);

  test('grants the operator only namespaced workload access and passes the storage root', async () => {
    const rendered = await template('di-tenant-alpha', {
      bucket: 'b',
      existingSecret: 's',
      storageRoot: '/var/lib/k0s',
    });
    expect(rendered.code).toBe(0);
    expect(rendered.stdout).not.toContain('kind: ClusterRole');
    const roles = rendered.stdout.split('\n---\n').filter((doc) => doc.includes('kind: Role\n'));
    const tenant = roles.find((doc) => doc.includes('namespace: di-tenant-alpha')) ?? '';
    const runtime = roles.find((doc) => doc.includes('namespace: di-runtime-alpha')) ?? '';
    expect(tenant).toContain(
      'resources: ["workloaddeployments", "workloadreplicasets", "workloads"]\n    verbs: ["get", "list"]',
    );
    expect(tenant).toContain(
      'resources: ["workloaddeployments/scale"]\n    verbs: ["get", "patch"]',
    );
    expect(tenant).not.toMatch(
      /workloaddeployments"[^\n]*\n\s*verbs: \[[^\]]*"(patch|update|create|delete)"/,
    );
    expect(runtime).toContain(
      'resources: ["deployments"]\n    resourceNames: ["hostgroup-tenant-alpha"]\n    verbs: ["get"]',
    );
    expect(rendered.stdout).toContain('- name: STORAGE_ROOT\n              value: "/var/lib/k0s"');
    // Unset: the operator takes the root from the host pods' mount.
    const discovered = await template('di-tenant-alpha', { bucket: 'b', existingSecret: 's' });
    expect(discovered.stdout).toContain('- name: STORAGE_ROOT\n              value: ""');
    // The Secret get is limited to the one Secret the chart's destination names.
    expect(tenant).toContain(
      'resources: ["secrets"]\n    resourceNames: ["s"]\n    verbs: ["get"]',
    );
    expect(tenant).not.toMatch(/resources: \["secrets"\]\n\s*verbs/);
    const created = await template('di-tenant-alpha', {
      bucket: 'b',
      accessKeyId: 'a',
      secretAccessKey: 'k',
    });
    expect(created.stdout).toContain('resourceNames: ["di-backup-s3"]');
    const pvcOnly = await template('di-tenant-alpha', {
      type: 'pvc',
      existingClaimName: 'c',
    });
    const pvcTenant = pvcOnly.stdout
      .split('\n---\n')
      .find((doc) => doc.includes('kind: Role\n') && doc.includes('namespace: di-tenant-alpha'));
    expect(pvcTenant).toBeDefined();
    expect(pvcTenant).not.toContain('resources: ["secrets"]');
    // The ledger and the Lease, each limited to its one object where the verb allows it. The
    // ledger is in the runtime namespace (W6): tenant users can edit ConfigMaps in their own.
    expect(runtime).toContain(
      'resources: ["configmaps"]\n    resourceNames: ["di-backup-held-replicas"]\n    verbs: ["get", "patch"]',
    );
    expect(runtime).toContain('resources: ["configmaps"]\n    verbs: ["create"]');
    expect(tenant).not.toContain('configmaps');
    // Ledger Events (#254) are created where the ledger is, and nowhere else.
    expect(runtime).toContain('resources: ["events"]\n    verbs: ["create"]');
    expect(tenant).not.toContain('events');
    expect(rendered.stdout.match(/resources: \["events"\]/g)?.length).toBe(1);
    expect(tenant).toContain(
      'resources: ["leases"]\n    resourceNames: ["di-backup-operator"]\n    verbs: ["get", "patch"]',
    );
    expect(runtime).not.toMatch(/resources: \["configmaps"\]\n\s*verbs: \[[^\]]*"list"/);
    // Never two operator pods at once.
    expect(rendered.stdout).toContain('strategy:\n    type: Recreate');
    expect(rendered.stdout).toContain(
      '- name: POD_NAME\n              valueFrom:\n                fieldRef:\n                  fieldPath: metadata.name',
    );
  }, 30000);

  test('the CRDs validate schedules, names, and request shapes', async () => {
    const crds = await Bun.file(
      join(import.meta.dir, '..', 'chart', 'crds', 'backups.yaml'),
    ).text();
    const patterns = [
      ...crds.matchAll(/schedule:\n\s+type: string\n\s+maxLength: 128\n\s+pattern: '([^']+)'/g),
    ].map((match) => new RegExp(match[1] ?? ''));
    // The destination schedule and the workload-volume source schedule (#232).
    expect(patterns).toHaveLength(2);
    for (const pattern of patterns) {
      for (const valid of [
        '0 2 * * *',
        '*/15 0-2 1,15 1-6 1-5',
        '30 3 * * 7',
        '0 0 1 1/3 *',
        'none',
      ]) {
        expect(pattern.test(valid)).toBe(true);
      }
      for (const invalid of [
        'a b c d e',
        '0 2 * *',
        '0 2 * * * *',
        '0  2 * * *',
        'x/5 * * * *',
        // "none" is a whole value: the alternation stays inside the anchors (#250).
        'nonesuch',
        'none 0 2 * * *',
        'xnone',
        'none ',
        ' none',
        'NONE',
        'nonesuch 0 2 * * *',
      ]) {
        expect(pattern.test(invalid)).toBe(false);
      }
    }
    const secret =
      /name:\n\s+type: string\n\s+minLength: 1\n\s+maxLength: 253\n\s+pattern: '([^']+)'/.exec(
        crds,
      );
    const subdomain = new RegExp(secret?.[1] ?? '^$');
    expect(subdomain.test('di-backup-s3')).toBe(true);
    expect(subdomain.test('a.b-c')).toBe(true);
    expect(subdomain.test('../x')).toBe(false);
    expect(subdomain.test('x/y')).toBe(false);
    expect(crds).toContain('rule: "self.type != \'workload-volume\' || has(self.source)"');
    expect(crds).toContain("rule: '!has(self.expectedKcv) || has(self.targetWorkloadName)'");
    expect(crds).toMatch(
      /source:\n(.*\n){4}\s+workloadName:\n\s+type: string\n\s+maxLength: 63\n\s+pattern: '\^\[a-z0-9\]/,
    );
    expect(crds).toContain('startTimeoutSeconds: { type: integer, minimum: 30, maximum: 1800 }');
    // Status fields the operator writes must be in the schema, or the API server prunes them.
    for (const field of [
      'placingStartedAt',
      'probeJob',
      'copyJob',
      'abortedJob',
      'outcome',
      'restoringPath',
    ]) {
      expect(crds.split(`${field}:`).length - 1).toBe(2);
    }
    expect(
      crds.split("enum: ['Placing', 'ScalingDown', 'Copying', 'ScalingUp', 'Done']").length - 1,
    ).toBe(2);
    expect(crds).toContain('scheduleStatus: { type: string }');
  });

  test('renders workload-volume sources without inventing a schedule or retention', async () => {
    const sources = {
      'sources[0].workloadName': 'identity',
      'sources[0].destination': 'pvc',
      'sources[1].workloadName': 'reports',
      'sources[1].destination': 's3',
      'sources[1].schedule': 'none',
    };
    const both = await template(
      'di-tenant-alpha',
      {
        type: 'both',
        bucket: 'b',
        existingSecret: 's',
        'volumeClaimTemplate.size': '5Gi',
        ...sources,
        'sources[0].schedule': '30 3 * * *',
      },
      {
        'sources[0].retention.keepLast': '7',
        'sources[0].scaleDownTimeoutSeconds': '120',
        'sources[0].startTimeoutSeconds': '90',
      },
    );
    expect(both.code).toBe(0);
    const destinations = both.stdout
      .split('\n---\n')
      .filter((doc) => doc.includes('v1alpha1\nkind: BackupDestination\n'));
    const [s3, pvc] = destinations;
    expect(s3).toContain(
      '- kind: workload-volume\n      schedule: none\n      workloadName: reports',
    );
    expect(s3).not.toContain('identity');
    expect(s3?.slice(s3.indexOf('sources:'))).toContain('schedule: none');
    expect(s3?.slice(s3.indexOf('sources:'))).not.toMatch(/schedule: [0-9*]/);
    expect(pvc).toContain('workloadName: identity');
    expect(pvc).toContain('keepLast: 7');
    expect(pvc).toContain('scaleDownTimeoutSeconds: 120');
    expect(pvc).toContain('startTimeoutSeconds: 90');
    expect(pvc).toContain('schedule: 30 3 * * *');
    expect(pvc).not.toContain('reports');
    expect(both.stdout).not.toContain('destination: pvc');

    const single = await template('di-tenant-alpha', {
      bucket: 'b',
      existingSecret: 's',
      'sources[0].workloadName': 'identity',
      'sources[0].schedule': 'none',
    });
    expect(single.code).toBe(0);
    expect(single.stdout).toContain('workloadName: identity');
    const none = await template('di-tenant-alpha', { bucket: 'b', existingSecret: 's' });
    const noneDestination = none.stdout
      .split('\n---\n')
      .find((doc) => doc.includes('v1alpha1\nkind: BackupDestination\n'));
    expect(noneDestination).not.toContain('sources:');

    const refusals: [Record<string, string>, string][] = [
      [
        {
          type: 'both',
          'volumeClaimTemplate.size': '1Gi',
          'sources[0].workloadName': 'x',
          'sources[0].schedule': 'none',
        },
        'needs destination s3 or pvc',
      ],
      [
        {
          'sources[0].workloadName': 'x',
          'sources[0].schedule': 'none',
          'sources[0].destination': 'nfs',
        },
        'destination must be s3 or pvc',
      ],
      [
        {
          'sources[0].workloadName': 'x',
          'sources[0].schedule': 'none',
          'sources[0].destination': 'pvc',
        },
        'is not rendered with type s3',
      ],
      // No default source schedule either (#250).
      [{ 'sources[0].workloadName': 'x' }, 'source x: schedule is required'],
      [
        { 'sources[0].workloadName': 'x', 'sources[0].schedule': '  ' },
        'source x: schedule is required',
      ],
      [
        { 'sources[0].workloadName': 'x', 'sources[0].schedule': 'nonesuch' },
        'source x: schedule "nonesuch" must be a five-field UTC cron',
      ],
      [
        { 'sources[0].workloadName': 'x', 'sources[0].schedule': '99 * * * *' },
        'must be a five-field UTC cron',
      ],
      [{ 'sources[0].schedule': '* * * * *' }, 'every source needs a workloadName'],
    ];
    for (const [values, message] of refusals) {
      const refused = await template('di-tenant-alpha', {
        bucket: 'b',
        existingSecret: 's',
        ...values,
      });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(message);
    }
  }, 30000);
});
