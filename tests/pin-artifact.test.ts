import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ARTIFACTS,
  allowNatsCredentials,
  artifactFiles,
  DEFAULT_HOST_DOCS,
  DEFAULT_HOST_SOURCE,
  HOST_VARIANTS,
  NATS_CREDENTIALS_SOURCE,
  parseHostVariants,
  parsePairs,
  pinArtifact,
  pinText,
  setDefaultHostImage,
} from '../scripts/pin-artifact';
import { git, sandboxCopy, spawnEnv, stubCommand } from './helpers/spawn-env';

const repo = resolve(import.meta.dir, '..');
const env = spawnEnv;
const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER = `sha256:${'2'.repeat(64)}`;

/** A scratch copy of every file the pin script may touch. */
function copyTargets(): string {
  const root = mkdtempSync(join(tmpdir(), 'pin-artifact-'));
  const files = new Set([HOST_VARIANTS, ...Object.keys(ARTIFACTS).flatMap(artifactFiles)]);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repo, file), join(root, file));
  }
  return root;
}

describe('pinText', () => {
  const target = { file: 'x.md', ref: 'ghcr.io/di-framework/tenant-auth' };

  test('replaces a placeholder and an existing digest', () => {
    const text = [
      'image: ghcr.io/di-framework/tenant-auth@sha256:<digest from the workflow summary>',
      `old: ghcr.io/di-framework/tenant-auth@sha256:${'a'.repeat(64)}`,
      'tag: ghcr.io/di-framework/tenant-auth:latest',
    ].join('\n');
    const result = pinText(text, target, DIGEST);
    expect(result.matches).toBe(2);
    expect(result.text).toBe(
      [
        `image: ghcr.io/di-framework/tenant-auth@${DIGEST}`,
        `old: ghcr.io/di-framework/tenant-auth@${DIGEST}`,
        'tag: ghcr.io/di-framework/tenant-auth:latest',
      ].join('\n'),
    );
  });

  test('a variant ref does not match the longer variant, and linePrefix limits the lines', () => {
    const text = [
      `| \`wasi-tls\` | \`ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:${'a'.repeat(64)}\` |`,
      '| `wasi-tls-exclusive` | `ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive@sha256:<pending>` |',
      `default: ghcr.io/di-framework/wash:2.8.0-wasi-tls@sha256:${'a'.repeat(64)}`,
    ].join('\n');
    const [canonical, exclusive] = [
      ARTIFACTS['wash-wasi-tls'],
      ARTIFACTS['wash-wasi-tls-exclusive'],
    ];
    const one = pinText(text, { ...(canonical?.[0] ?? target), file: 'x' }, DIGEST);
    expect(one.matches).toBe(1);
    expect(one.text.split('\n')[1]).toContain('<pending>');
    expect(one.text.split('\n')[2]).toContain('a'.repeat(64));
    const two = pinText(text, { ...(exclusive?.[0] ?? target), file: 'x' }, OTHER);
    expect(two.matches).toBe(1);
    expect(two.text.split('\n')[0]).toContain('a'.repeat(64));
    expect(two.text.split('\n')[1]).toContain(`wasi-tls-exclusive@${OTHER}`);
  });

  test('rejects anything but a sha256 digest', () => {
    expect(() => pinText('', target, 'sha256:abc')).toThrow('not a sha256 digest');
    expect(() => pinText('', target, `sha512:${'1'.repeat(64)}`)).toThrow('not a sha256 digest');
  });
});

