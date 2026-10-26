// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the assertions match literal GitHub Actions `${{ }}` and shell `${VAR}` text.
/**
 * The GHCR publish workflows publish by themselves when their inputs change on main (#172):
 * triggers and paths, the skip-if-published gate, least-privilege permissions, and the pin job.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ARTIFACTS, artifactFiles } from '../scripts/pin-artifact';
import { hashExclusions, hashPaths, matchesPathFilter, pushPaths } from '../scripts/source-check';
import { git, sandboxClone, spawnEnv, stubCommand } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const env = spawnEnv;

type Permissions = Record<string, string>;
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Permissions;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
  steps?: {
    id?: string;
    name?: string;
    if?: string;
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
  env?: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}

function read(path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}
function parse(path: string): Workflow {
  return Bun.YAML.parse(read(path)) as Workflow;
}
let tracked: string[] | undefined;
/** The files git tracks, relative to the repository root. */
function trackedFiles(): string[] {
  tracked ??= Bun.spawnSync(['git', 'ls-files'], { cwd: repo })
    .stdout.toString()
    .split('\n')
    .filter(Boolean);
  return tracked;
}

const CHECKED =
  "${{ !cancelled() && needs.check-source.result == 'success' && needs.check-source.outputs.skip != 'true' }}";

interface Spec {
  file: string;
  image: string;
  paths: string[];
  /** env.SOURCE_HASH_EXCLUDE: trigger files the source hash leaves out. */
  hashExclude?: string[];
  /** The job that check-source gates. */
  first: string;
  firstIf: string;
  /** Jobs that push to GHCR (packages: write). */
  publish: string[];
  /** Jobs that compile but must hold no write scope. */
  readOnly: string[];
  /** The job the pin job waits for and takes the digest from. */
  pinAfter: string;
  pinIf: string;
  /** The job that re-points moving tags when the source is already published (a revert). */
  realign?: { job: string; tags: string; wit?: string };
  /** bot/pin-<pinName> */
  pinName: string;
  artifacts: string[];
  /** The job that moves mutable tags, and its steps that the source guard gates. */
  guarded: { job: string; steps: string[] };
}

/** The pin job runs after `job` published, or when check-source found the source published. */
function pinIfAfter(job: string): string {
  return `\${{ !cancelled() && needs.check-source.result == 'success' && github.ref == 'refs/heads/main' && ((needs.${job}.result == 'success' && needs.${job}.outputs.digest != '') || (needs.check-source.outputs.skip == 'true' && needs.check-source.outputs.stale != 'true' && needs.check-source.outputs.digest != '')) }}`;
}

/**
 * A single-component workflow, `<name>-publish.yml`: a read-only build, then publish (or realign
 * the version tag when the source is already published), then pin.
 */
function componentSpec(name: string, inputs: string[], hashExclude?: string[]): Spec {
  const file = `.github/workflows/${name}-publish.yml`;
  return {
    file,
    image: `ghcr.io/di-framework/${name}`,
    paths: [
      ...inputs,
      'platform/wasm-component-publisher/**',
      'Cargo.toml',
      'Cargo.lock',
      '.cargo/**',
      file,
      '!**/*.md',
    ],
    hashExclude,
    first: 'build',
    firstIf: CHECKED,
    publish: ['publish', 'realign'],
    readOnly: ['build'],
    realign: { job: 'realign', tags: 'wit', wit: `platform/${name}/wit/world.wit` },
    pinAfter: 'publish',
    pinIf: pinIfAfter('publish'),
    pinName: name,
    guarded: {
      job: 'publish',
      steps: [
        'Push and verify component',
        'Record component digest',
        'Tag with source hash',
        'Upload publish report',
      ],
    },
    artifacts: [name],
  };
}

/** Files that only test pglite-encfs: they trigger its publish run but are not hashed (#349). */
const ENCFS_TEST_ONLY = [
  'platform/pglite-encfs/tests/**',
  'platform/pglite-encfs/src/testdata/**',
  'platform/pglite-encfs/scripts/smoke.ts',
  'platform/pglite-encfs/scripts/unit.ts',
  'platform/pglite-encfs/scripts/lib/tear.ts',
  'platform/pglite-encfs/scripts/**/*.test.ts',
];

