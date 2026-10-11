// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the assertions match literal GitHub Actions `${{ }}` and shell `${VAR}` text.
/**
 * The four GHCR publish workflows publish by themselves when their inputs change on main (#172):
 * triggers and paths, the skip-if-published gate, least-privilege permissions, and the pin job.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARTIFACTS } from '../scripts/pin-artifact';
import { matchesPathFilter, pushPaths } from '../scripts/source-check';

const repo = resolve(import.meta.dir, '..');

type Permissions = Record<string, string>;
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Permissions;
  outputs?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: {
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  }[];
}
interface Workflow {
  on: Record<string, unknown> & {
    push?: { branches?: string[]; paths?: string[] };
    workflow_dispatch?: unknown;
  };
  permissions: Permissions;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

function read(path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}
function parse(path: string): Workflow {
  return Bun.YAML.parse(read(path)) as Workflow;
}

const CHECKED =
  "${{ !cancelled() && needs.check-source.result == 'success' && needs.check-source.outputs.skip != 'true' }}";

interface Spec {
  file: string;
  image: string;
  paths: string[];
  /** The job that check-source gates. */
  first: string;
  firstIf: string;
  /** Jobs that push to GHCR (packages: write). */
  publish: string[];
  /** Jobs that compile but must hold no write scope. */
  readOnly: string[];
  /** The job the pin job waits for and takes the digest from. */
  pinAfter: string;
  artifacts: string[];
}

const SPECS: Spec[] = [
  {
    file: '.github/workflows/tenant-host-image.yml',
    image: 'ghcr.io/di-framework/wash',
    paths: ['platform/tenant-host/**', '.github/workflows/tenant-host-image.yml', '!**/*.md'],
    first: 'build',
    firstIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && needs.check-source.outputs.variants != '[]' }}",
    publish: ['build', 'merge'],
    readOnly: [],
    pinAfter: 'merge',
    artifacts: ['wash-wasi-tls', 'wash-wasi-tls-exclusive'],
  },
  {
    file: '.github/workflows/tenant-auth-image.yml',
    image: 'ghcr.io/di-framework/tenant-auth',
    paths: [
      'platform/tenant-auth/**',
      'platform/tenant-cli/**',
      'platform/oci-registry/**',
      'platform/wasm-component-publisher/**',
      'platform/pglite-component/build-support/**',
      'platform/sqlite-component/scripts/**',
      'platform/platform/src/tenancy/**',
      'package.json',
      'bun.lock',
      'Cargo.toml',
      'Cargo.lock',
      '.cargo/**',
      '.github/actions/setup-tenant-auth-builder/**',
      '.github/workflows/tenant-auth-image.yml',
      '!**/*.md',
    ],
    first: 'publish-platform',
    firstIf: CHECKED,
    publish: ['publish-platform', 'publish-index'],
    readOnly: [],
    pinAfter: 'publish-index',
    artifacts: ['tenant-auth'],
  },
  {
    file: '.github/workflows/pglite-component-publish.yml',
    image: 'ghcr.io/di-framework/pglite-component',
    paths: [
      'platform/pglite-component/src/**',
      'platform/pglite-component/wit/**',
      'platform/pglite-component/engine/**',
      'platform/pglite-component/build-support/**',
      'platform/pglite-component/scripts/**',
      'platform/pglite-component/Makefile',
      'platform/pglite-component/build.rs',
      'platform/pglite-component/Cargo.toml',
      'platform/pglite-component/Cargo.lock',
      'platform/pglite-component/rust-toolchain.toml',
      'platform/wasm-component-publisher/**',
      'Cargo.toml',
      'Cargo.lock',
      '.cargo/**',
      '.github/workflows/pglite-component-publish.yml',
      '!**/*.md',
    ],
    first: 'build',
    firstIf: CHECKED,
    publish: ['publish'],
    readOnly: ['build'],
    pinAfter: 'publish',
    artifacts: ['pglite-component'],
  },
  {
    file: '.github/workflows/oci-registry-component.yml',
    image: 'ghcr.io/di-framework/oci-registry',
    paths: [
      'platform/oci-registry/**',
      'platform/wasm-component-publisher/**',
      'platform/sqlite-component/scripts/**',
      'package.json',
      'bun.lock',
      'Cargo.toml',
      'Cargo.lock',
      '.cargo/**',
      '.github/actions/setup-tenant-auth-builder/**',
      '.github/workflows/oci-registry-component.yml',
      '!**/*.md',
    ],
    first: 'publish',
    firstIf: CHECKED,
    publish: ['publish'],
    readOnly: [],
    pinAfter: 'publish',
    artifacts: ['oci-registry'],
  },
];

function needsOf(job: Job): string[] {
  return job.needs === undefined ? [] : [job.needs].flat();
}
function hasWrite(permissions: Permissions | undefined): boolean {
  return Object.values(permissions ?? {}).includes('write');
}