describe('pinArtifact against the repository files', () => {
  test.each(Object.keys(ARTIFACTS))('%s: every target matches, and a rerun is a no-op', (name) => {
    const root = copyTargets();
    const changed = pinArtifact(root, name, DIGEST);
    expect(changed.length).toBeGreaterThan(0);
    for (const file of changed) expect(readFileSync(join(root, file), 'utf8')).toContain(DIGEST);
    expect(pinArtifact(root, name, DIGEST)).toEqual([]);
    expect(pinArtifact(root, name, OTHER)).toEqual(changed);
  });

  test('the canonical host pin moves the platform default and its docs, in one edit (#346)', () => {
    const root = copyTargets();
    const read = (file: string) => readFileSync(join(root, file), 'utf8');
    const current = defaultHostImage(read(DEFAULT_HOST_SOURCE));
    const image = `ghcr.io/di-framework/wash:2.8.0-wasi-tls@${DIGEST}`;
    const docs = Object.fromEntries(DEFAULT_HOST_DOCS.map((f) => [f, read(f)]));
    const changed = pinArtifact(root, 'wash-wasi-tls', DIGEST);
    expect(changed).toContain(DEFAULT_HOST_SOURCE);
    expect(defaultHostImage(read(DEFAULT_HOST_SOURCE))).toBe(image);
    for (const [file, before] of Object.entries(docs)) {
      // Every verbatim mention of the old default now names the new one; nothing else moved.
      expect(read(file)).not.toContain(current);
      expect(read(file)).toBe(before.replaceAll(current, image));
      expect(changed).toContain(file);
    }
    expect(read('platform/tenant-host/README.md')).toContain(`| \`wasi-tls\` | \`${image}\` |`);
    // A rerun is a no-op; a later digest moves everything again.
    expect(pinArtifact(root, 'wash-wasi-tls', DIGEST)).toEqual([]);
    pinArtifact(root, 'wash-wasi-tls', OTHER);
    expect(defaultHostImage(read(DEFAULT_HOST_SOURCE))).toBe(
      `ghcr.io/di-framework/wash:2.8.0-wasi-tls@${OTHER}`,
    );
    for (const file of DEFAULT_HOST_DOCS) expect(read(file)).not.toContain(image);
  });

  test('a non-canonical host pin leaves the default alone', () => {
    const root = copyTargets();
    const before = readFileSync(join(root, DEFAULT_HOST_SOURCE), 'utf8');
    const changed = pinArtifact(root, 'wash-wasi-tls-exclusive', DIGEST);
    expect(changed).not.toContain(DEFAULT_HOST_SOURCE);
    expect(readFileSync(join(root, DEFAULT_HOST_SOURCE), 'utf8')).toBe(before);
    const readme = readFileSync(join(root, 'platform/tenant-host/README.md'), 'utf8');
    expect(readme).toContain(`\`${defaultHostImage(before)}\``);
  });

  test.each(['wash-wasi-tls', 'wash-wasi-tls-exclusive'])(
    '%s: a 0003 variant appends to the NATS credentials allowlist, keeping older entries',
    (name) => {
      const root = copyTargets();
      const read = () => readFileSync(join(root, NATS_CREDENTIALS_SOURCE), 'utf8');
      const before = allowlist(read());
      expect(before.length).toBeGreaterThan(0);
      expect(pinArtifact(root, name, DIGEST)).toContain(NATS_CREDENTIALS_SOURCE);
      expect(allowlist(read())).toEqual([...before, DIGEST]);
      expect(read()).toContain(
        `  // ghcr.io/di-framework/wash:2.8.0-${name.slice('wash-'.length)}\n  '${DIGEST}',\n];`,
      );
      // Idempotent, and a later digest is appended after it, never in its place.
      expect(pinArtifact(root, name, DIGEST)).toEqual([]);
      pinArtifact(root, name, OTHER);
      expect(allowlist(read())).toEqual([...before, DIGEST, OTHER]);
    },
  );

  test('a variant without 0003 never touches the allowlist; one without a row fails', () => {
    const root = copyTargets();
    const allow = readFileSync(join(root, NATS_CREDENTIALS_SOURCE), 'utf8');
    // The exclusive row without 0003, so the canonical row keeps it.
    const table = readFileSync(join(root, HOST_VARIANTS), 'utf8').replace(
      /^(2\.8\.0-wasi-tls-exclusive .*) 0003-nats-blobstore-credentials\.patch$/m,
      '$1',
    );
    expect(table).not.toMatch(/exclusive.*0003/);
    writeFileSync(join(root, HOST_VARIANTS), table);
    const changed = pinArtifact(root, 'wash-wasi-tls-exclusive', DIGEST);
    expect(changed).toEqual(['platform/tenant-host/README.md']);
    expect(readFileSync(join(root, NATS_CREDENTIALS_SOURCE), 'utf8')).toBe(allow);
    writeFileSync(
      join(root, HOST_VARIANTS),
      '2.8.0-wasi-tls 0003-nats-blobstore-credentials.patch\n',
    );
    expect(() => pinArtifact(root, 'wash-wasi-tls-exclusive', DIGEST)).toThrow('no row for');
  });

  test('every file a pin may rewrite is listed by artifactFiles', () => {
    const root = copyTargets();
    for (const name of Object.keys(ARTIFACTS)) {
      for (const file of pinArtifact(root, name, DIGEST)) {
        expect(artifactFiles(name), name).toContain(file);
      }
    }
    for (const targets of Object.values(ARTIFACTS)) {
      for (const t of targets) expect(t.file.startsWith('platform/platform/src/')).toBe(false);
    }
  });

  test('unknown artifacts and drifted docs fail', () => {
    const root = copyTargets();
    expect(() => pinArtifact(root, 'nope', DIGEST)).toThrow('unknown artifact');
    writeFileSync(join(root, 'platform/pglite-component/README.md'), 'no pin here\n');
    expect(() => pinArtifact(root, 'pglite-component', DIGEST)).toThrow('no ghcr.io/');
  });

  test('the CLI rewrites files under the working directory and prints them', () => {
    const root = copyTargets();
    const result = Bun.spawnSync(
      ['bun', join(repo, 'scripts/pin-artifact.ts'), 'pglite-component', DIGEST],
      { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('platform/pglite-component/README.md');
    const usage = Bun.spawnSync(['bun', join(repo, 'scripts/pin-artifact.ts')], {
      env,
      cwd: root,
      stderr: 'pipe',
    });
    expect(usage.exitCode).toBe(2);
  });
});

/** `DEFAULT_HOST_IMAGE` in a copy of platform/platform/src/index.ts. */
function defaultHostImage(source: string): string {
  const image = /export const DEFAULT_HOST_IMAGE =\s*'([^']+)'/.exec(source)?.[1];
  if (!image) throw new Error('no DEFAULT_HOST_IMAGE');
  return image;
}