const SPECS: Spec[] = [
  {
    file: '.github/workflows/tenant-host-image.yml',
    image: 'ghcr.io/di-framework/wash',
    paths: ['platform/tenant-host/**', '.github/workflows/tenant-host-image.yml', '!**/*.md'],
    first: 'build',
    firstIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && needs.check-source.outputs.variants != '[]' }}",
    publish: ['build', 'merge', 'realign'],
    readOnly: [],
    pinAfter: 'merge',
    pinIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && needs.check-source.outputs.stale != 'true' && github.ref == 'refs/heads/main' }}",
    realign: { job: 'realign', tags: '${{ matrix.variant.tag }}' },
    pinName: 'wash',
    guarded: { job: 'merge', steps: ['Create and push manifest', 'Record image digest'] },
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
    pinIf: pinIfAfter('publish-index'),
    pinName: 'tenant-auth',
    guarded: { job: 'publish-index', steps: ['Assemble and verify image index'] },
    artifacts: ['tenant-auth'],
  },
  componentSpec('pglite-component', [
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
  ]),
  componentSpec('pglite-encfs', ['platform/pglite-encfs/**'], ENCFS_TEST_ONLY),
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
    pinIf: pinIfAfter('publish'),
    pinName: 'oci-registry',
    guarded: {
      job: 'publish',
      steps: [
        'Build, push, and verify component',
        'Record component digest',
        'Tag with source hash',
        'Upload publish report',
      ],
    },
    artifacts: ['oci-registry'],
  },
  {
    file: '.github/workflows/platform-operator-image.yml',
    image: 'ghcr.io/di-framework/platform-operator',
    // The chart and the Headlamp plugin live under platform/operator/ but are not image inputs.
    paths: [
      'platform/operator/**',
      '!platform/operator/chart/**',
      '!platform/operator/headlamp-plugin/**',
      '.github/workflows/platform-operator-image.yml',
      '!**/*.md',
    ],
    first: 'build',
    firstIf: CHECKED,
    publish: ['build', 'merge'],
    readOnly: [],
    pinAfter: 'merge',
    pinIf: pinIfAfter('merge'),
    pinName: 'platform-operator',
    guarded: { job: 'merge', steps: ['Create and push manifest', 'Tag with source hash'] },
    artifacts: ['platform-operator'],
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

  test('hashes a subset of the files that trigger it (#349)', () => {
    expect(hashExclusions(text)).toEqual(spec.hashExclude ?? []);
    const hashed = hashPaths(text);
    const triggering = trackedFiles().filter((file) => matchesPathFilter(spec.paths, file));
    expect(triggering.length).toBeGreaterThan(0);
    for (const file of trackedFiles()) {
      if (matchesPathFilter(hashed, file)) expect(triggering, file).toContain(file);
    }
    // Every excluded glob names files that would otherwise trigger the run.
    for (const glob of spec.hashExclude ?? []) {
      const excluded = triggering.filter((file) => new Bun.Glob(glob).match(file));
      expect(excluded.length, glob).toBeGreaterThan(0);
      for (const file of excluded) expect(matchesPathFilter(hashed, file), file).toBe(false);
    }
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
    // A re-run of an older push publishes nothing (W2).
    expect(run).toContain('--stale-guard');
    expect(
      check?.steps?.some((s) => s.env?.SOURCE_CHECK_TOKEN === '${{ secrets.GITHUB_TOKEN }}'),
    ).toBe(true);
  });

  test('workflow_dispatch always builds: the check is forced, never skipped', () => {
    const check = jobs['check-source'];
    const steps = check?.steps ?? [];
    const forced = steps.some(
      (s) =>
        s.env?.FORCE === "${{ github.event_name == 'workflow_dispatch' && '--force' || '' }}" ||
        /TRIGGER}" == "workflow_dispatch" \]\]; then[\s\S]*args=\(--force\)/.test(s.run ?? ''),
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
      // Each later job's condition begins with a success check of a job it needs, and that job
      // is check-source or itself runs only after it, so nothing runs past a failed or skipped check.
      const first = job.if?.match(
        /^\$\{\{ !cancelled\(\) && \(?needs\.([\w-]+)\.result == 'success'/,
      )?.[1];
      expect(first, name).toBeDefined();
      expect(needsOf(job), name).toContain(first ?? '');
      const dependsOnCheck = (job: string): boolean =>
        job === 'check-source' || needsOf(jobs[job] ?? {}).some(dependsOnCheck);
      expect(dependsOnCheck(first ?? ''), name).toBe(true);
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
    expect(pin?.permissions).toEqual(
      spec.pinName === 'wash'
        ? { contents: 'write', packages: 'read', 'pull-requests': 'write' }
        : { contents: 'write', 'pull-requests': 'write' },
    );
    expect(needsOf(pin ?? {})).toContain(spec.pinAfter);
    expect(pin?.if).toBe(spec.pinIf);
    // Pin also runs when the source is already published (a revert, a closed pin PR), never when
    // main has newer inputs.
    expect(pin?.if).toContain("needs.check-source.outputs.stale != 'true'");
    expect(needsOf(pin ?? {})).toContain('check-source');
    if (spec.pinName !== 'wash') {
      expect(pin?.if).toContain("needs.check-source.outputs.skip == 'true'");
      const out = jobs['check-source']?.outputs ?? {};
      expect(out.stale).toBe('${{ steps.check.outputs.stale }}');
      expect(out.digest).toBe('${{ steps.check.outputs.digest }}');
    }
    for (const [name, job] of Object.entries(jobs)) {
      if (name === 'pin') continue;
      expect(job.permissions?.contents, name).not.toBe('write');
      expect(job.permissions?.['pull-requests'], name).toBeUndefined();
    }
    const open = pin?.steps?.find((s) => s.uses === './.github/actions/open-pin-pr');
    expect(open?.with?.token).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(open?.with?.name).toBe(spec.pinName);
    expect(open?.with?.workflow).toBe(spec.file);
    // One PR per run: the pin job has no matrix.
    expect(pin?.strategy).toBeUndefined();
    const pins = open?.with?.pins ?? '';
    if (spec.pinName === 'wash') {
      // Every variant, resolved from the registry for this source (not only this run's builds).
      expect(pins).toBe('${{ steps.pins.outputs.pins }}');
      const resolve = pin?.steps?.find((s) => s.run === 'bash scripts/wash-pins.sh');
      expect(resolve?.env?.VARIANTS).toBe('${{ needs.check-source.outputs.all }}');
    } else {
      expect(pins).toBe(
        `${spec.pinName} \${{ needs.${spec.pinAfter}.outputs.digest || needs.check-source.outputs.digest }}`,
      );
    }
    for (const name of spec.artifacts) expect(ARTIFACTS[name], name).toBeDefined();
  });

  test('the job that moves tags re-checks the source right before, and is gated on it', () => {
    const steps = jobs[spec.guarded.job]?.steps ?? [];
    const names = steps.map((s) => (s as { name?: string }).name);
    const guard = steps.findIndex((s) => s.uses === './.github/actions/source-guard');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(steps[guard]?.with?.workflow).toBe(spec.file);
    expect(steps[guard]?.with?.token).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(names.indexOf('Checkout repository')).toBeLessThan(guard);
    for (const name of spec.guarded.steps) {
      const index = names.indexOf(name);
      expect(index, name).toBeGreaterThan(guard);
      expect((steps[index] as { if?: string }).if, name).toBe(
        "steps.guard.outputs.stale != 'true'",
      );
    }
    // Every step that pushes or tags comes after the guard.
    steps.forEach((step, index) => {
      if (
        /oras tag|imagetools create|PUSH: 'true'/.test(
          `${step.run ?? ''}${JSON.stringify(step.env ?? {})}`,
        )
      ) {
        expect(index, (step as { name?: string }).name).toBeGreaterThan(guard);
      }
    });
  });

  test('a revert re-points moving tags only through the guard, and never for a stale run', () => {
    const realign = spec.realign ? jobs[spec.realign.job] : undefined;
    if (!spec.realign) {
      // tenant-auth and oci-registry only push commit-SHA tags; nothing moves.
      expect(jobs.realign).toBeUndefined();
      return;
    }
    expect(realign?.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(realign?.if).toContain("needs.check-source.outputs.stale != 'true'");
    expect(realign?.if).toContain("github.ref == 'refs/heads/main'");
    const steps = (realign?.steps ?? []) as {
      name?: string;
      uses?: string;
      if?: string;
      run?: string;
      env?: Record<string, string>;
    }[];
    const guard = steps.findIndex((s) => s.uses === './.github/actions/source-guard');
    const retag = steps.findIndex((s) => (s.run ?? '').includes('bash scripts/retag.sh'));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(retag).toBeGreaterThan(guard);
    expect(steps[retag]?.if).toBe("steps.guard.outputs.stale != 'true'");
    if (spec.realign.tags === 'wit') {
      expect(steps[retag]?.run).toContain(spec.realign.wit ?? '');
    } else {
      expect(steps[retag]?.env?.TAGS).toBe(spec.realign.tags);
    }
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

test('every job that runs oras sets it up first (C1)', () => {
  const installs = (step: { uses?: string; run?: string; name?: string }) =>
    step.uses === './.github/actions/setup-oras' ||
    step.uses === './.github/actions/setup-source-check' ||
    /oras_\$\{version\}_linux_amd64\.tar\.gz/.test(step.run ?? '');
  // check-source runs oras inside scripts/source-check.ts, and the Wasm component publishers
  // (wasm-component-publisher) push the layer, config and manifest with oras.
  const runsOras = (step: { run?: string }) =>
    /(^|[\s|(])oras\s/m.test(step.run ?? '') ||
    /scripts\/(source-check\.ts|wash-pins\.sh)/.test(step.run ?? '') ||
    /target\/debug\/[\w-]+-publisher\b/.test(step.run ?? '');
  let checked = 0;
  for (const spec of SPECS) {
    for (const [name, job] of Object.entries(parse(spec.file).jobs)) {
      const steps = (job.steps ?? []) as { uses?: string; run?: string; name?: string }[];
      const usesOras = steps.some(runsOras);
      if (!usesOras) continue;
      checked++;
      const first = steps.findIndex((s) => !installs(s) && runsOras(s));
      const setup = steps.findIndex(installs);
      expect(setup, `${spec.file} ${name}`).toBeGreaterThanOrEqual(0);
      expect(setup, `${spec.file} ${name}`).toBeLessThan(first);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(7);
});

test('no Wasm component publisher sees a SOURCE_DATE_EPOCH (#345)', () => {
  // wasm-component-publisher writes SOURCE_DATE_EPOCH into the manifest's created time. A
  // per-commit value (build-engine.ts uses one for the engine build) would give an unchanged
  // component a new digest on every publish, so the publisher step clears it, and neither the
  // workflow nor the job sets it.
  const files = [
    '.github/workflows/oci-registry-component.yml',
    '.github/workflows/pglite-component-publish.yml',
    '.github/workflows/pglite-encfs-publish.yml',
  ];
  for (const file of files) {
    const workflow = parse(file);
    expect(workflow.env?.SOURCE_DATE_EPOCH, file).toBeUndefined();
    let publishers = 0;
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.env?.SOURCE_DATE_EPOCH, `${file} ${name}`).toBeUndefined();
      for (const step of job.steps ?? []) {
        if (!/target\/debug\/[\w-]+-publisher\b/.test(step.run ?? '')) continue;
        publishers++;
        expect(step.env?.PUSH, `${file} ${name}`).toBe('true');
        expect(step.env?.SOURCE_DATE_EPOCH, `${file} ${name}`).toBe('');
      }
    }
    expect(publishers, file).toBe(1);
  }
});

// Every build job that writes a registry cache (cache-to) must stop at the source guard first,
// so a stale re-run never moves the buildcache-* tags back to an older source.
test('a stale re-run of build leaves the buildcache tags alone, in every cache-writing workflow', () => {
  let checked = 0;
  for (const spec of SPECS) {
    const steps = (parse(spec.file).jobs.build?.steps ?? []) as {
      name?: string;
      uses?: string;
      if?: string;
      with?: Record<string, unknown>;
    }[];
    const cacheWriter = steps.findIndex((s) => s.with?.['cache-to'] !== undefined);
    if (cacheWriter < 0) continue;
    checked++;
    const guard = steps.findIndex((s) => s.uses === './.github/actions/source-guard');
    expect(guard, spec.file).toBeGreaterThanOrEqual(0);
    expect(cacheWriter, spec.file).toBeGreaterThan(guard);
    for (const step of steps.slice(guard + 1)) {
      expect(step.if, `${spec.file}: ${step.name ?? step.uses}`).toBe(
        "steps.guard.outputs.stale != 'true'",
      );
    }
  }
  // tenant-host and platform-operator both write buildcache-* tags.
  expect(checked).toBeGreaterThanOrEqual(2);
});

test('the publish workflows use distinct concurrency groups', () => {
  const groups = SPECS.map((spec) => parse(spec.file).concurrency.group);
  expect(new Set(groups).size).toBe(SPECS.length);
});

test('the tenant host publishes both variants on push, as a native two-arch matrix', () => {
  const workflow = parse('.github/workflows/tenant-host-image.yml');
  const run = workflow.jobs['check-source']?.steps?.map((s) => s.run ?? '').join('\n') ?? '';
  // On a push every listed variant is checked (and only skipped when published or stale).
  expect(run).toContain('args=(--stale-guard)');
  expect(run).toContain('done <<<"${rows}"');
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

test('the operator image ignores the chart and Headlamp plugin trees, which are not image inputs (#271)', () => {
  const filter = pushPaths(read('.github/workflows/platform-operator-image.yml'));
  for (const file of [
    'platform/operator/Dockerfile',
    'platform/operator/go.mod',
    'platform/operator/cmd/platform-operator/main.go',
    '.github/workflows/platform-operator-image.yml',
  ]) {
    expect(matchesPathFilter(filter, file), file).toBe(true);
  }
  for (const file of [
    'platform/operator/README.md',
    'platform/operator/chart/values.yaml',
    'platform/operator/chart/templates/deployment.yaml',
    'platform/operator/headlamp-plugin/src/index.tsx',
  ]) {
    expect(matchesPathFilter(filter, file), file).toBe(false);
  }
});

describe('pglite-encfs test-only files (#349)', () => {
  const text = read('.github/workflows/pglite-encfs-publish.yml');
  const trigger = pushPaths(text);
  const hashed = hashPaths(text);
  const files = trackedFiles().filter(
    (file) => file.startsWith('platform/pglite-encfs/') && !file.endsWith('.md'),
  );
  const testOnly = (file: string) => ENCFS_TEST_ONLY.some((glob) => new Bun.Glob(glob).match(file));

  test('start the publish run but do not change the source hash', () => {
    expect(files.filter(testOnly).length).toBeGreaterThan(0);
    for (const file of files) {
      expect(matchesPathFilter(trigger, file), file).toBe(true);
      expect(matchesPathFilter(hashed, file), file).toBe(!testOnly(file));
    }
  });

  test.each([
    ['tests/root-probe/src/lib.rs', false],
    ['src/testdata/xts-kat.txt', false],
    ['scripts/smoke.ts', false],
    ['scripts/lib/tear.test.ts', false],
    ['src/component.rs', true],
    ['wit/world.wit', true],
    ['Cargo.toml', true],
  ] as const)('platform/pglite-encfs/%s is hashed: %p', (path, isHashed) => {
    const file = `platform/pglite-encfs/${path}`;
    expect(files).toContain(file);
    expect(matchesPathFilter(hashed, file)).toBe(isHashed);
  });

  test('the build never imports a file the hash leaves out', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = read(file);
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        visit(join(dirname(file), match[1] as string));
      }
    };
    visit('platform/pglite-encfs/scripts/build.ts');
    expect([...seen]).toContain('platform/pglite-encfs/scripts/lib/wit.ts');
    for (const file of seen) {
      expect(files, file).toContain(file);
      expect(matchesPathFilter(hashed, file), file).toBe(true);
    }
  });
});

test('merging a pin PR never republishes its own artifact, and any other publish it starts ends there', () => {
  // The tenant host pin also appends to the patch-0003 allowlist (#346), which lives in
  // platform/platform/src/tenancy/, an input of the tenant-auth image. That is the one publish a
  // pin PR may start; tenant-auth's own pin touches no input, so the chain stops after one hop.
  // The exclusive host pin also moves the operator's DefaultTenantHostImage (#442), an input of
  // the platform-operator image, which must ship the new default; its own pin touches no input.
  const triggers: string[] = [];
  for (const pinSpec of SPECS) {
    for (const file of new Set(pinSpec.artifacts.flatMap(artifactFiles))) {
      expect(matchesPathFilter(pinSpec.paths, file), `${pinSpec.file}: ${file}`).toBe(false);
      for (const spec of SPECS) {
        if (matchesPathFilter(spec.paths, file))
          triggers.push(`${pinSpec.pinName} -> ${spec.pinName}: ${file}`);
      }
    }
  }
  expect(triggers).toEqual([
    'wash -> tenant-auth: platform/platform/src/tenancy/registry-nats.ts',
    'wash -> platform-operator: platform/operator/internal/controller/tenancy.go',
  ]);
  for (const name of Object.keys(ARTIFACTS).filter((n) => !n.startsWith('wash-'))) {
    for (const file of artifactFiles(name)) {
      for (const spec of SPECS) expect(matchesPathFilter(spec.paths, file), file).toBe(false);
    }
  }
});

describe('composite actions', () => {
  const open = read('.github/actions/open-pin-pr/action.yml');
  const setup = read('.github/actions/setup-source-check/action.yml');
  const guard = read('.github/actions/source-guard/action.yml');

  test('the source guard compares inputs with main, and never stops a dispatch', () => {
    expect(guard).toContain('--stale-guard --no-registry ${FORCE} --github-output');
    expect(guard).toContain(
      "FORCE: ${{ github.event_name == 'workflow_dispatch' && '--force' || '' }}",
    );
    expect(guard).toContain('SOURCE_CHECK_TOKEN: ${{ inputs.token }}');
  });

  test('the pin PR is bot/pin-<name>, titled with the digest, and says CI needs a maintainer', () => {
    expect(open).toContain('branch="bot/pin-${NAME}"');
    expect(open).toContain('title="chore: pin ${summary[0]}"');
    expect(open).toContain('bun scripts/pin-artifact.ts "${args[@]}"');
    expect(open).toContain(
      'bun scripts/source-check.ts --workflow "${WORKFLOW}" --image unused --stale-guard --no-registry',
    );
    expect(open).toContain('if [[ "${EVENT}" == "push" ]]; then');
    expect(open).toContain('A maintainer has to approve and run this PR');
    expect(open).toContain('GitHub does not trigger workflows for pull requests');
    expect(open).toContain('gh pr edit');
    expect(open).toContain('gh pr create --base main');
  });

  test('pin actions and the Bun version by SHA and use no stored secret', () => {
    for (const text of [open, setup, guard]) {
      expect(text).not.toContain('secrets.');
      expect(text).toContain("bun-version: '1.4.2'");
      for (const [, ref] of text.matchAll(/uses:\s+(\S+)/g)) {
        if (ref?.startsWith('./.github/actions/')) continue;
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

describe('ORAS is pinned to 1.3.4 by sha256 everywhere', () => {
  // setup-oras's built-in release table at the pinned SHA has no 1.3.4, so its `version` input
  // fails ("official ORAS CLI releases does not contain version 1.3.4"). Every install goes
  // through .github/actions/setup-oras, which passes the official asset `url` and `checksum`.
  const OFFICIAL: Record<string, string> = {
    amd64: 'f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454',
    arm64: '15702c6e3a4a56a8bd8ac5c17efdbcab56d9bada661ccbcf017f5b10c1d89399',
  };
  const action = read('.github/actions/setup-oras/action.yml');
  const files = [
    ...new Bun.Glob('.github/workflows/*.yml').scanSync({ cwd: repo }),
    ...new Bun.Glob('.github/actions/*/action.yml').scanSync({ cwd: repo }),
  ];

  test('the setup-oras action installs the official 1.3.4 asset per runner arch, by url and checksum', () => {
    expect(action).toContain('version=1.3.4');
    expect(action).toContain(
      'https://github.com/oras-project/oras/releases/download/v${version}/oras_${version}_linux_${arch}.tar.gz',
    );
    for (const [runnerArch, arch] of [
      ['X64', 'amd64'],
      ['ARM64', 'arm64'],
    ] as const) {
      expect(action).toMatch(
        new RegExp(`${runnerArch}\\)\\s+arch=${arch}\\s+sha256=${OFFICIAL[arch]}\\s+;;`),
      );
    }
    expect(action).toContain('url: ${{ steps.asset.outputs.url }}');
    expect(action).toContain('checksum: ${{ steps.asset.outputs.checksum }}');
    const installs = [...action.matchAll(/uses:\s+oras-project\/setup-oras@[0-9a-f]{40}/g)];
    expect(installs).toHaveLength(1);
    expect(action).not.toMatch(/^\s*version:/m);
  });

  test('no workflow or other action calls setup-oras by version; inline installs pin a sha256', () => {
    let calls = 0;
    for (const file of files) {
      if (file === '.github/actions/setup-oras/action.yml') continue;
      const text = read(file);
      expect(text, file).not.toContain('oras-project/setup-oras@');
      calls += text.match(/uses:\s+\.\/\.github\/actions\/setup-oras\s*$/gm)?.length ?? 0;
      // Inline installs (pglite-component-publish build job) fetch the same asset and check it.
      const inline = text.match(/oras_\$\{version\}_linux_/g)?.length ?? 0;
      const pinned = [
        ...text.matchAll(
          /version=(\S+)\n\s*sha256=(\S+)\n[^\n]*oras_\$\{version\}_linux_(amd64|arm64)\.tar\.gz"\n\s*echo "\$\{sha256\} {2}\S+" \| sha256sum -c -/g,
        ),
      ];
      expect(pinned.length, file).toBe(inline);
      for (const [, version, sha256, arch] of pinned) {
        expect(version, file).toBe('1.3.4');
        expect(sha256, file).toBe(OFFICIAL[arch as string]);
      }
    }
    // setup-source-check plus the four retag/index steps.
    expect(calls).toBeGreaterThanOrEqual(5);
  });
});

test('the tenant host resolves variants in one place, from platform/tenant-host/variants', () => {
  const text = read('.github/workflows/tenant-host-image.yml');
  const workflow = parse('.github/workflows/tenant-host-image.yml');
  const resolver = workflow.jobs['check-source']?.steps?.map((s) => s.run ?? '').join('\n') ?? '';
  // The table (#176) is read only by check-source; build, merge and pin take its outputs.
  expect(resolver).toContain('table=platform/tenant-host/variants');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'check-source') continue;
    for (const step of job.steps ?? []) expect(step.run ?? '', name).not.toContain('variants');
  }
  for (const job of ['build', 'merge', 'pin']) {
    for (const step of workflow.jobs[job]?.steps ?? []) {
      expect(step.run ?? '', job).not.toContain('.patch');
    }
  }
  const filter = pushPaths(text);
  for (const file of Bun.spawnSync(['git', 'ls-files', 'platform/tenant-host'], { env, cwd: repo })
    .stdout.toString()
    .trim()
    .split('\n')) {
    expect(matchesPathFilter(filter, file), file).toBe(!file.endsWith('.md'));
  }
  for (const file of [
    'variants',
    '0002-insecure-registry-allowlist.patch',
    '0003-nats-blobstore-credentials.patch',
  ]) {
    expect(matchesPathFilter(filter, `platform/tenant-host/${file}`), file).toBe(true);
  }
});

test('every tenant host variant carries the NATS blobstore credentials patch, and CI tests it (#330)', () => {
  const patch = '0003-nats-blobstore-credentials.patch';
  const rows = read('platform/tenant-host/variants')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/));
  expect(rows.length).toBeGreaterThan(0);
  // Last in each row: it is a `git diff` against the pinned commit and touches no file 0001/0002 do.
  for (const [tag, ...patches] of rows) expect(patches.at(-1), tag).toBe(patch);
  const dockerfile = read('platform/tenant-host/Dockerfile');
  expect(dockerfile).toContain(`ARG WASH_PATCHES="${rows[0]?.slice(1).join(' ')}"`);
  const text = read(`platform/tenant-host/${patch}`);
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
  expect(files).toEqual(['crates/wash-runtime/src/plugin/wasi_blobstore/multiplexed/nats.rs']);
  for (const other of ['0001-exclusive-instance.patch', '0002-insecure-registry-allowlist.patch']) {
    const touched = read(`platform/tenant-host/${other}`);
    for (const file of files) expect(touched, other).not.toContain(`a/${file} `);
  }
  // Every test the patch adds is a required test of the patch-check job, and nothing else is.
  const check = read('.github/workflows/tenant-host-patch-check.yml');
  expect(check).toContain(`*" ${patch} "*`);
  const prefix = 'plugin::wasi_blobstore::multiplexed::nats::tests::';
  const added = [...text.matchAll(/^\+\s+(?:async )?fn (nats_blobstore_\w+)\(/gm)].map((m) => m[1]);
  const required = [...check.matchAll(new RegExp(`^\\s+${prefix}(\\w+)$`, 'gm'))].map((m) => m[1]);
  expect(added.length).toBeGreaterThan(0);
  expect(required.sort()).toEqual(added.sort());
});

test('CI runs every exclusive-instance topology test the 0001 patch adds, by name (#144)', () => {
  const text = read('platform/tenant-host/0001-exclusive-instance.patch');
  const file = 'crates/wash-runtime/tests/integration_exclusive_topology.rs';
  const section = text.split(/^diff --git /m).find((s) => s.startsWith(`a/${file} b/${file}`));
  expect(section).toBeDefined();
  const added = [
    ...(section ?? '').matchAll(/^\+#\[tokio::test[^\n]*\n\+(?:async )?fn (\w+)\(/gm),
  ].map((m) => m[1] ?? '');
  expect(added).toContain('an_http_trap_leaves_the_queued_calls_a_fresh_instance');
  expect(added).toContain('an_http_timeout_leaves_the_queued_calls_a_fresh_instance');

  const workflow = parse('.github/workflows/tenant-host-patch-check.yml');
  const steps = workflow.jobs.patch?.steps ?? [];
  const fixtures = steps.find((s) => s.name === 'Build the wasm test fixtures');
  const topology = steps.find((s) => s.name === 'Test the exclusive-instance topology');
  const onlyWith0001 =
    "contains(format(' {0} ', matrix.patches), ' 0001-exclusive-instance.patch ')";
  expect(fixtures?.if).toBe(onlyWith0001);
  expect(topology?.if).toBe(onlyWith0001);
  expect(fixtures?.run).toContain('cargo xtask build-fixtures');
  expect(fixtures?.run).toContain('CARGO_TARGET_WASM32_WASIP2_LINKER');
  // The fixtures are built before the tests that `include_bytes!` them.
  const index = (name: string) => steps.findIndex((s) => s.name === name);
  expect(index('Build the wasm test fixtures')).toBeLessThan(
    index('Test the exclusive-instance topology'),
  );
  const run = topology?.run ?? '';
  expect(run).toContain('--test integration_exclusive_topology');
  expect(run).toContain('::error::required topology test ${name} did not run and pass');
  const block = run.match(/required=\(\n([\s\S]*?)\n\s*\)/)?.[1] ?? '';
  const required = block.split('\n').map((line) => line.trim());
  expect(added.length).toBeGreaterThan(0);
  expect([...required].sort()).toEqual([...added].sort());

  // The flag a trap reported to an HTTP task sets is unit-tested in the pool tests, by name.
  const unit = 'a_call_finished_faulted_retires_its_instance_before_the_next_is_admitted';
  expect(text).toMatch(new RegExp(`^\\+async fn ${unit}\\(`, 'm'));
  expect(read('.github/workflows/tenant-host-patch-check.yml')).toContain(
    `engine::instance_pool::exclusive_tests::${unit}\n`,
  );
  expect(fixtures?.run).toContain(
    'root="${HOME}/.cache/wasm-component-ld/${WASM_COMPONENT_LD_VERSION}"',
  );
});

describe('the check-source resolver reads platform/tenant-host/variants', () => {
  const workflow = parse('.github/workflows/tenant-host-image.yml');
  const script =
    workflow.jobs['check-source']?.steps?.find((s) => (s.run ?? '').includes('table='))?.run ?? '';

  /**
   * Run the resolver in a directory holding `table` as platform/tenant-host/variants, with a stub
   * `bun` standing in for scripts/source-check.ts (never published, never stale).
   */
  function resolve(table: string, trigger: string, variant = '', answer = 'echo "skip=false"') {
    const dir = mkdtempSync(join(tmpdir(), 'variants-'));
    mkdirSync(join(dir, 'platform/tenant-host'), { recursive: true });
    writeFileSync(join(dir, 'platform/tenant-host/variants'), table);
    const bin = join(dir, 'bin');
    stubCommand(
      bin,
      'bun',
      `echo "hash=${'a'.repeat(64)}"\n${answer}\necho "args=$*" >> "${dir}/bun.log"`,
    );
    const output = join(dir, 'out');
    writeFileSync(output, '');
    const result = Bun.spawnSync(['bash', '-c', script], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        TRIGGER: trigger,
        VARIANT: variant,
        GITHUB_OUTPUT: output,
      },
    });
    const out = readFileSync(output, 'utf8');
    const value = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? 'null';
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      variants: JSON.parse(value('variants')) as {
        name: string;
        tag: string;
        patches: string;
        canonical: boolean;
      }[],
      all: JSON.parse(value('all')) as string[],
      published: JSON.parse(value('published')) as { name: string; tag: string; digest: string }[],
      stale: value('stale'),
      bun: (() => {
        try {
          return readFileSync(join(dir, 'bun.log'), 'utf8');
        } catch {
          return '';
        }
      })(),
    };
  }

  const table = read('platform/tenant-host/variants');

  test('on push every row of the real table is a candidate, the first row is canonical', () => {
    const r = resolve(table, 'push');
    expect(r.exitCode).toBe(0);
    const rows = table
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.trim().split(/\s+/));
    expect(r.variants.map((v) => [v.tag, ...v.patches.split(' ')])).toEqual(rows);
    expect(r.variants.map((v) => v.canonical)).toEqual(rows.map((_, i) => i === 0));
    expect(r.all).toEqual(rows.map(([tag]) => (tag ?? '').replace(/^2\.8\.0-/, '')));
    // Every variant the table lists has a pin target.
    for (const name of r.all) expect(ARTIFACTS[`wash-${name}`], name).toBeDefined();
    expect(r.bun.match(/--stale-guard/g)).toHaveLength(rows.length);
  });

  test('comment lines are skipped, wherever they are', () => {
    const r = resolve('# a\n2.8.0-x  p1.patch p2.patch\n  # b\n\n2.8.0-y\n', 'push');
    expect(r.exitCode).toBe(0);
    expect(r.variants).toEqual([
      {
        name: 'x',
        tag: '2.8.0-x',
        patches: 'p1.patch p2.patch',
        hash: 'a'.repeat(64),
        canonical: true,
      },
      { name: 'y', tag: '2.8.0-y', patches: '', hash: 'a'.repeat(64), canonical: false },
    ] as never);
  });

  test('a dispatch builds only the selected variant, forced', () => {
    const r = resolve(table, 'workflow_dispatch', 'wasi-tls-exclusive');
    expect(r.exitCode).toBe(0);
    expect(r.variants.map((v) => v.tag)).toEqual(['2.8.0-wasi-tls-exclusive']);
    expect(r.variants[0]?.canonical).toBe(false);
    expect(r.bun).toContain('--force');
    expect(r.bun).not.toContain('--stale-guard');
  });

  test('an already-published source is handed to realign and pin, not built (a revert)', () => {
    const digest = `sha256:${'e'.repeat(64)}`;
    const r = resolve(
      table,
      'push',
      '',
      `echo "stale=false"; echo "skip=true"; echo "digest=${digest}"`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.variants).toEqual([]);
    expect(r.stale).toBe('false');
    expect(r.published.map((v) => [v.name, v.tag, v.digest])).toEqual([
      ['wasi-tls', '2.8.0-wasi-tls', digest],
      ['wasi-tls-exclusive', '2.8.0-wasi-tls-exclusive', digest],
    ]);
  });

  test('a stale run builds nothing and hands nothing to realign', () => {
    const r = resolve(table, 'push', '', 'echo "stale=true"; echo "skip=true"; echo "digest="');
    expect(r.exitCode).toBe(0);
    expect(r.variants).toEqual([]);
    expect(r.published).toEqual([]);
    expect(r.stale).toBe('true');
  });

  test('the dispatch choices are exactly the table rows (S2)', () => {
    const options = (
      workflow.on.workflow_dispatch as {
        inputs: { variant: { options: string[]; default: string } };
      }
    ).inputs.variant;
    const tags = table
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => (line.trim().split(/\s+/)[0] ?? '').replace(/^2\.8\.0-/, ''));
    expect(options.options).toEqual(tags);
    expect(options.default).toBe(tags[0] ?? '');
  });

  test('a dispatch of an unlisted variant fails', () => {
    const r = resolve(table, 'workflow_dispatch', 'nope');
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout).toContain('is not listed');
  });

  test('merge reports the canonical flag from the resolver, not from the patch set', () => {
    const record = workflow.jobs.merge?.steps?.find((s) => (s.run ?? '').includes('CANONICAL'));
    expect(record?.env?.CANONICAL).toBe('${{ matrix.variant.canonical }}');
    expect(record?.run).toContain('if [[ "${CANONICAL}" == "true" ]]; then');
    expect(record?.run).not.toContain('-n "${PATCHES}"');
  });
});

describe('scripts/wash-pins.sh (the wash pin set)', () => {
  // A stub oras that publishes only the src-<hash> tags listed in $PUBLISHED.
  function run(published: string[]) {
    const base = mkdtempSync(join(tmpdir(), 'wash-pins-'));
    const bin = join(base, 'bin');
    stubCommand(
      bin,
      'oras',
      [
        'ref="$4"',
        'for tag in $PUBLISHED; do',
        '  case "$ref" in *":$tag") echo "{\\"digest\\":\\"sha256:$(printf %064d 0 | tr 0 "${tag#src-}" | cut -c1-64)\\"}"; exit 0 ;; esac',
        'done',
        'echo "Error: $ref: not found" >&2; exit 1',
      ].join('\n'),
    );
    const output = join(base, 'out');
    writeFileSync(output, '');
    const result = Bun.spawnSync(['bash', 'scripts/wash-pins.sh'], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        VARIANTS: '["wasi-tls","wasi-tls-exclusive"]',
        PUBLISHED: published.join(' '),
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const pins = readFileSync(output, 'utf8').match(/^pins<<EOF\n([\s\S]*)EOF\n$/)?.[1];
    expect(pins).toBeDefined();
    return (pins ?? '').split('\n').filter(Boolean);
  }

  function tag(salt: string): string {
    const out = Bun.spawnSync(
      [
        process.execPath,
        'scripts/source-check.ts',
        '--workflow',
        '.github/workflows/tenant-host-image.yml',
        '--image',
        'x',
        '--salt',
        salt,
        '--force',
      ],
      { cwd: repo, env, stdout: 'pipe' },
    ).stdout.toString();
    return out.match(/^tag=(src-[0-9a-f]{64})$/m)?.[1] ?? '';
  }

  test('pins every variant published for this source, not only what this run built (W1)', () => {
    const pins = run([tag('wasi-tls'), tag('wasi-tls-exclusive')]);
    expect(pins.map((line) => line.split(' ')[0])).toEqual([
      'wash-wasi-tls',
      'wash-wasi-tls-exclusive',
    ]);
    for (const line of pins) expect(line).toMatch(/^wash-[\w-]+ sha256:[0-9a-f]{64}$/);
  });

  test('a variant not yet published for this source keeps its current row', () => {
    expect(run([tag('wasi-tls-exclusive')]).map((line) => line.split(' ')[0])).toEqual([
      'wash-wasi-tls-exclusive',
    ]);
    expect(run([])).toEqual([]);
  });
});

describe('digest artifacts: no download pattern reaches another artifact', () => {
  /** The variant tags, in table order, from platform/tenant-host/variants. */
  const tags = read('platform/tenant-host/variants')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0] ?? '');
  const workflow = parse('.github/workflows/tenant-host-image.yml');
  const arches = workflow.jobs.build?.strategy?.matrix?.arch as string[];
  const withOf = (job: string, action: string) =>
    (workflow.jobs[job]?.steps ?? [])
      .filter((s) => s.uses?.startsWith(`${action}@`))
      .map((s) => s.with ?? {});
  const render = (template: string, tag: string, arch = '') =>
    template.replaceAll('${{ matrix.variant.tag }}', tag).replaceAll('${{ matrix.arch }}', arch);
  /** The artifact names one variant's build uploads (one per arch). */
  const uploads = (tag: string) =>
    withOf('build', 'actions/upload-artifact').flatMap((w) =>
      arches.map((arch) => render(w.name ?? '', tag, arch)),
    );
  /** The artifact names one variant's merge downloads, simulated over `candidates`. */
  const downloads = (tag: string, candidates: string[]) =>
    candidates.filter((name) =>
      withOf('merge', 'actions/download-artifact').some((w) =>
        w.pattern !== undefined
          ? new Bun.Glob(render(w.pattern, tag)).match(name)
          : render(w.name ?? '', tag) === name,
      ),
    );

  test('the table and the build matrix are read', () => {
    expect(tags).toEqual(['2.8.0-wasi-tls', '2.8.0-wasi-tls-exclusive']);
    expect(arches).toEqual(['amd64', 'arm64']);
    expect(withOf('build', 'actions/upload-artifact')).toHaveLength(1);
    expect(withOf('merge', 'actions/download-artifact')).toHaveLength(arches.length);
  });

  test('every variant merges exactly its own per-arch digests, even when one tag prefixes another', () => {
    // 2.8.0-wasi-tls prefixes 2.8.0-wasi-tls-exclusive: a `<tag>-*` pattern took both variants'
    // digests and the canonical merge found 4 (#186). Also check hypothetical tags.
    const sets = [tags, [...tags, '2.8.0-wasi-tls-amd64', '2.8.0', '2.8.0-wasi-tls-exclusive-x']];
    for (const set of sets) {
      const all = set.flatMap(uploads);
      expect(new Set(all).size).toBe(all.length);
      for (const tag of set) {
        expect(uploads(tag)).toHaveLength(arches.length);
        expect(downloads(tag, all).sort(), tag).toEqual(uploads(tag).sort());
      }
    }
  });

  test('the tenant-auth index downloads only the per-arch publish reports', () => {
    const auth = parse('.github/workflows/tenant-auth-image.yml');
    const include = (auth.jobs['publish-platform']?.strategy?.matrix?.include ?? []) as {
      arch: string;
    }[];
    const authArches = include.map((i) => i.arch);
    expect(authArches).toEqual(['amd64', 'arm64']);
    const names = Object.values(auth.jobs).flatMap((job) =>
      (job.steps ?? [])
        .filter((s) => s.uses?.startsWith('actions/upload-artifact@'))
        .flatMap((s) =>
          (s.with?.name ?? '').includes('${{ matrix.arch }}')
            ? authArches.map((arch) => (s.with?.name ?? '').replaceAll('${{ matrix.arch }}', arch))
            : [s.with?.name ?? ''],
        ),
    );
    const patterns = Object.values(auth.jobs).flatMap((job) =>
      (job.steps ?? [])
        .filter((s) => s.uses?.startsWith('actions/download-artifact@'))
        .map((s) => s.with?.pattern ?? s.with?.name ?? ''),
    );
    expect(patterns).toHaveLength(1);
    const glob = new Bun.Glob(patterns[0] ?? '');
    expect(names.filter((n) => glob.match(n)).sort()).toEqual(
      authArches.map((arch) => `tenant-auth-${arch}`).sort(),
    );
  });
});

describe('release.yml publishes the tested npm tarballs byte for byte (#168)', () => {
  const release = parse('.github/workflows/release.yml');
  const steps = (job: string) => release.jobs[job]?.steps ?? [];
  const runs = (job: string) =>
    steps(job)
      .map((s) => s.run ?? '')
      .join('\n');
  const uses = (job: string) => steps(job).map((s) => s.uses ?? '');

  test('keeps its triggers: v* tag pushes and the dispatch Auto Tag sends', () => {
    expect(release.on.push).toEqual({ tags: ['v*'] } as never);
    expect('workflow_dispatch' in release.on).toBe(true);
  });

  test('build, publish and github-release run in that order; chart runs after build, before the Release', () => {
    expect(Object.keys(release.jobs).sort()).toEqual([
      'build',
      'chart',
      'github-release',
      'publish',
    ]);
    expect(release.jobs.publish?.needs).toBe('build');
    // The GitHub Release is announced only once the npm packages and the chart are both out; it
    // needs build for the Headlamp plugin's sha256 (#435).
    expect(release.jobs['github-release']?.needs).toEqual(['build', 'publish', 'chart']);
    expect(release.jobs['github-release']?.if).toBe("github.ref_type == 'tag'");
    expect(release.jobs.chart?.needs).toBe('build');
    expect(release.jobs.chart?.if).toBe("github.ref_type == 'tag'");
  });

  test('only publish holds an OIDC token, only github-release can write contents', () => {
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.build?.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.publish?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(release.jobs['github-release']?.permissions).toEqual({ contents: 'write' });
    expect(release.jobs.chart?.permissions).toEqual({ contents: 'read', packages: 'write' });
  });

  test('chart packages the operator chart at the tag version and pushes it to GHCR (#272)', () => {
    const chart = runs('chart');
    for (const ref of uses('chart').filter(Boolean)) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    // The helm the chart tests download, checked by the same sha256.
    const helper = read('platform/backup-destination/tests/support/helm.ts');
    const install = steps('chart').find((s) => s.name === 'Install helm');
    expect(helper).toContain(`const version = '${install?.env?.HELM_VERSION}';`);
    expect(helper).toContain(`'linux-amd64': '${install?.env?.HELM_SHA256}'`);
    expect(install?.run).toContain('sha256sum -c -');
    expect(chart).toContain('VERSION="${GITHUB_REF_NAME#v}"');
    expect(chart).toContain(
      'helm package platform/operator/chart --version "$VERSION" --app-version "$VERSION"',
    );
    expect(chart).toContain('helm registry login ghcr.io');
    expect(chart).toContain('--password-stdin');
    expect(chart).toContain('helm push "$TARBALL" oci://ghcr.io/di-framework/charts');
    expect(chart.indexOf('helm package')).toBeLessThan(chart.indexOf('helm push'));
    // A chart whose defaults do not render is never published.
    expect(chart).toContain('helm template platform-operator platform/operator/chart');
    expect(chart).toContain('refusing to publish the chart');
    expect(chart.indexOf('refusing to publish the chart')).toBeLessThan(
      chart.indexOf('helm package'),
    );
    // Idempotent: a re-run never overwrites a released chart version with different bytes.
    const show =
      'helm show chart oci://ghcr.io/di-framework/charts/platform-operator --version "$VERSION"';
    expect(chart).toContain(show);
    expect(chart.indexOf(show)).toBeLessThan(chart.indexOf('helm push'));
    expect(chart).toContain('not pushing it again');
    expect(chart).toContain('::warning::GHCR denied reading platform-operator');
    expect(chart).not.toMatch(/\bmake\b|docker|bun install|helm dependency/);
  });

  test('an unpinned image.digest skips the chart with a warning; a pinned one packages and pushes (W5)', () => {
    const chartSteps = steps('chart');
    const pin = chartSteps.find((s) => s.id === 'pin');
    const pinIndex = chartSteps.indexOf(pin as never);
    for (const name of ['Package the chart', 'Push the chart to GHCR']) {
      const step = chartSteps.find((s) => s.name === name);
      expect(chartSteps.indexOf(step as never)).toBeGreaterThan(pinIndex);
      expect(step?.if).toBe("steps.pin.outputs.pinned == 'true'");
    }
    // github-release still runs: the skip is a success, not a failure.
    expect(release.jobs['github-release']?.needs).toContain('chart');
    const values = read('platform/operator/chart/values.yaml');
    const runPin = (digest: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'chart-pin-'));
      mkdirSync(join(dir, 'platform/operator/chart'), { recursive: true });
      writeFileSync(
        join(dir, 'platform/operator/chart/values.yaml'),
        values.replace(/^ {2}digest: .*$/m, `  digest: ${digest}`),
      );
      const output = join(dir, 'github-output');
      writeFileSync(output, '');
      const result = Bun.spawnSync(['bash', '-c', pin?.run ?? 'exit 1'], {
        cwd: dir,
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        output: readFileSync(output, 'utf8'),
      };
    };
    // A placeholder (the chart's value before its first pin): skipped, exit 0, with a warning.
    const skipped = runPin('sha256:<pinned by the platform-operator image pin PR>');
    expect(skipped.code).toBe(0);
    expect(skipped.output).toBe('pinned=false\n');
    expect(skipped.stdout).toContain('::warning::chart not published');
    const pinned = runPin(`sha256:${'0'.repeat(64)}`);
    expect(pinned.code).toBe(0);
    expect(pinned.output).toBe('pinned=true\n');
    expect(pinned.stdout).not.toContain('::warning::');
    expect(runPin(`sha256:${'0'.repeat(63)}`).output).toBe('pinned=false\n');
  });

  test('build packs the Headlamp plugin at a tag and verifies its Artifact Hub entry (#435)', () => {
    const build = steps('build');
    const plugin = build.find((s) => s.id === 'plugin');
    const node = build.find((s) => s.name === 'Setup Node for the Headlamp plugin');
    const upload = build.find((s) => s.name === 'Upload the Headlamp plugin');
    for (const step of [plugin, node, upload]) expect(step?.if).toBe("github.ref_type == 'tag'");
    const ci = parse('.github/workflows/ci.yml').jobs['headlamp-plugin']?.steps ?? [];
    const ciNode = ci.find((s) => s.uses?.startsWith('actions/setup-node@'));
    expect(node?.uses).toBe(ciNode?.uses);
    expect(node?.with?.['node-version']).toBe(ciNode?.with?.['node-version']);
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload?.with?.name).toBe('headlamp-plugin');
    const run = plugin?.run ?? '';
    expect(run).toContain('set -euo pipefail');
    const order = [
      'artifacthub/$VERSION/artifacthub-pkg.yml',
      'bun install --cwd platform/operator/headlamp-plugin --frozen-lockfile --ignore-scripts',
      'bun run --cwd platform/operator/headlamp-plugin package',
      'bun scripts/artifacthub-plugin.ts verify "$VERSION" --required',
      'echo "sha256=',
    ].map((s) => run.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(release.jobs.build?.outputs?.plugin_sha256).toBe('${{ steps.plugin.outputs.sha256 }}');
    // The pinned Node is the last one set up before the pack, and the pack refuses any other.
    const packIndex = build.indexOf(plugin as never);
    const lastNode = build
      .slice(0, packIndex)
      .filter((s) => s.uses?.startsWith('actions/setup-node@'))
      .at(-1);
    expect(lastNode).toBe(node);
    const guard = `if [ "$(node -v)" != "v${ciNode?.with?.['node-version']}" ]; then`;
    expect(run).toContain(guard);
    expect(run.indexOf(guard)).toBeLessThan(order[1] ?? -1);
    const autoTag = parse('.github/workflows/auto-tag.yml').jobs['release-pr']?.steps ?? [];
    const bump = autoTag.find((s) => s.run?.includes('artifacthub-plugin.ts write'))?.run ?? '';
    expect(bump).toContain(guard);
    expect(bump.indexOf(guard)).toBeLessThan(bump.indexOf('bun run --cwd'));
    // The same Bun as Auto Tag and the plugin's CI job (S6).
    const bun = (s: { uses?: string }) => s.uses?.startsWith('oven-sh/setup-bun@') ?? false;
    expect(build.find(bun)?.with?.['bun-version']).toBe(ci.find(bun)?.with?.['bun-version']);
    expect(build.find(bun)?.with?.['bun-version']).toBe(autoTag.find(bun)?.with?.['bun-version']);
    // The plugin is packed after the npm packages are uploaded, so it cannot change them.
    expect(build.indexOf(node as never)).toBeGreaterThan(build.findIndex((s) => s.id === 'upload'));
  });

  test('github-release uploads the build job plugin byte for byte, each asset once (#435)', () => {
    const job = steps('github-release');
    for (const ref of uses('github-release').filter(Boolean)) expect(ref).toMatch(/@[0-9a-f]{40}$/);
    const all = runs('github-release');
    for (const s of job.filter((s) => s.run)) expect(s.run).toContain('set -euo pipefail');
    // No rebuild: no plugin install, no pack, no Node or Bun setup.
    expect(all).not.toMatch(/bun install|bun run|bun scripts/);
    expect(uses('github-release').some((u) => /setup-(node|bun)/.test(u))).toBe(false);
    const download = job.find((s) => s.uses?.startsWith('actions/download-artifact@'));
    expect(download?.with?.name).toBe('headlamp-plugin');
    const upload = job.find((s) => s.name === 'Upload the Headlamp plugin to the GitHub Release');
    expect(upload?.env?.EXPECTED_SHA256).toBe('${{ needs.build.outputs.plugin_sha256 }}');
    const order = [
      'gh release create "$TAG"',
      'sha256sum "$TARBALL"',
      '"$actual" != "$EXPECTED_SHA256"',
      'for FILE in "$TARBALL" "$TARBALL.sha256"; do',
      'grep -Fxq "$NAME" <<< "$ASSETS"',
      'gh release upload "$TAG" "$FILE"',
    ].map((s) => all.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(all).toContain('::error::');
    expect(all).not.toContain('--clobber');
  });

  test('github-release uploads only the plugin assets the release lacks (#435)', () => {
    const run =
      steps('github-release').find(
        (s) => s.name === 'Upload the Headlamp plugin to the GitHub Release',
      )?.run ?? '';
    const temp = mkdtempSync(join(tmpdir(), 'plugin-upload-'));
    mkdirSync(join(temp, 'headlamp-plugin'));
    const tarball = join(temp, 'headlamp-plugin', 'di-framework-platform-6.0.18.tar.gz');
    writeFileSync(tarball, 'bytes');
    writeFileSync(`${tarball}.sha256`, 'sum');
    const sha = new Bun.CryptoHasher('sha256').update('bytes').digest('hex');
    let n = 0;
    const exec = (assets: string[], expected = sha) => {
      n += 1;
      const bin = join(temp, `bin-${n}`);
      const log = join(temp, `log-${n}`);
      const list = assets.map((a) => `'${a}'`).join(' ');
      stubCommand(
        bin,
        'gh',
        `echo "$*" >> '${log}'\nif [ "$1 $2" = "release view" ]; then printf '%s\\n' ${list}; fi`,
      );
      const result = Bun.spawnSync(['bash', '-c', run], {
        env: {
          ...spawnEnv,
          PATH: `${bin}:${spawnEnv.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_REF_NAME: 'v6.0.18',
          EXPECTED_SHA256: expected,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
      return { code: result.exitCode, calls };
    };
    const none = exec([]);
    expect(none.code).toBe(0);
    expect(none.calls).toContain(`release upload v6.0.18 ${tarball}\n`);
    expect(none.calls).toContain(`release upload v6.0.18 ${tarball}.sha256\n`);
    const onlyTarball = exec(['di-framework-platform-6.0.18.tar.gz']);
    expect(onlyTarball.code).toBe(0);
    expect(onlyTarball.calls).not.toContain(`release upload v6.0.18 ${tarball}\n`);
    expect(onlyTarball.calls).toContain(`release upload v6.0.18 ${tarball}.sha256\n`);
    const both = exec([
      'di-framework-platform-6.0.18.tar.gz',
      'di-framework-platform-6.0.18.tar.gz.sha256',
    ]);
    expect(both.code).toBe(0);
    expect(both.calls).not.toContain('release upload');
    const mismatch = exec([], '0'.repeat(64));
    expect(mismatch.code).toBe(1);
    expect(mismatch.calls).toBe('');
  });

  test('the Headlamp plugin CI job verifies the entry only on a PR that adds, edits or deletes it (#435)', () => {
    const ci = parse('.github/workflows/ci.yml').jobs['headlamp-plugin']?.steps ?? [];
    const names = ci.map((s) => s.name);
    const check = ci.find((s) => s.name === 'Check the Artifact Hub entry');
    expect(names.indexOf('Check the Artifact Hub entry')).toBe(names.indexOf('Package') + 1);
    const entry = 'platform/operator/headlamp-plugin/artifacthub/1.2.3/artifacthub-pkg.yml';
    const box = sandboxClone('plugin-entry-');
    const pkg = join(box.work, 'platform/operator/headlamp-plugin/package.json');
    mkdirSync(dirname(pkg), { recursive: true });
    writeFileSync(pkg, '{"version":"1.2.3"}\n');
    git(box.work, 'add', '-A');
    git(box.work, 'commit', '-q', '-m', 'base');
    let n = 0;
    const run = (event: string) => {
      n += 1;
      const bin = join(box.base, `bin-${n}`);
      const log = join(box.base, `log-${n}`);
      stubCommand(bin, 'bun', `echo "$*" >> '${log}'`);
      const result = Bun.spawnSync(['bash', '-c', check?.run ?? 'exit 1'], {
        cwd: box.work,
        env: { ...spawnEnv, PATH: `${bin}:${spawnEnv.PATH}`, GITHUB_EVENT_NAME: event },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
      return existsSync(log) ? readFileSync(log, 'utf8') : '';
    };
    // A plugin PR that does not add the entry.
    writeFileSync(pkg, '{"version":"1.2.3","x":1}\n');
    git(box.work, 'commit', '-q', '-am', 'plugin change');
    expect(run('pull_request')).toBe('');
    // The release PR adds the entry: verified, required.
    mkdirSync(join(box.work, dirname(entry)), { recursive: true });
    writeFileSync(join(box.work, entry), 'version: 1.2.3\n');
    git(box.work, 'add', '-A');
    git(box.work, 'commit', '-q', '-m', 'release');
    expect(run('pull_request')).toBe('scripts/artifacthub-plugin.ts verify 1.2.3 --required\n');
    expect(run('push')).toBe('');
    // A later PR that edits the plugin under the released version does not re-verify.
    writeFileSync(pkg, '{"version":"1.2.3","x":2}\n');
    git(box.work, 'commit', '-q', '-am', 'later change');
    expect(run('pull_request')).toBe('');
    // A PR that edits the released entry, or deletes it, is verified (a deleted entry fails).
    writeFileSync(join(box.work, entry), 'version: 1.2.3\n# edited\n');
    git(box.work, 'commit', '-q', '-am', 'edit entry');
    expect(run('pull_request')).toBe('scripts/artifacthub-plugin.ts verify 1.2.3 --required\n');
    git(box.work, 'rm', '-q', entry);
    git(box.work, 'commit', '-q', '-m', 'delete entry');
    expect(run('pull_request')).toBe('scripts/artifacthub-plugin.ts verify 1.2.3 --required\n');
    const deleted = Bun.spawnSync(
      ['bun', join(repo, 'scripts/artifacthub-plugin.ts'), 'verify', '1.2.3', '--required'],
      { cwd: box.work, env: spawnEnv, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(deleted.exitCode).toBe(1);
  });

  test('build smoke-tests, records the wasm sha256, packs without rebuilding pglite, uploads', () => {
    const build = runs('build');
    const smoke = build.indexOf('make -C platform/pglite-component unit smoke');
    const record = build.indexOf(
      'sha256sum platform/pglite-component/dist/di-framework-pglite.wasm',
    );
    const pack = build.indexOf('--pack "$RUNNER_TEMP/npm-packages"');
    expect(smoke).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(smoke);
    expect(pack).toBeGreaterThan(record);
    expect(build).toContain('--prebuilt @di-framework/pglite-component');
    expect(
      build.indexOf('tar -xzOf "$dir/$tarball" package/dist/di-framework-pglite.wasm'),
    ).toBeGreaterThan(pack);
    expect(build).toContain('--verify-packed "$dir"');
    expect(build).not.toMatch(/npm publish|--publish-packed/);
    const uploads = steps('build').filter((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(uploads.map((s) => s.with?.name)).toEqual(['npm-packages', 'headlamp-plugin']);
    const outputs = release.jobs.build?.outputs ?? {};
    expect(outputs.pglite_wasm_sha256).toBe('${{ steps.smoke.outputs.wasm_sha256 }}');
    expect(outputs.manifest_sha256).toBe('${{ steps.pack.outputs.manifest_sha256 }}');
  });

  test('publish builds nothing and checks both digests before publishing the tarballs', () => {
    const publish = runs('publish');
    expect(publish).not.toMatch(
      /\bmake\b|cargo|docker|bun install|bun run build|--pack |--dry-run/,
    );
    expect(uses('publish').filter((u) => u.startsWith('actions/download-artifact@'))).toHaveLength(
      1,
    );
    const verify = steps('publish').findIndex((s) => s.env?.MANIFEST_SHA256 !== undefined);
    const last = steps('publish').findIndex((s) => (s.run ?? '').includes('--publish-packed'));
    expect(verify).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(verify);
    expect(steps('publish')[verify]?.env).toMatchObject({
      MANIFEST_SHA256: '${{ needs.build.outputs.manifest_sha256 }}',
      WASM_SHA256: '${{ needs.build.outputs.pglite_wasm_sha256 }}',
    });
    expect(steps('publish')[verify]?.run).toContain('package/dist/di-framework-pglite.wasm');
  });
});

describe('Auto Tag tags a release when its PR merges instead of waiting for it (#214)', () => {
  const autoTag = parse('.github/workflows/auto-tag.yml');
  const tagSteps = autoTag.jobs.tag?.steps ?? [];
  const allRuns = Object.values(autoTag.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((s) => s.run ?? '')
    .join('\n');

  test('opens the release PR on lockfile pushes and dispatches, tags on a merged PR', () => {
    expect(autoTag.on.push).toEqual({
      branches: ['main'],
      paths: ['bun.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
    });
    expect(autoTag.on.pull_request).toEqual({
      types: ['closed'],
      branches: ['main'],
      paths: ['package.json'],
    });
    expect(autoTag.on.workflow_dispatch).toMatchObject({
      inputs: {
        bump: { type: 'choice', default: 'patch' },
        tag_only: { type: 'boolean', default: false },
      },
    });
  });

  test('tags on schedule every 30 minutes to catch auto-merged releases (#395)', () => {
    expect(autoTag.on.schedule).toEqual([{ cron: '*/30 * * * *' }]);
  });

  test('schedule runs only on the di-framework/platform repository', () => {
    const tagIf = autoTag.jobs.tag?.if ?? '';
    expect(tagIf).toContain(
      "github.event_name == 'schedule' && github.repository == 'di-framework/platform'",
    );
  });

  test('two jobs: tag, then release-pr; nothing waits for the PR to merge', () => {
    expect(Object.keys(autoTag.jobs).sort()).toEqual(['release-pr', 'tag']);
    expect(autoTag.jobs.tag?.needs).toBeUndefined();
    expect(autoTag.jobs['release-pr']?.needs).toBe('tag');
    expect(allRuns).not.toMatch(/\bsleep\b|gh pr view "\$PR"|mergedAt/);
    // A workflow-level group would let PR-close runs cancel a pending release run, and one
    // group for every tag job would let a merge run replace a pending push run.
    expect(autoTag.concurrency).toBeUndefined();
    expect(autoTag.jobs.tag).toMatchObject({
      concurrency: { group: 'auto-tag-tag-${{ github.event_name }}', 'cancel-in-progress': false },
    });
    expect(autoTag.jobs['release-pr']).toMatchObject({
      concurrency: { group: 'auto-tag', 'cancel-in-progress': false },
    });
  });

  test('tag runs only for merged same-repository release/v* PRs; release-pr never on a PR', () => {
    const tagIf = autoTag.jobs.tag?.if ?? '';
    expect(tagIf).toContain(
      "github.event_name == 'schedule' && github.repository == 'di-framework/platform'",
    );
    expect(tagIf).toContain('github.event.pull_request.merged == true');
    expect(tagIf).toContain("startsWith(github.event.pull_request.head.ref, 'release/v')");
    expect(tagIf).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    const prIf = autoTag.jobs['release-pr']?.if ?? '';
    expect(prIf).toContain("!cancelled() && needs.tag.result == 'success'");
    expect(prIf).toContain("github.event_name != 'schedule'");
    expect(prIf).toContain("(github.event_name == 'workflow_dispatch' && inputs.tag_only != true)");
    expect(prIf).toContain("github.event_name == 'push'");
    expect(prIf).toContain("!startsWith(github.event.head_commit.message, 'chore(release):')");
    expect(prIf).not.toContain('pull_request');
  });

  test('least privilege: no workflow-level scopes, each job only what it uses', () => {
    expect(autoTag.permissions).toEqual({});
    expect(autoTag.jobs.tag?.permissions).toEqual({
      contents: 'write',
      actions: 'write',
      'pull-requests': 'read',
    });
    expect(autoTag.jobs['release-pr']?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    const prRuns = (autoTag.jobs['release-pr']?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(prRuns).not.toMatch(/gh workflow run|git tag /);
  });

  test('tag pushes the tag, then dispatches release.yml on it (GITHUB_TOKEN pushes fire nothing)', () => {
    const tagRun = tagSteps.map((s) => s.run ?? '').join('\n');
    const push = tagRun.indexOf('git push origin "refs/tags/v$VERSION"');
    const dispatch = tagRun.indexOf('gh workflow run release.yml --ref "v$VERSION"');
    expect(push).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(push);
    for (const s of tagSteps.filter((s) => s.run)) {
      expect(s.env?.GH_TOKEN).toBe('${{ github.token }}');
    }
    expect(parse('.github/workflows/release.yml').on.push).toEqual({ tags: ['v*'] } as never);
  });

  test('the README says what publishes a release and how to recover', () => {
    const readme = read('README.md');
    expect(readme).toContain('Merging the release PR is what publishes a release.');
    expect(readme).toContain('If the PR was merged by a person, the tag job runs immediately');
    expect(readme).toContain('the scheduled tag job catches it within about 30 minutes');
    expect(readme).toContain('`tag_only: true`');
  });

  describe('the tag job scripts', () => {
    const REPO = 'di-framework/platform';
    const find = tagSteps.find((s) => (s.run ?? '').includes('version_at'));
    const tag = tagSteps.find((s) => (s.run ?? '').includes('gh workflow run'));

    /**
     * origin/main: a 1.0.0 commit, then `chore(release): v1.0.1 (#5)`, then `extra`.
     * The stub `gh` answers `api repos/<repo>/commits/<sha>/pulls` from `pulls-<sha>.json`,
     * `run list` from `runs.json`, and logs `workflow run`; a successful dispatch records a run,
     * and a `fail-dispatch` file makes the next dispatch fail.
     */
    function sandbox(extra?: string) {
      const box = sandboxClone('auto-tag-');
      const write = (version: string) =>
        writeFileSync(join(box.work, 'package.json'), `${JSON.stringify({ version })}\n`);
      write('1.0.0');
      git(box.work, 'add', '.');
      git(box.work, 'commit', '-qm', 'init');
      const init = git(box.work, 'rev-parse', 'HEAD');
      write('1.0.1');
      git(box.work, 'commit', '-qam', 'chore(release): v1.0.1 (#5)');
      const release = git(box.work, 'rev-parse', 'HEAD');
      if (extra) {
        writeFileSync(join(box.work, 'other'), extra);
        git(box.work, 'add', '.');
        git(box.work, 'commit', '-qm', extra);
      }
      git(box.work, 'push', '-q', 'origin', 'HEAD:main');
      const bin = join(box.base, 'bin');
      const b = box.base;
      stubCommand(
        bin,
        'gh',
        [
          'case "$1 $2" in',
          `  "api "*) sha="\${2#*/commits/}"; sha="\${sha%/pulls}"; cat "${b}/pulls-$sha.json" 2>/dev/null || echo '[]' ;;`,
          `  "run list") cat "${b}/runs.json" 2>/dev/null || echo '[]' ;;`,
          `  "workflow run") echo "$*" >> "${b}/gh.log"`,
          `    if [ -f "${b}/fail-dispatch" ]; then rm "${b}/fail-dispatch"; exit 1; fi`,
          `    echo '[{"databaseId":1}]' > "${b}/runs.json" ;;`,
          '  *) echo "unexpected gh $*" >&2; exit 2 ;;',
          'esac',
        ].join('\n'),
      );
      const result = { ...box, init, release, bin };
      pulls(result, release, [releasePr('release/v1.0.1')]);
      return result;
    }
    type Box = ReturnType<typeof sandbox>;

    function releasePr(ref: string, repo = REPO, merged = true) {
      return {
        number: 5,
        merged_at: merged ? '2026-10-14T00:00:00Z' : null,
        head: { ref, repo: { full_name: repo } },
      };
    }
    function pulls(box: { base: string }, sha: string, list: unknown[]) {
      writeFileSync(join(box.base, `pulls-${sha}.json`), JSON.stringify(list));
    }

    function step(box: Box, script: string, vars: Record<string, string>) {
      const output = join(box.base, 'out');
      writeFileSync(output, '');
      const result = Bun.spawnSync(['bash', '-c', script], {
        cwd: box.work,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...env,
          PATH: `${box.bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: join(box.base, 'summary'),
          GITHUB_REPOSITORY: REPO,
          ...vars,
        },
      });
      const out: Record<string, string> = Object.fromEntries(
        readFileSync(output, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      );
      return { exitCode: result.exitCode, out, stdout: result.stdout.toString() };
    }

    /** Both steps, as the job runs them; `between` runs after the find step. */
    function run(box: Box, vars: Record<string, string>, between?: () => void) {
      const first = step(box, find?.run ?? '', vars);
      if (first.exitCode !== 0 || !['tag', 'dispatch'].includes(first.out.action ?? '')) {
        return first;
      }
      between?.();
      const second = step(box, tag?.run ?? '', {
        ACTION: first.out.action ?? '',
        VERSION: first.out.version ?? '',
        COMMIT: first.out.commit ?? '',
      });
      return { ...second, out: first.out, stdout: first.stdout + second.stdout };
    }

    const dispatches = (box: Box) => {
      const file = join(box.base, 'gh.log');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    };
    /** The commit a remote tag points at (peeled when annotated). */
    const remoteTag = (box: Box, name: string) =>
      git(box.work, 'ls-remote', '--tags', 'origin', `refs/tags/${name}`, `refs/tags/${name}^{}`)
        .split('\n')
        .at(-1)
        ?.split('\t')[0];
    const noTags = (box: Box) => expect(git(box.work, 'ls-remote', '--tags', 'origin')).toBe('');
    const DISPATCH = 'workflow run release.yml --ref v1.0.1';

    test('a push run tags the release commit of the version on main and dispatches Release once', () => {
      const box = sandbox('fix: later work');
      const first = run(box, { EVENT: 'push' });
      expect(first.exitCode).toBe(0);
      expect(first.out.action).toBe('tag');
      expect(remoteTag(box, 'v1.0.1')).toBe(box.release);
      expect(dispatches(box)).toEqual([DISPATCH]);

      // Idempotent: the tag exists and Release ran, so a second run does nothing.
      const again = run(box, { EVENT: 'workflow_dispatch' });
      expect(again.exitCode).toBe(0);
      expect(again.out.action).toBe('none');
      expect(dispatches(box)).toEqual([DISPATCH]);
    });

    test('a merged release PR tags its merge commit', () => {
      const box = sandbox();
      const result = run(box, {
        EVENT: 'pull_request',
        HEAD_REF: 'release/v1.0.1',
        MERGE_SHA: box.release,
      });
      expect(result.exitCode).toBe(0);
      expect(remoteTag(box, 'v1.0.1')).toBe(box.release);
      expect(dispatches(box)).toEqual([DISPATCH]);
    });

    test('a failed dispatch after the tag push is retried by the next run, once', () => {
      const box = sandbox();
      writeFileSync(join(box.base, 'fail-dispatch'), '');
      const failed = run(box, {
        EVENT: 'pull_request',
        HEAD_REF: 'release/v1.0.1',
        MERGE_SHA: box.release,
      });
      expect(failed.exitCode).not.toBe(0);
      expect(remoteTag(box, 'v1.0.1')).toBe(box.release);
      expect(dispatches(box)).toEqual([DISPATCH]);

      // A re-run of the same event finds the tag at the merge commit and no Release run.
      const retry = run(box, {
        EVENT: 'pull_request',
        HEAD_REF: 'release/v1.0.1',
        MERGE_SHA: box.release,
      });
      expect(retry.exitCode).toBe(0);
      expect(retry.out.action).toBe('dispatch');
      expect(dispatches(box)).toEqual([DISPATCH, DISPATCH]);

      // Release has run now; a tag_only dispatch does nothing.
      const after = run(box, { EVENT: 'workflow_dispatch' });
      expect(after.out.action).toBe('none');
      expect(dispatches(box)).toEqual([DISPATCH, DISPATCH]);
    });

    test('losing the tag-push race exits cleanly without a second dispatch', () => {
      const box = sandbox();
      const result = run(box, { EVENT: 'push' }, () => {
        git(box.work, 'push', '-q', 'origin', `${box.release}:refs/tags/v1.0.1`);
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Tag v1.0.1 was pushed by another run; nothing to do.');
      expect(dispatches(box)).toEqual([]);
    });

    test('a tag at another commit is left alone and nothing is dispatched', () => {
      const box = sandbox();
      git(box.work, 'push', '-q', 'origin', `${box.init}:refs/tags/v1.0.1`);
      for (const vars of [
        { EVENT: 'push' } as Record<string, string>,
        { EVENT: 'pull_request', HEAD_REF: 'release/v1.0.1', MERGE_SHA: box.release },
      ]) {
        const result = run(box, vars);
        expect(result.exitCode).toBe(0);
        expect(result.out.action).toBe('none');
        expect(result.stdout).toContain(`::warning::tag v1.0.1 already exists at ${box.init}`);
      }
      expect(remoteTag(box, 'v1.0.1')).toBe(box.init);
      expect(dispatches(box)).toEqual([]);
    });

    test('a merge commit whose version does not match the branch fails without tagging', () => {
      const box = sandbox();
      const result = run(box, {
        EVENT: 'pull_request',
        HEAD_REF: 'release/v1.0.2',
        MERGE_SHA: box.release,
      });
      expect(result.exitCode).not.toBe(0);
      noTags(box);
      expect(dispatches(box)).toEqual([]);
    });

    test('a version that no release commit set is left untagged', () => {
      const box = sandbox();
      writeFileSync(join(box.work, 'package.json'), `${JSON.stringify({ version: '1.0.2' })}\n`);
      git(box.work, 'commit', '-qam', 'chore: hand-edited version');
      git(box.work, 'push', '-q', 'origin', 'HEAD:main');
      const result = run(box, { EVENT: 'push' });
      expect(result.exitCode).toBe(0);
      expect(result.out.action).toBe('none');
      noTags(box);
      expect(dispatches(box)).toEqual([]);
    });

    describe('the catch-up path tags only the merge of a same-repository release/vX PR', () => {
      const cases: [string, unknown[]][] = [
        ['no PR', []],
        ['a PR from a fork', [releasePr('release/v1.0.1', 'someone/platform')]],
        ['a PR from another branch', [releasePr('feature/v1.0.1')]],
        ['a PR for another version', [releasePr('release/v1.0.10')]],
        ['an unmerged PR', [releasePr('release/v1.0.1', REPO, false)]],
      ];
      for (const [name, list] of cases) {
        test(`not ${name}`, () => {
          const box = sandbox();
          pulls(box, box.release, list);
          const result = run(box, { EVENT: 'push' });
          expect(result.exitCode).toBe(0);
          expect(result.out.action).toBe('none');
          expect(result.stdout).toContain(
            `::warning::${box.release} is not the merge of a release/v1.0.1 PR from ${REPO}`,
          );
          noTags(box);
          expect(dispatches(box)).toEqual([]);
        });
      }

      test('not a commit whose package.json does not set the version in its title', () => {
        const box = sandbox();
        writeFileSync(join(box.work, 'other'), 'x');
        git(box.work, 'add', '.');
        git(box.work, 'commit', '-qm', 'chore(release): v1.0.2 (#7)');
        const titled = git(box.work, 'rev-parse', 'HEAD');
        pulls(box, titled, [releasePr('release/v1.0.2')]);
        writeFileSync(join(box.work, 'package.json'), `${JSON.stringify({ version: '1.0.2' })}\n`);
        git(box.work, 'commit', '-qam', 'chore: hand-edited version');
        git(box.work, 'push', '-q', 'origin', 'HEAD:main');
        const result = run(box, { EVENT: 'push' });
        expect(result.exitCode).toBe(0);
        expect(result.out.action).toBe('none');
        expect(result.stdout).toContain(
          `::warning::${titled} is titled v1.0.2, but its package.json version is '1.0.1'`,
        );
        noTags(box);
        expect(dispatches(box)).toEqual([]);
      });
    });

    test('the release commit is matched by exact version: v1.0.1 never matches v1.0.10', () => {
      const box = sandbox();
      writeFileSync(join(box.work, 'package.json'), `${JSON.stringify({ version: '1.0.10' })}\n`);
      git(box.work, 'commit', '-qam', 'chore(release): v1.0.10 (#9)');
      const v10 = git(box.work, 'rev-parse', 'HEAD');
      pulls(box, v10, [releasePr('release/v1.0.10')]);
      git(box.work, 'push', '-q', 'origin', 'HEAD:main');
      const result = run(box, { EVENT: 'push' });
      expect(result.exitCode).toBe(0);
      expect(remoteTag(box, 'v1.0.10')).toBe(v10);
      expect(git(box.work, 'ls-remote', '--tags', 'origin', 'refs/tags/v1.0.1')).toBe('');
    });

    describe('scheduled tag job', () => {
      test('a scheduled run tags an untagged release and dispatches Release once', () => {
        const box = sandbox();
        const result = run(box, { EVENT: 'schedule' });
        expect(result.exitCode).toBe(0);
        expect(result.out.action).toBe('tag');
        expect(remoteTag(box, 'v1.0.1')).toBe(box.release);
        expect(dispatches(box)).toEqual([DISPATCH]);
      });

      test('a second scheduled run exits with action=none when the tag exists and Release has run', () => {
        const box = sandbox();
        // First run tags and dispatches
        run(box, { EVENT: 'schedule' });
        expect(dispatches(box)).toEqual([DISPATCH]);

        // Second run finds the tag and Release run, does nothing
        const again = run(box, { EVENT: 'schedule' });
        expect(again.exitCode).toBe(0);
        expect(again.out.action).toBe('none');
        expect(dispatches(box)).toEqual([DISPATCH]);
      });

      test('a scheduled run with an existing Release run (even failed) exits with action=none and does not re-dispatch', () => {
        const box = sandbox();
        // First, tag the release commit so it already exists
        git(box.work, 'push', '-q', 'origin', `${box.release}:refs/tags/v1.0.1`);
        // Set up a runs.json with a failing Release run (from a previous attempt)
        writeFileSync(
          join(box.base, 'runs.json'),
          JSON.stringify([{ databaseId: 1, conclusion: 'failure' }]),
        );
        const result = run(box, { EVENT: 'schedule' });
        expect(result.exitCode).toBe(0);
        expect(result.out.action).toBe('none');
        expect(remoteTag(box, 'v1.0.1')).toBe(box.release);
        expect(dispatches(box)).toEqual([]);
      });
    });
  });
});
