/**
 * engine/build-pgcrypto.sh runs inside the engine builder container. These
 * tests run it against stub SDK, OpenSSL and PostgreSQL trees to check how it
 * caches libcrypto.a: the cache must follow the OpenSSL source, the Configure
 * options and SOURCE_DATE_EPOCH, never a stale build.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileExists } from './lib/fs.ts';

const script = resolve(import.meta.dir, '..', 'engine', 'build-pgcrypto.sh');

/** Stub OpenSSL `Configure`: logs its call and writes a Makefile that copies MARKER. */
const CONFIGURE = [
  '#!/bin/sh',
  'echo "$*" >> "$DF_TEST_LOG"',
  `built=$(perl -e 'print scalar gmtime($ARGV[0])' "$SOURCE_DATE_EPOCH")`,
  'cat > Makefile <<EOF',
  'build_generated:',
  '\tmkdir -p crypto',
  `\techo '#define DATE "built on: $built UTC"' > crypto/buildinf.h`,
  'libcrypto.a:',
  '\tcp MARKER libcrypto.a',
  'EOF',
  '',
].join('\n');

async function writeExecutable(path: string, text: string): Promise<void> {
  await Bun.write(path, text);
  await chmod(path, 0o755);
}

function sh(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}: ${result.stderr.toString()}`);
}

interface Tree {
  root: string;
  env: Record<string, string>;
  prefix: string;
  log: string;
}

async function stubTree(): Promise<Tree> {
  const root = await mkdtemp(join(tmpdir(), 'df-pglite-pgcrypto-build.'));
  const dirs = {
    pgroot: join(root, 'pglite'),
    sdk: join(root, 'sdk'),
    workspace: join(root, 'ws'),
    pgsrc: join(root, 'pgsrc'),
    build: join(root, 'build'),
    pgBuild: join(root, 'pgbuild'),
    bin: join(root, 'bin'),
  };
  const upstream = join(dirs.sdk, 'wasisdk', 'upstream', 'bin');
  const src = join(dirs.pgsrc, 'contrib', 'pgcrypto');
  const out = join(dirs.build, 'contrib', 'pgcrypto');
  for (const dir of [
    dirs.pgroot,
    upstream,
    join(dirs.workspace, 'df-extensions'),
    src,
    out,
    dirs.bin,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  await Bun.write(join(dirs.pgroot, 'pgopts.sh'), 'CC_PGLITE=""\n');
  await Bun.write(join(dirs.sdk, 'wasisdk', 'wasisdk_env.sh'), '');
  for (const tool of ['clang', 'llvm-ranlib'])
    await writeExecutable(join(upstream, tool), '#!/bin/sh\n');
  // `llvm-ar rcs ARCHIVE OBJS...`
  await writeExecutable(join(upstream, 'llvm-ar'), '#!/bin/sh\n: > "$2"\n');
  await writeExecutable(join(dirs.bin, 'nproc'), '#!/bin/sh\necho 2\n');
  await Bun.write(
    join(src, 'Makefile'),
    'OBJS = \\\n\t$(WIN32RES) \\\n\tpgcrypto.o \\\n\tpx.o\n\nEXTENSION = pgcrypto\n',
  );
  await Bun.write(join(src, 'pgcrypto.control'), "module_pathname = '$libdir/pgcrypto'\n");
  await Bun.write(
    join(src, 'pgcrypto--1.3.sql'),
    "CREATE FUNCTION digest(text, text) RETURNS bytea\nAS 'MODULE_PATHNAME', 'pg_digest'\nLANGUAGE C;\n",
  );
  await Bun.write(join(out, 'Makefile'), '%.o:\n\t@touch $@\n');
  const log = join(root, 'configure.log');
  return {
    root,
    log,
    prefix: join(dirs.pgBuild, 'df-openssl'),
    env: {
      PATH: `${dirs.bin}:${process.env.PATH ?? ''}`,
      PGROOT: dirs.pgroot,
      SDKROOT: dirs.sdk,
      WORKSPACE: dirs.workspace,
      PGSRC: dirs.pgsrc,
      BUILD_PATH: dirs.build,
      PG_BUILD: dirs.pgBuild,
      SOURCE_DATE_EPOCH: '1700000000',
      DF_TEST_LOG: log,
    },
  };
}

/** Pack a stub OpenSSL release whose libcrypto.a contains `marker`. */
async function stubOpenssl(tree: Tree, marker: string): Promise<void> {
  const staging = join(tree.root, `openssl-${marker}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'include', 'openssl'), { recursive: true });
  await writeExecutable(join(staging, 'Configure'), CONFIGURE);
  await Bun.write(join(staging, 'MARKER'), marker);
  await Bun.write(join(staging, 'include', 'openssl', 'opensslv.h'), `/* ${marker} */\n`);
  sh(
    [
      'tar',
      '-czf',
      join(tree.env.WORKSPACE ?? '', 'df-extensions', 'openssl.tar.gz'),
      `openssl-${marker}`,
    ],
    tree.root,
  );
}