/** The digests of `NATS_CREDENTIALS_HOST_IMAGE_DIGESTS`, in order. */
function allowlist(source: string): string[] {
  const start = source.indexOf('export const NATS_CREDENTIALS_HOST_IMAGE_DIGESTS');
  const list = source.slice(start, source.indexOf('\n];', start));
  return [...list.matchAll(/'(sha256:[0-9a-f]{64})'/g)].map((m) => m[1] as string);
}

describe('host variant rewrites', () => {
  test('parseHostVariants reads the table the way the publish resolver does', () => {
    expect(parseHostVariants('# c\n2.8.0-x  a.patch b.patch\n  # d\n\n2.8.0-x-y\n')).toEqual([
      { name: 'x', tag: '2.8.0-x', patches: ['a.patch', 'b.patch'], canonical: true },
      { name: 'x-y', tag: '2.8.0-x-y', patches: [], canonical: false },
    ]);
    const rows = parseHostVariants(readFileSync(join(repo, HOST_VARIANTS), 'utf8'));
    expect(rows.map((r) => `wash-${r.name}`).sort()).toEqual(
      Object.keys(ARTIFACTS)
        .filter((k) => k.startsWith('wash-'))
        .sort(),
    );
  });

  test('setDefaultHostImage replaces only the constant and reports the old value', () => {
    const text = "x\nexport const DEFAULT_HOST_IMAGE =\n  'a@sha256:1';\nconst y = 'a@sha256:1';\n";
    const result = setDefaultHostImage(text, 'b@sha256:2');
    expect(result.previous).toBe('a@sha256:1');
    expect(result.text).toBe(
      "x\nexport const DEFAULT_HOST_IMAGE =\n  'b@sha256:2';\nconst y = 'a@sha256:1';\n",
    );
    expect(() => setDefaultHostImage('nothing', 'b')).toThrow('no DEFAULT_HOST_IMAGE');
  });

  test('allowNatsCredentials appends once, keeps every entry, and fails on a missing list', () => {
    const list = (body: string) =>
      `/** doc */\nexport const NATS_CREDENTIALS_HOST_IMAGE_DIGESTS: readonly string[] = [${body}\n];\nexport const z = ['${OTHER}'];\n`;
    const old = `\n  // old\n  '${OTHER}',`;
    const once = allowNatsCredentials(list(old), DIGEST, 'label');
    expect(once).toBe(list(`${old}\n  // label\n  '${DIGEST}',`));
    expect(allowNatsCredentials(once, DIGEST, 'other label')).toBe(once);
    expect(allowNatsCredentials(once, OTHER, 'again')).toBe(once);
    // An empty list, and a digest that appears only outside the list, are still appended.
    expect(allowNatsCredentials(list(''), OTHER, 'l')).toBe(list(`\n  // l\n  '${OTHER}',`));
    expect(() => allowNatsCredentials('const x = [];', DIGEST, 'l')).toThrow('no export const');
    expect(() => allowNatsCredentials(list(''), 'sha256:nope', 'l')).toThrow('not a sha256');
  });

  test('a drifted default host doc fails rather than leaving a stale default', () => {
    const root = copyTargets();
    const doc = DEFAULT_HOST_DOCS[1] as string;
    writeFileSync(join(root, doc), 'no default here\n');
    expect(() => pinArtifact(root, 'wash-wasi-tls', DIGEST)).toThrow(
      `${doc}: does not name the default host image`,
    );
  });
});

