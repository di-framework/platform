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

async function template(
  namespace: string,
  values: Record<string, string>,
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
  for (const [key, value] of Object.entries(values)) args.push('--set-string', `${key}=${value}`);
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

  test('the CRD rejects prefixes that leave the destination', async () => {
    const crd = await Bun.file(`${import.meta.dir}/../chart/crds/backups.yaml`).text();
    expect(crd).toContain("self.split('/').exists(p, p == '..' || p == '.')");
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
});