describe.each(SPECS)('$file', (spec) => {
  const text = read(spec.file);
  const workflow = parse(spec.file);
  const jobs = workflow.jobs;

  test('triggers on push to main with exactly its input paths, and on workflow_dispatch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(workflow.on.push?.paths).toEqual(spec.paths);
    expect(pushPaths(text)).toEqual(spec.paths);
    // The workflow file itself is an input; Markdown never is, so pin PRs cannot loop.
    expect(matchesPathFilter(spec.paths, spec.file)).toBe(true);
    expect(matchesPathFilter(spec.paths, 'platform/tenant-host/README.md')).toBe(false);
  });

  test('check-source runs on main, reads packages only, and hashes this workflow’s filter', () => {
    const check = jobs['check-source'];
    expect(check).toBeDefined();
    expect(check?.if).toBe("github.ref == 'refs/heads/main'");
    expect(check?.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(check?.steps?.map((s) => s.uses)).toContain('./.github/actions/setup-source-check');
    const run = check?.steps?.map((s) => s.run ?? '').join('\n') ?? '';
    expect(run).toContain(`bun scripts/source-check.ts --workflow ${spec.file}`);
    expect(run).toContain(`--image ${spec.image}`);
  });

  test('workflow_dispatch always builds: the check is forced, never skipped', () => {
    const check = jobs['check-source'];
    const steps = check?.steps ?? [];
    const forced = steps.some(
      (s) =>
        s.env?.FORCE === "${{ github.event_name == 'workflow_dispatch' && '--force' || '' }}" ||
        /TRIGGER}" == "workflow_dispatch" \]\]; then[\s\S]*force=\(--force\)/.test(s.run ?? ''),
    );
    expect(forced).toBe(true);
    // check-source never has a trigger condition, so dispatch cannot leave it skipped.
    expect(check?.if).not.toContain('event_name');
  });

  test('the build only starts after a successful check that found no published source', () => {
    const first = jobs[spec.first];
    expect(needsOf(first ?? {})).toContain('check-source');
    expect(first?.if).toBe(spec.firstIf);
    // A skipped or failed check never lets a build through.
    for (const job of Object.values(jobs)) expect(job.if ?? '').not.toContain("'skipped'");
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'check-source' || name === spec.first) continue;
      expect(job.if, name).toMatch(/^\$\{\{ !cancelled\(\) && needs\.[\w-]+\.result == 'success'/);
    }
  });

  test('a publish tags the pushed digest with src-<hash>', () => {
    expect(text).toMatch(/src-\$\{SOURCE_HASH\}/);
    expect(text).toContain('needs.check-source.outputs');
    if (spec.image.endsWith('/wash')) {
      expect(text).toContain('--tag "ghcr.io/di-framework/wash:src-${SOURCE_HASH}"');
    } else {
      expect(text).toMatch(/oras tag "[^"]+" "src-\$\{SOURCE_HASH\}"/);
    }
  });

  test('the workflow default is contents: read and every job declares its permissions', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, job] of Object.entries(jobs)) expect(job.permissions, name).toBeDefined();
  });

  test('publish jobs hold packages: write and nothing else that writes', () => {
    for (const name of spec.publish) {
      expect(jobs[name]?.permissions, name).toEqual({ contents: 'read', packages: 'write' });
    }
  });

  test('build and check jobs hold no write permission', () => {
    for (const name of [...spec.readOnly, 'check-source']) {
      expect(jobs[name], name).toBeDefined();
      expect(hasWrite(jobs[name]?.permissions), name).toBe(false);
    }
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'pin' || spec.publish.includes(name)) continue;
      expect(hasWrite(job.permissions), name).toBe(false);
    }
  });

  test('only the pin job can push branches and open PRs, after a successful publish', () => {
    const pin = jobs.pin;
    expect(pin?.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(needsOf(pin ?? {})).toContain(spec.pinAfter);
    expect(pin?.if).toBe(
      `\${{ !cancelled() && needs.${spec.pinAfter}.result == 'success' && github.ref == 'refs/heads/main' }}`,
    );
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'pin') continue;
      expect(job.permissions?.contents, name).not.toBe('write');
      expect(job.permissions?.['pull-requests'], name).toBeUndefined();
    }
    const open = pin?.steps?.find((s) => s.uses === './.github/actions/open-pin-pr');
    expect(open?.with?.token).toBe('${{ secrets.GITHUB_TOKEN }}');
    const artifact = open?.with?.artifact ?? '';
    const names = artifact.includes('matrix.variant.name')
      ? ['wasi-tls', 'wasi-tls-exclusive'].map((v) => `wash-${v}`)
      : [artifact];
    expect(names).toEqual(spec.artifacts);
    for (const name of names) expect(ARTIFACTS[name], name).toBeDefined();
  });

  test('one non-cancelling concurrency group per artifact', () => {
    expect(workflow.concurrency.group).toMatch(/^publish-/);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  test('uses no secret but GITHUB_TOKEN and pins every action by SHA', () => {
    for (const [, name] of text.matchAll(/secrets\.(\w+)/g)) expect(name).toBe('GITHUB_TOKEN');
    for (const [, ref] of text.matchAll(/uses:\s+(\S+)/g)) {
      if (ref?.startsWith('./')) continue;
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

test('the four publish workflows use distinct concurrency groups', () => {
  const groups = SPECS.map((spec) => parse(spec.file).concurrency.group);
  expect(new Set(groups).size).toBe(SPECS.length);
});

test('the tenant host publishes both variants on push, as a native two-arch matrix', () => {
  const workflow = parse('.github/workflows/tenant-host-image.yml');
  const run = workflow.jobs['check-source']?.steps?.map((s) => s.run ?? '').join('\n') ?? '';
  expect(run).toContain('candidates=(wasi-tls wasi-tls-exclusive)');
  expect(run).toContain('--salt "${name}"');
  const matrix = workflow.jobs.build?.strategy?.matrix;
  expect(matrix?.arch).toEqual(['amd64', 'arm64']);
  expect(matrix?.include).toEqual([
    { arch: 'amd64', platform: 'linux/amd64', runner: 'ubuntu-24.04' },
    { arch: 'arm64', platform: 'linux/arm64', runner: 'ubuntu-24.04-arm' },
  ]);
});

test('publish paths reuse the paths the image checks already maintain', () => {
  const check = Bun.YAML.parse(read('.github/workflows/tenant-auth-image-check.yml')) as Workflow;
  const checkPaths = (check.on.pull_request as { paths: string[] }).paths.filter(
    (p) => !p.startsWith('.github/workflows/'),
  );
  const publish = pushPaths(read('.github/workflows/tenant-auth-image.yml'));
  expect(publish.filter((p) => !p.startsWith('.github/workflows/') && !p.startsWith('!'))).toEqual(
    checkPaths,
  );
  const hostCheck = parse('.github/workflows/tenant-host-patch-check.yml');
  expect(hostCheck.on.push?.paths?.[0]).toBe('platform/tenant-host/**');
  expect(pushPaths(read('.github/workflows/tenant-host-image.yml'))[0]).toBe(
    'platform/tenant-host/**',
  );
});

test('no pin target is an input of any publish workflow, so merging a pin PR publishes nothing', () => {
  const files = new Set(Object.values(ARTIFACTS).flatMap((targets) => targets.map((t) => t.file)));
  for (const spec of SPECS) {
    for (const file of files) expect(matchesPathFilter(spec.paths, file), file).toBe(false);
  }
  expect(files.has('platform/platform/src/index.ts')).toBe(false);
});

describe('composite actions', () => {
  const open = read('.github/actions/open-pin-pr/action.yml');
  const setup = read('.github/actions/setup-source-check/action.yml');

  test('the pin PR is bot/pin-<artifact>, titled with the digest, and says CI needs a maintainer', () => {
    expect(open).toContain('branch="bot/pin-${ARTIFACT}"');
    expect(open).toContain('title="chore: pin ${ARTIFACT} to ${DIGEST}"');
    expect(open).toContain('bun scripts/pin-artifact.ts "${ARTIFACT}" "${DIGEST}"');
    expect(open).toContain('A maintainer has to approve and run this PR');
    expect(open).toContain('GitHub does not trigger workflows for pull requests');
    expect(open).toContain('gh pr edit');
    expect(open).toContain('gh pr create --base main');
  });

  test('pin actions by SHA and use no stored secret', () => {
    for (const text of [open, setup]) {
      expect(text).not.toContain('secrets.');
      for (const [, ref] of text.matchAll(/uses:\s+(\S+)/g)) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

test('the tenant host resolves variant patches in one place and hashes every patch file', () => {
  const text = read('.github/workflows/tenant-host-image.yml');
  // Only check-source maps a variant to its patches; build and merge read the matrix entry.
  expect(text.match(/case "\$\{name\}" in/g)).toHaveLength(1);
  expect(text.match(/\.patch'/g)?.length).toBeGreaterThan(0);
  for (const job of ['build', 'merge']) {
    const steps = parse('.github/workflows/tenant-host-image.yml').jobs[job]?.steps ?? [];
    for (const step of steps) expect(step.run ?? '', job).not.toContain('case ');
  }
  const filter = pushPaths(text);
  for (const file of Bun.spawnSync(['git', 'ls-files', 'platform/tenant-host'], { cwd: repo })
    .stdout.toString()
    .trim()
    .split('\n')) {
    expect(matchesPathFilter(filter, file), file).toBe(!file.endsWith('.md'));
  }
  expect(
    matchesPathFilter(filter, 'platform/tenant-host/0002-insecure-registry-allowlist.patch'),
  ).toBe(true);
});