function runScript(tree: Tree, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(['bash', script], {
    cwd: tree.root,
    env: { ...tree.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(`build-pgcrypto.sh failed:\n${output}`);
  return output;
}

async function configureCalls(tree: Tree): Promise<number> {
  if (!(await fileExists(tree.log))) return 0;
  return (await Bun.file(tree.log).text()).split('\n').filter(Boolean).length;
}

const libcrypto = (tree: Tree): Promise<string> =>
  Bun.file(join(tree.prefix, 'lib', 'libcrypto.a')).text();

describe('build-pgcrypto.sh', () => {
  let tree: Tree;
  beforeEach(async () => {
    tree = await stubTree();
  });
  afterEach(async () => {
    await rm(tree.root, { recursive: true, force: true });
  });

  test('builds libcrypto once per OpenSSL source and records the cache key', async () => {
    await stubOpenssl(tree, '3.5.9');
    const output = runScript(tree);
    // `wc -l` pads its count on BSD userlands.
    expect(output).toMatch(/pgcrypto: +1 functions, libpgcrypto\.a \+ libcrypto\.a ready/);
    expect(await configureCalls(tree)).toBe(1);
    expect(await libcrypto(tree)).toBe('3.5.9');
    expect((await Bun.file(join(tree.prefix, 'df-cache-key')).text()).trim()).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // The Configure options are the pinned, minimal libcrypto build.
    const options = (await Bun.file(tree.log).text()).trim();
    expect(options).toStartWith('linux-generic32 --prefix=');
    expect(options).toContain('--with-rand-seed=getrandom');
    expect(options).toContain('no-module no-dso');

    // Same inputs: the cached libcrypto.a is reused.
    runScript(tree);
    expect(await configureCalls(tree)).toBe(1);

    // The generated dlsym table and the runtime files.
    const dlfcn = await Bun.file(
      join(tree.env.BUILD_PATH ?? '', 'contrib', 'pgcrypto', 'df_ext_dlfcn.c'),
    ).text();
    expect(dlfcn).toContain('{"pg_digest", (void *) pg_digest},');
    expect(await fileExists(join(tree.env.PGROOT ?? '', 'lib', 'postgresql', 'pgcrypto.so'))).toBe(
      true,
    );
  });

  test('rebuilds libcrypto when the OpenSSL source changes', async () => {
    await stubOpenssl(tree, '3.5.9');
    runScript(tree);
    await stubOpenssl(tree, '3.5.10');
    runScript(tree);
    expect(await configureCalls(tree)).toBe(2);
    expect(await libcrypto(tree)).toBe('3.5.10');
    expect(await Bun.file(join(tree.prefix, 'include', 'openssl', 'opensslv.h')).text()).toContain(
      '3.5.10',
    );
  });

  test('rebuilds libcrypto when SOURCE_DATE_EPOCH changes', async () => {
    await stubOpenssl(tree, '3.5.9');
    runScript(tree);
    runScript(tree, { SOURCE_DATE_EPOCH: '1700000001' });
    expect(await configureCalls(tree)).toBe(2);
  });

  test('rebuilds a libcrypto.a cached without a key', async () => {
    await stubOpenssl(tree, '3.5.9');
    await mkdir(join(tree.prefix, 'lib'), { recursive: true });
    await Bun.write(join(tree.prefix, 'lib', 'libcrypto.a'), 'stale');
    runScript(tree);
    expect(await configureCalls(tree)).toBe(1);
    expect(await libcrypto(tree)).toBe('3.5.9');
  });

  test('requires SOURCE_DATE_EPOCH', async () => {
    await stubOpenssl(tree, '3.5.9');
    expect(() => runScript(tree, { SOURCE_DATE_EPOCH: '' })).toThrow(
      'SOURCE_DATE_EPOCH must be set',
    );
    expect(await configureCalls(tree)).toBe(0);
  });
});
