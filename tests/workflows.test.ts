// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the assertions match literal GitHub Actions `${{ }}` and shell `${VAR}` text.
/**
 * The GHCR publish workflows publish by themselves when their inputs change on main (#172):
 * triggers and paths, the skip-if-published gate, least-privilege permissions, and the pin job.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ARTIFACTS } from '../scripts/pin-artifact';
import { matchesPathFilter, pushPaths } from '../scripts/source-check';
import { spawnEnv } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const env = spawnEnv;

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
  pinIf: string;
  /** The job that re-points moving tags when the source is already published (a revert). */
  realign?: { job: string; tags: string; wit?: string };
  /** bot/pin-<pinName> */
  pinName: string;
  artifacts: string[];
  /** The job that moves mutable tags, and its steps that the source guard gates. */
  guarded: { job: string; steps: string[] };
}

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
    pinIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && github.ref == 'refs/heads/main' && ((needs.publish-index.result == 'success' && needs.publish-index.outputs.digest != '') || (needs.check-source.outputs.skip == 'true' && needs.check-source.outputs.stale != 'true' && needs.check-source.outputs.digest != '')) }}",
    pinName: 'tenant-auth',
    guarded: { job: 'publish-index', steps: ['Assemble and verify image index'] },
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
    publish: ['publish', 'realign'],
    readOnly: ['build'],
    realign: { job: 'realign', tags: 'wit', wit: 'platform/pglite-component/wit/world.wit' },
    pinAfter: 'publish',
    pinIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && github.ref == 'refs/heads/main' && ((needs.publish.result == 'success' && needs.publish.outputs.digest != '') || (needs.check-source.outputs.skip == 'true' && needs.check-source.outputs.stale != 'true' && needs.check-source.outputs.digest != '')) }}",
    pinName: 'pglite-component',
    guarded: {
      job: 'publish',
      steps: [
        'Push and verify component',
        'Record component digest',
        'Tag with source hash',
        'Upload publish report',
      ],
    },
    artifacts: ['pglite-component'],
  },
  {
    file: '.github/workflows/pglite-encfs-publish.yml',
    image: 'ghcr.io/di-framework/pglite-encfs',
    paths: [
      'platform/pglite-encfs/**',
      'platform/wasm-component-publisher/**',
      'Cargo.toml',
      'Cargo.lock',
      '.cargo/**',
      '.github/workflows/pglite-encfs-publish.yml',
      '!**/*.md',
    ],
    first: 'build',
    firstIf: CHECKED,
    publish: ['publish', 'realign'],
    readOnly: ['build'],
    realign: { job: 'realign', tags: 'wit', wit: 'platform/pglite-encfs/wit/world.wit' },
    pinAfter: 'publish',
    pinIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && github.ref == 'refs/heads/main' && ((needs.publish.result == 'success' && needs.publish.outputs.digest != '') || (needs.check-source.outputs.skip == 'true' && needs.check-source.outputs.stale != 'true' && needs.check-source.outputs.digest != '')) }}",
    pinName: 'pglite-encfs',
    guarded: {
      job: 'publish',
      steps: [
        'Push and verify component',
        'Record component digest',
        'Tag with source hash',
        'Upload publish report',
      ],
    },
    artifacts: ['pglite-encfs'],
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
    pinIf:
      "${{ !cancelled() && needs.check-source.result == 'success' && github.ref == 'refs/heads/main' && ((needs.publish.result == 'success' && needs.publish.outputs.digest != '') || (needs.check-source.outputs.skip == 'true' && needs.check-source.outputs.stale != 'true' && needs.check-source.outputs.digest != '')) }}",
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
  let checked = 0;
  for (const spec of SPECS) {
    for (const [name, job] of Object.entries(parse(spec.file).jobs)) {
      const steps = (job.steps ?? []) as { uses?: string; run?: string; name?: string }[];
      // check-source runs oras inside scripts/source-check.ts.
      const usesOras = steps.some(
        (s) =>
          /(^|[\s|(])oras\s/m.test(s.run ?? '') ||
          /scripts\/(source-check\.ts|wash-pins\.sh)/.test(s.run ?? ''),
      );
      if (!usesOras) continue;
      checked++;
      const first = steps.findIndex(
        (s) =>
          !installs(s) &&
          (/(^|[\s|(])oras\s/m.test(s.run ?? '') ||
            /scripts\/(source-check\.ts|wash-pins\.sh)/.test(s.run ?? '')),
      );
      const setup = steps.findIndex(installs);
      expect(setup, `${spec.file} ${name}`).toBeGreaterThanOrEqual(0);
      expect(setup, `${spec.file} ${name}`).toBeLessThan(first);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(7);
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
  for (const file of ['variants', '0002-insecure-registry-allowlist.patch']) {
    expect(matchesPathFilter(filter, `platform/tenant-host/${file}`), file).toBe(true);
  }
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
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'bun'),
      `#!/bin/sh\necho "hash=${'a'.repeat(64)}"\n${answer}\necho "args=$*" >> "${dir}/bun.log"\n`,
    );
    chmodSync(join(bin, 'bun'), 0o755);
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

  test('a stale re-run of build leaves the buildcache tags alone (S1)', () => {
    const steps = (workflow.jobs.build?.steps ?? []) as {
      name?: string;
      uses?: string;
      if?: string;
    }[];
    const guard = steps.findIndex((s) => s.uses === './.github/actions/source-guard');
    expect(guard).toBeGreaterThanOrEqual(0);
    for (const name of [
      'Log in to GHCR',
      'Build and push by digest',
      'Export digest',
      'Upload digest',
    ]) {
      const index = steps.findIndex((s) => s.name === name);
      expect(index, name).toBeGreaterThan(guard);
      expect(steps[index]?.if, name).toBe("steps.guard.outputs.stale != 'true'");
    }
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
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'oras'),
      [
        '#!/bin/sh',
        'ref="$4"',
        'for tag in $PUBLISHED; do',
        '  case "$ref" in *":$tag") echo "{\\"digest\\":\\"sha256:$(printf %064d 0 | tr 0 "${tag#src-}" | cut -c1-64)\\"}"; exit 0 ;; esac',
        'done',
        'echo "Error: $ref: not found" >&2; exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, 'oras'), 0o755);
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

  test('build, publish and github-release run in that order', () => {
    expect(Object.keys(release.jobs).sort()).toEqual(['build', 'github-release', 'publish']);
    expect(release.jobs.publish?.needs).toBe('build');
    expect(release.jobs['github-release']?.needs).toBe('publish');
    expect(release.jobs['github-release']?.if).toBe("github.ref_type == 'tag'");
  });

  test('only publish holds an OIDC token, only github-release can write contents', () => {
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.build?.permissions).toEqual({ contents: 'read' });
    expect(release.jobs.publish?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(release.jobs['github-release']?.permissions).toEqual({ contents: 'write' });
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
    expect(uses('build').filter((u) => u.startsWith('actions/upload-artifact@'))).toHaveLength(1);
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
