import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const prototype = resolve(packageRoot, 'prototype');
const kube =
  process.env.DI_FRAMEWORK_KUBE ??
  resolve(packageRoot, '../../../di-framework-kube/bin/di-framework-kube');
const instance = process.env.BACKUP_KUBE_INSTANCE ?? 'backup';
const container = `kubesolo-${instance}`;
const passphrase = 'local-dev';

const ctrSha: Record<string, string> = {
  arm64: '5f2a7f451231ff35d8306f874c51606fc9da1e2db56048834a23260f68a78eef',
  amd64: '2d20037947cbb0def12b8ac0c572b212284c1832bf3c921df1e58975515d1d08',
};

function run(args: string[], cwd = packageRoot): void {
  const child = Bun.spawnSync(args, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
  if (child.exitCode !== 0) throw new Error(`${args.join(' ')} failed (${child.exitCode})`);
}

function capture(args: string[], cwd = packageRoot): string {
  const child = Bun.spawnSync(args, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const stdout = new TextDecoder().decode(child.stdout);
  if (child.exitCode !== 0) {
    throw new Error(
      `${args.join(' ')} failed (${child.exitCode}): ${new TextDecoder().decode(child.stderr)}`,
    );
  }
  return stdout.trim();
}

async function importImages(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'di-backup-images-'));
  try {
    const machine = capture(['docker', 'exec', container, 'uname', '-m']);
    const arch = machine === 'aarch64' ? 'arm64' : machine === 'x86_64' ? 'amd64' : '';
    const sha = ctrSha[arch];
    if (!sha) throw new Error(`unsupported Kubesolo architecture ${machine}`);
    const archive = join(directory, 'containerd.tar.gz');
    const response = Bun.spawnSync(
      [
        'curl',
        '-fsSL',
        '-o',
        archive,
        `https://github.com/containerd/containerd/releases/download/v2.2.0/containerd-static-2.2.0-linux-${arch}.tar.gz`,
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    );
    if (response.exitCode !== 0) throw new Error('downloading ctr failed');
    const digest = createHash('sha256')
      .update(Buffer.from(await Bun.file(archive).arrayBuffer()))
      .digest('hex');
    if (digest !== sha) throw new Error('containerd archive checksum mismatch');
    run(['tar', '-xzf', archive, '-C', directory, 'bin/ctr']);
    const remote = capture([
      'docker',
      'exec',
      container,
      'mktemp',
      '-d',
      '/tmp/di-backup-images.XXXXXX',
    ]);
    try {
      const tar = join(directory, 'images.tar');
      run(['docker', 'cp', join(directory, 'bin/ctr'), `${container}:${remote}/ctr`]);
      run([
        'docker',
        'save',
        '-o',
        tar,
        'di-framework/backup-agent:dev',
        'di-framework/backup-destination:dev',
      ]);
      run(['docker', 'cp', tar, `${container}:${remote}/images.tar`]);
      run([
        'docker',
        'exec',
        container,
        `${remote}/ctr`,
        '--address',
        '/run/containerd/containerd.sock',
        '--namespace',
        'k8s.io',
        'images',
        'import',
        '--local',
        `${remote}/images.tar`,
      ]);
    } finally {
      run(['docker', 'exec', container, 'rm', '-rf', remote]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(`Ensuring Kubesolo instance ${instance}...`);
run([kube, 'up', '--name', instance, '--http-port', '28081', '--node-port', '30081']);

console.log('Building backup images...');
const platformArch = capture(['docker', 'exec', container, 'uname', '-m']);
const dockerPlatform = platformArch === 'aarch64' ? 'linux/arm64' : 'linux/amd64';
run([
  'docker',
  'build',
  '--platform',
  dockerPlatform,
  '-t',
  'di-framework/backup-agent:dev',
  '-f',
  resolve(packageRoot, '../backup-agent/Dockerfile'),
  resolve(packageRoot, '../backup-agent'),
]);
run([
  'docker',
  'build',
  '--platform',
  dockerPlatform,
  '-t',
  'di-framework/backup-destination:dev',
  '-f',
  resolve(packageRoot, 'Dockerfile'),
  packageRoot,
]);
console.log(`Importing images into ${container}...`);
await importImages();

console.log('Building @di-framework/platform...');
run(['bun', 'run', 'build'], resolve(packageRoot, '../platform'));

const kubeconfig = capture([kube, 'kubeconfig', '--name', instance]).split('\n').at(-1) ?? '';
if (!kubeconfig.startsWith('/')) throw new Error(`kubeconfig path missing: ${kubeconfig}`);

const backend = resolve(prototype, '.pulumi');
mkdirSync(backend, { recursive: true });
const env = {
  ...process.env,
  PULUMI_BACKEND_URL: `file://${backend}`,
  PULUMI_CONFIG_PASSPHRASE: passphrase,
};
function pulumi(args: string[]): void {
  const child = Bun.spawnSync(['pulumi', ...args], {
    cwd: prototype,
    stdout: 'inherit',
    stderr: 'inherit',
    env,
  });
  if (child.exitCode !== 0) throw new Error(`pulumi ${args.join(' ')} failed (${child.exitCode})`);
}

pulumi(['stack', 'select', 'dev', '--create']);
pulumi(['config', 'set', 'kubeconfig', kubeconfig]);
pulumi(['config', 'set', 'networkPolicyEngine', 'kube-router']);
pulumi(['config', 'set', 'storageRoot', '/var/lib/kubesolo']);
pulumi(['config', 'set', '--path', 'tenants[0].name', 'alpha']);
pulumi(['install']);
console.log('Handing the wasmCloud Helm release to Pulumi...');
const removed = Bun.spawnSync(
  [
    'helm',
    'uninstall',
    'wasmcloud',
    '--namespace',
    'wasmcloud',
    '--kubeconfig',
    kubeconfig,
    '--wait',
  ],
  { stdout: 'inherit', stderr: 'pipe', env: process.env },
);
const removeError = new TextDecoder().decode(removed.stderr);
if (removed.exitCode !== 0 && !removeError.includes('not found')) {
  process.stderr.write(removeError);
  throw new Error(`helm uninstall wasmcloud failed (${removed.exitCode})`);
}
console.log('Applying the platform and backup Helm releases...');
pulumi(['up', '--yes', '--skip-preview']);

const deadline = Date.now() + 20 * 60 * 1000;
let succeeded = false;
while (Date.now() < deadline) {
  const listed = Bun.spawnSync(
    [
      'kubectl',
      '--kubeconfig',
      kubeconfig,
      '-n',
      'di-tenant-alpha',
      'get',
      'backups.platform.di-framework.dev',
      '-o',
      'json',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  if (listed.exitCode === 0) {
    const body = JSON.parse(new TextDecoder().decode(listed.stdout)) as {
      items?: { status?: { phase?: string } }[];
    };
    if (body.items?.some((item) => item.status?.phase === 'Succeeded')) {
      succeeded = true;
      break;
    }
  }
  Bun.sleepSync(15_000);
}
if (!succeeded) {
  run([
    'kubectl',
    '--kubeconfig',
    kubeconfig,
    '-n',
    'di-runtime-alpha',
    'get',
    'jobs,pods',
    '-o',
    'wide',
  ]);
  throw new Error('no Backup reached Succeeded');
}
console.log('Backup Succeeded for tenant alpha.');