test('parsePairs reads artifact/digest pairs', () => {
  expect(parsePairs(['a', DIGEST, 'b', OTHER])).toEqual([
    ['a', DIGEST],
    ['b', OTHER],
  ]);
  expect(() => parsePairs([])).toThrow('usage');
  expect(() => parsePairs(['a'])).toThrow('usage');
});

test('the CLI pins several artifacts in one edit', () => {
  const root = copyTargets();
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(repo, 'scripts/pin-artifact.ts'),
      'wash-wasi-tls',
      DIGEST,
      'wash-wasi-tls-exclusive',
      OTHER,
    ],
    { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().trim().split('\n').sort()).toEqual(
    [
      'platform/tenant-host/README.md',
      NATS_CREDENTIALS_SOURCE,
      DEFAULT_HOST_SOURCE,
      'platform/platform/assets/platform/README.md',
    ].sort(),
  );
  const readme = readFileSync(join(root, 'platform/tenant-host/README.md'), 'utf8');
  expect(readme).toContain(`wash:2.8.0-wasi-tls@${DIGEST}`);
  expect(readme).toContain(`wash:2.8.0-wasi-tls-exclusive@${OTHER}`);
  const allowed = allowlist(readFileSync(join(root, NATS_CREDENTIALS_SOURCE), 'utf8'));
  expect(allowed.slice(-2)).toEqual([DIGEST, OTHER]);
  expect(defaultHostImage(readFileSync(join(root, DEFAULT_HOST_SOURCE), 'utf8'))).toBe(
    `ghcr.io/di-framework/wash:2.8.0-wasi-tls@${DIGEST}`,
  );
});

interface OpenPr {
  number: number;
  headRefName: string;
  author: { login: string };
}
const botPr = (number: number, headRefName: string): OpenPr => ({
  number,
  headRefName,
  author: { login: 'app/github-actions' },
});

describe('.github/actions/open-pin-pr against a local origin', () => {
  const action = Bun.YAML.parse(
    readFileSync(join(repo, '.github/actions/open-pin-pr/action.yml'), 'utf8'),
  ) as { runs: { steps: { name: string; run?: string }[] } };
  const script = action.runs.steps.find((s) => s.name === 'Commit pins and open PR')?.run ?? '';

  /**
   * A local origin and a clone at the first commit. With `newer`, origin's main has one more
   * commit that changes that file: `src/a` is an input of the sandbox workflow (w.yml), `docs/b`
   * is not.
   */
  function sandbox(newer?: 'src/a' | 'docs/b') {
    // The history is the same for every test with the same `newer`: build it once, copy it after.
    const {
      base,
      origin,
      work,
      value: first,
    } = sandboxCopy('open-pin-pr-', newer ?? '', ({ origin, work }) => {
      cpSync(copyTargets(), work, { recursive: true });
      mkdirSync(join(work, 'scripts'));
      for (const file of ['pin-artifact.ts', 'source-check.ts']) {
        cpSync(join(repo, 'scripts', file), join(work, 'scripts', file));
      }
      writeFileSync(join(work, 'w.yml'), "on:\n  push:\n    paths:\n      - 'src/**'\n");
      mkdirSync(join(work, 'src'));
      mkdirSync(join(work, 'docs'));
      writeFileSync(join(work, 'src/a'), 'one\n');
      writeFileSync(join(work, 'docs/b'), 'one\n');
      git(work, 'add', '.');
      git(work, 'commit', '-q', '-m', 'one');
      const first = git(work, 'rev-parse', 'HEAD');
      git(work, 'push', '-q', origin, 'HEAD:main');
      if (newer) {
        writeFileSync(join(work, newer), 'two\n');
        git(work, 'commit', '-q', '-am', 'two');
        git(work, 'push', '-q', origin, 'HEAD:main');
        git(work, 'checkout', '-q', '--detach', first);
      }
      return first;
    });
    const bin = join(base, 'bin');
    // A fake gh that records its arguments. `pr list` answers from $OPEN_PRS, a JSON list of
    // {number, headRefName, author: {login}}, the way the real one does: `--head` is an exact
    // match, except that `--author` switches to search, where `--head` is a prefix match. The
    // `--jq` filter is applied with the caller's environment.
    stubCommand(
      bin,
      'gh',
      [
        `printf '%s\\n' "$*" >> "${base}/gh.log"`,
        '[[ "$1 $2" == "pr list" ]] || exit 0',
        'head="" filter="." search=false',
        'while (( $# )); do',
        '  case "$1" in',
        '    --head) head="$2"; shift ;;',
        '    --jq) filter="$2"; shift ;;',
        '    --author) search=true; shift ;;',
        '  esac',
        '  shift',
        'done',
        'jq -r --arg head "$head" --argjson search "$search" \\',
        `  '[.[] | select(if $search then (.headRefName | startswith($head)) else .headRefName == $head end)]' \\`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        '  <<<"${OPEN_PRS:-[]}" | jq -r "$filter"',
      ].join('\n'),
    );
    const run = (pins: string, event = 'push', openPrs: OpenPr[] = []) =>
      Bun.spawnSync(['bash', '-c', script], {
        cwd: work,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...env,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          GITHUB_SHA: first,
          EVENT: event,
          NAME: 'wash',
          WORKFLOW: 'w.yml',
          OPEN_PRS: JSON.stringify(openPrs),
          PINS: pins,
          GH_TOKEN: 'x',
          RUN_URL: 'https://example.invalid/run',
          RUNNER_TEMP: base,
        },
      });
    /** Pin `artifact` to `digest` on main itself, as a merged pin PR would. */
    const pinOnMain = (artifact: string, digest: string) => {
      pinArtifact(work, artifact, digest);
      git(work, 'commit', '-q', '-am', `pin ${artifact}`);
      git(work, 'push', '-q', origin, 'HEAD:main');
    };
    const ghCalls = () => {
      try {
        return readFileSync(join(base, 'gh.log'), 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    return {
      base,
      run,
      pinOnMain,
      ghCalls,
      /** A fresh checkout of the run's commit, as the next workflow run gets. */
      fresh: () => git(work, 'checkout', '-q', '-f', '--detach', first),
      branches: () => git(base, '--git-dir', origin, 'branch', '--list'),
      log: (ref: string) => git(base, '--git-dir', origin, 'log', '--format=%s', ref),
      files: (ref: string) =>
        git(base, '--git-dir', origin, 'diff', '--name-only', `${ref}~1`, ref),
    };
  }

  // Every test below gets 20 s. Each runs the real composite action (bash, two bun scripts,
  // about ten git commands and jq), some of them several times over. That is process start-up a
  // test cannot await away, and on a loaded machine it alone can approach the 5 s default.

  test('both wash variants land in one commit on one branch, bot/pin-wash (W1)', () => {
    const box = sandbox();
    const result = box.run(`wash-wasi-tls ${DIGEST}\nwash-wasi-tls-exclusive ${OTHER}\n`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.branches()).toContain('bot/pin-wash');
    expect(box.log('bot/pin-wash').split('\n')[0]).toBe(
      `chore: pin wash: wash-wasi-tls to ${DIGEST}; wash-wasi-tls-exclusive to ${OTHER}`,
    );
    // The canonical variant also moves the default; both variants carry 0003 (#346).
    expect(box.files('bot/pin-wash').split('\n').sort()).toEqual(
      [
        'platform/platform/assets/platform/README.md',
        DEFAULT_HOST_SOURCE,
        NATS_CREDENTIALS_SOURCE,
        'platform/tenant-host/README.md',
      ].sort(),
    );
    const gh = readFileSync(join(box.base, 'gh.log'), 'utf8');
    expect(gh).toContain('pr list --head bot/pin-wash');
    expect(gh).toContain('pr create --base main --head bot/pin-wash');
    const body = readFileSync(join(box.base, 'pin-pr-body.md'), 'utf8');
    expect(body).toContain('A maintainer has to approve and run this PR');
  }, 20_000);

  test('a single pin is titled "chore: pin <artifact> to <digest>"', () => {
    const box = sandbox();
    const result = box.run(`pglite-component ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.log('bot/pin-wash').split('\n')[0]).toBe(`chore: pin pglite-component to ${DIGEST}`);
  }, 20_000);

  test('an unrelated newer commit on main does not stop the pin (#173 C1)', () => {
    const box = sandbox('docs/b');
    const result = box.run(`wash-wasi-tls ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('stale=false');
    expect(box.branches()).toContain('bot/pin-wash');
  }, 20_000);

  test('newer inputs on main make a push run stale: it pins nothing and succeeds (W2)', () => {
    const box = sandbox('src/a');
    const result = box.run(`wash-wasi-tls ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('::notice::the inputs on main have changed');
    expect(box.branches()).not.toContain('bot/pin-wash');
  }, 20_000);

  test('workflow_dispatch pins even when main has newer inputs', () => {
    const box = sandbox('src/a');
    const result = box.run(`wash-wasi-tls ${DIGEST}`, 'workflow_dispatch');
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.branches()).toContain('bot/pin-wash');
  }, 20_000);

  test('main already pinned to the digest: no branch, no PR (an ordinary push stays quiet)', () => {
    const box = sandbox();
    box.pinOnMain('pglite-component', DIGEST);
    const result = box.run(`pglite-component ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain('Already pinned');
    expect(box.branches()).not.toContain('bot/pin-wash');
    // Only the read-only lookup of an open bot PR; nothing is opened, edited or closed.
    expect(box.ghCalls().filter((c) => !c.startsWith('pr list'))).toEqual([]);
    expect(box.ghCalls()).toHaveLength(1);
    expect(box.ghCalls()[0]).toStartWith('pr list --head bot/pin-wash --base main --state open');
    expect(box.ghCalls()[0]).not.toContain('--author');
  }, 20_000);

  test('main already pinned: an open pin PR for another build is closed with its branch (#173 W1)', () => {
    // "pin to B" is open; main was reverted to A, which main already pins.
    const box = sandbox();
    box.pinOnMain('pglite-component', DIGEST);
    const result = box.run(`pglite-component ${DIGEST}`, 'push', [botPr(42, 'bot/pin-wash')]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const close = box.ghCalls().filter((c) => c.startsWith('pr close'));
    expect(close).toHaveLength(1);
    expect(close[0]).toStartWith(
      'pr close 42 --delete-branch --comment Superseded: main already pins',
    );
    expect(close[0]).toContain(`pglite-component to ${DIGEST}`);
    expect(close[0]).toContain('This PR on bot/pin-wash would pin');
    expect(box.ghCalls().some((c) => /^pr (create|edit)/.test(c))).toBe(false);
  }, 20_000);

  test('main already pinned: an open pin PR that matches main is closed too, as redundant', () => {
    // Its change is already on main, so merging it is a no-op; closing keeps one open bot PR per
    // artifact at most, and the no-diff path cannot tell "matches main" from "another build"
    // without reading the PR, so it treats both the same.
    const box = sandbox();
    box.pinOnMain('pglite-component', DIGEST);
    box.run(`pglite-component ${DIGEST}`, 'push', [botPr(7, 'bot/pin-wash')]);
    expect(box.ghCalls().filter((c) => c.startsWith('pr close 7 --delete-branch'))).toHaveLength(1);
  }, 20_000);

  test('a revert re-pins the older digest over the one main has (#173 W1)', () => {
    const box = sandbox();
    box.pinOnMain('pglite-component', OTHER);
    const result = box.run(`pglite-component ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.log('bot/pin-wash').split('\n')[0]).toBe(`chore: pin pglite-component to ${DIGEST}`);
  }, 20_000);

  test('a pin PR closed unmerged is recreated by the next run', () => {
    const box = sandbox();
    expect(box.run(`pglite-component ${DIGEST}`).exitCode).toBe(0);
    box.fresh();
    // The stub reports no open PR, as after the first one was closed without merging.
    const result = box.run(`pglite-component ${DIGEST}`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.ghCalls().filter((c) => c.startsWith('pr create'))).toHaveLength(2);
  }, 20_000);

  test('a bot PR on a longer branch (bot/pin-wash-x) is neither closed nor edited', () => {
    const others = [botPr(9, 'bot/pin-wash-x')];
    const pinned = sandbox();
    pinned.pinOnMain('pglite-component', DIGEST);
    expect(pinned.run(`pglite-component ${DIGEST}`, 'push', others).exitCode).toBe(0);
    expect(pinned.ghCalls().filter((c) => !c.startsWith('pr list'))).toEqual([]);
    const fresh = sandbox();
    const result = fresh.run(`pglite-component ${DIGEST}`, 'push', others);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(fresh.ghCalls().some((c) => /^pr (edit|close) 9\b/.test(c))).toBe(false);
    expect(
      fresh.ghCalls().some((c) => c.startsWith('pr create --base main --head bot/pin-wash ')),
    ).toBe(true);
  }, 20_000);

  test('a human-authored PR on the bot branch is neither closed nor edited', () => {
    const human = [{ number: 5, headRefName: 'bot/pin-wash', author: { login: 'someone' } }];
    const box = sandbox();
    box.pinOnMain('pglite-component', DIGEST);
    expect(box.run(`pglite-component ${DIGEST}`, 'push', human).exitCode).toBe(0);
    expect(box.ghCalls().filter((c) => !c.startsWith('pr list'))).toEqual([]);
    const fresh = sandbox();
    fresh.run(`pglite-component ${DIGEST}`, 'push', human);
    expect(fresh.ghCalls().some((c) => /^pr (edit|close) 5\b/.test(c))).toBe(false);
  }, 20_000);

  test("the bot's own open PR on the branch is edited, not duplicated", () => {
    const box = sandbox();
    const result = box.run(`pglite-component ${DIGEST}`, 'push', [
      botPr(9, 'bot/pin-wash-x'),
      botPr(3, 'bot/pin-wash'),
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(box.ghCalls().some((c) => c.startsWith('pr edit 3 --title'))).toBe(true);
    expect(box.ghCalls().some((c) => c.startsWith('pr create'))).toBe(false);
  }, 20_000);

  test('an empty pin list is a no-op, and a bad digest fails before any push', () => {
    const box = sandbox();
    expect(box.run('').exitCode).toBe(0);
    expect(box.run('wash-wasi-tls sha256:nope').exitCode).toBe(1);
    expect(box.branches()).not.toContain('bot/pin-wash');
  }, 20_000);
});
