/**
 * `make smoke`: compose encfs with the pglite wasm and the pglite smoke
 * consumer and run the encryption matrix under wasmtime, with no networking.
 *
 *   1. Interfaces: encfs exports exactly the WASI names pglite imports, and the
 *      composed provider keeps pglite's imports and exports.
 *   2. initdb + the smoke suite, restart, abrupt-exit restart, more data.
 *   3. Only ciphertext on disk: every file carries a header under the key's
 *      KCV, and no plaintext row, catalog or config string (present in a
 *      plaintext control directory) or key material appears.
 *   4. Wrong, missing and invalid keys and a legacy plaintext directory are
 *      refused cleanly, leaving the tree byte-identical.
 *   5. Power-loss torn writes (the spike's cases) keep fsynced commits.
 *   6. Rotation re-wraps every header, resumes after a crash before the
 *      marker flips, and then refuses the old key.
 *
 * pglite: $PGLITE_ENCFS_PGLITE_WASM, else ../pglite-component/dist (make build there).
 * Keys are generated per run, passed to wasmtime by inherited environment
 * (never on a command line) and never printed; every log is checked for them.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { $ } from 'bun';
import { build } from './build.ts';
import { type Context, logger, run, WASM_FILE } from './lib/env.ts';
import { tearFirstRewrite, tearLastWrite } from './lib/tear.ts';
import { compositionProblems, worldItems } from './lib/wit.ts';

const log = logger('smoke');

/** Upper bound for one wasmtime run; a wedged guest fails the build instead of hanging CI. */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const HEADER_LEN = 4096;
const FILE_MAGIC = 'DIPGENC1';
const MARKER_FILE = '.di-encfs';
const MARKER_MAGIC = 'DIPGKEY1';
const CUSTOM_SECTION = 'di-framework:pglite-encfs';
/** Inserted by the consumer's marker-write mode. */
const ROW_MARKER = 'PGLITE-SMOKE-PLAINTEXT-MARKER';
/** Plaintext that the smoke suite, initdb and postgresql.conf put on disk. */
const PLAINTEXT_PROBES = [ROW_MARKER, 'Hello World', 'max_connections', 'pg_catalog'];

interface Keys {
  current?: string;
  previous?: string;
}

/** Key-check value, as derived by src/keys.rs. */
export function keyCheckValue(base64Key: string): Buffer {
  // Node's base64 decoder accepts both alphabets, like the component.
  const master = Buffer.from(base64Key, 'base64');
  return Buffer.from(hkdfSync('sha256', master, 'di-framework/encfs/v1', 'key-check-value', 16));
}

async function regularFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Hash of every path and its content: proves a refused start changed nothing. */
async function treeHash(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await regularFiles(root)) {
    hash
      .update(relative(root, file))
      .update('\0')
      .update(await readFile(file))
      .update('\0');
  }
  return hash.digest('hex');
}

class Harness {
  private runs = 0;

  constructor(
    private readonly ctx: Context,
    private readonly logDir: string,
    private readonly secrets: string[],
  ) {}

  /** Run one consumer mode; returns its output (stdout + stderr). */
  async run(
    composed: string,
    dataDir: string | null,
    mode: string,
    keys: Keys,
    expected: string | RegExp,
  ): Promise<string> {
    const args = ['wasmtime', 'run'];
    if (dataDir) args.push('--dir', `${dataDir}::/data`);
    args.push('--env', `PGLITE_SMOKE_MODE=${mode}`);
    const env = { ...this.ctx.env };
    delete env.DI_PGLITE_KEY;
    delete env.DI_PGLITE_KEY_PREVIOUS;
    if (keys.current !== undefined) {
      env.DI_PGLITE_KEY = keys.current;
      args.push('--env', 'DI_PGLITE_KEY');
    }
    if (keys.previous !== undefined) {
      env.DI_PGLITE_KEY_PREVIOUS = keys.previous;
      args.push('--env', 'DI_PGLITE_KEY_PREVIOUS');
    }
    args.push(composed);
    const proc = Bun.spawn(args, { env, stdout: 'pipe', stderr: 'pipe', timeout: RUN_TIMEOUT_MS });
    const [stdout, stderr, code] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ]);
    const output = `${stdout}${stderr}`;
    const name = `${String(++this.runs).padStart(2, '0')}-${mode}.log`;
    await Bun.write(join(this.logDir, name), output);
    for (const secret of this.secrets) {
      if (output.includes(secret)) throw new Error(`${name}: key material in the output`);
    }
    const lines = output.split('\n');
    const found =
      typeof expected === 'string' ? lines.includes(expected) : lines.some((l) => expected.test(l));
    if (code !== 0 || !found) {
      console.error(lines.slice(-60).join('\n'));
      const why = proc.signalCode ? `signal ${proc.signalCode}` : `exit ${code}`;
      throw new Error(`${name}: ${why}, expected ${expected}`);
    }
    log(
      `${mode}: ${typeof expected === 'string' ? expected : lines.find((l) => expected.test(l))}`,
    );
    return output;
  }

  /** A start that must be refused before anything on disk changes. */
  async refused(composed: string, dataDir: string, keys: Keys, reason: string): Promise<void> {
    const before = await treeHash(dataDir);
    const output = await this.run(composed, dataDir, 'refused', keys, 'refused ok');
    if (!output.includes(reason)) throw new Error(`refusal did not say "${reason}"`);
    if ((await treeHash(dataDir)) !== before)
      throw new Error('a refused start changed the data directory');
  }
}

/** Every non-empty file carries a header under `kcv`; nothing is plaintext. */
async function assertEncrypted(dataDir: string, kcv: Buffer, secrets: Buffer[]): Promise<number> {
  const marker = await readFile(join(dataDir, MARKER_FILE));
  if (!marker.equals(Buffer.concat([Buffer.from(MARKER_MAGIC), kcv]))) {
    throw new Error('root marker does not hold the key check value');
  }
  let headers = 0;
  for (const file of await regularFiles(dataDir)) {
    if (file === join(dataDir, MARKER_FILE)) continue;
    const bytes = await readFile(file);
    for (const probe of [...PLAINTEXT_PROBES.map((p) => Buffer.from(p)), ...secrets]) {
      if (bytes.includes(probe))
        throw new Error(`${relative(dataDir, file)} contains plaintext or key material`);
    }
    if (bytes.length === 0) continue;
    if (bytes.length < HEADER_LEN || bytes.subarray(0, 8).toString() !== FILE_MAGIC) {
      throw new Error(`${relative(dataDir, file)} has no encryption header`);
    }
    if (!bytes.subarray(32, 48).equals(kcv))
      throw new Error(`${relative(dataDir, file)} is wrapped under another key`);
    headers++;
  }
  return headers;
}

/** The control: the same workload without encfs leaves every probe on disk. */
async function assertPlaintextProbes(dataDir: string): Promise<void> {
  const contents = await Promise.all((await regularFiles(dataDir)).map((f) => readFile(f)));
  for (const probe of PLAINTEXT_PROBES) {
    if (!contents.some((bytes) => bytes.includes(probe))) {
      throw new Error(
        `control: "${probe}" is not on disk without encryption; the ciphertext check would be vacuous`,
      );
    }
  }
}

/** Copy `from` into a fresh `to`. */
async function snapshot(from: string, to: string): Promise<string> {
  await rm(to, { recursive: true, force: true });
  await cp(from, to, { recursive: true });
  return to;
}

/** Apply a tear to the files matching `pattern` that differ between the snapshots. */
async function tear(
  before: string,
  after: string,
  out: string,
  pattern: RegExp,
  kind: 'last' | 'first',
): Promise<string> {
  await snapshot(kind === 'last' ? after : before, out);
  for (const file of await regularFiles(after)) {
    const rel = relative(after, file);
    if (!pattern.test(rel)) continue;
    const [a, b] = await Promise.all([
      readFile(join(before, rel)).catch(() => null),
      readFile(file),
    ]);
    if (!a) continue;
    const torn =
      kind === 'last' ? tearLastWrite(a, b, HEADER_LEN) : tearFirstRewrite(a, b, HEADER_LEN);
    if (!torn) continue;
    await writeFile(join(out, rel), torn.bytes);
    return `${rel} page [${torn.page.join(', ')}) torn at ${torn.tearAt}`;
  }
  throw new Error(`no changed file matches ${pattern}`);
}

function checkAb(output: string): { a: number; b: number } {
  const match = /^check-ab A=(\d+) B=(\d+)$/m.exec(output);
  if (!match) throw new Error('no check-ab result');
  return { a: Number(match[1]), b: Number(match[2]) };
}

async function compose(ctx: Context, smokeDir: string, pglite: string, encfs: string) {
  const witOf = async (wasm: string) =>
    worldItems(await $`wasm-tools component wit ${wasm}`.text());
  const pgliteEnc = join(smokeDir, 'pglite-enc.wasm');
  await $`wac plug --plug ${encfs} ${pglite} -o ${pgliteEnc}`;
  await $`wasm-tools validate --features all ${pgliteEnc}`;
  const problems = compositionProblems(
    await witOf(pglite),
    await witOf(encfs),
    await witOf(pgliteEnc),
  );
  if (problems.length > 0) throw new Error(`encfs does not fit pglite:\n${problems.join('\n')}`);
  if (!(await readFile(pgliteEnc)).includes(CUSTOM_SECTION)) {
    throw new Error(`composed provider lacks the ${CUSTOM_SECTION} custom section`);
  }
  log(`interfaces match pglite; ${pgliteEnc}`);

  // The pglite smoke consumer, built from its own workspace with its own toolchain file.
  const consumerTarget = join(ctx.pkgDir, 'target', 'consumer');
  await $`cargo build --locked --release --target wasm32-wasip2 -p pglite-smoke-consumer`
    .cwd(ctx.pgliteDir)
    .env({ ...ctx.env, CARGO_TARGET_DIR: consumerTarget });
  const consumer = join(consumerTarget, 'wasm32-wasip2', 'release', 'pglite-smoke-consumer.wasm');
  const composed = {
    encrypted: join(smokeDir, 'encrypted.wasm'),
    plain: join(smokeDir, 'plain.wasm'),
  };
  for (const [out, provider] of [
    [composed.encrypted, pgliteEnc],
    [composed.plain, pglite],
  ] as const) {
    await $`wac plug --plug ${provider} ${consumer} -o ${out}`;
    await $`wasm-tools validate --features all ${out}`;
    const { imports } = await witOf(out);
    if (imports.some((i) => !i.startsWith('wasi:') || i.startsWith('wasi:sockets'))) {
      throw new Error(`${out} imports ${imports.join(', ')}`);
    }
  }
  return composed;
}

export async function smoke(ctx: Context): Promise<void> {
  for (const tool of ['wasmtime', 'wac', 'wasm-tools']) {
    if (!Bun.which(tool, { PATH: ctx.env.PATH })) throw new Error(`${tool} not found on PATH`);
  }
  const pglite =
    ctx.env.PGLITE_ENCFS_PGLITE_WASM ?? join(ctx.pgliteDir, 'dist', 'di-framework-pglite.wasm');
  if (!(await Bun.file(pglite).exists())) {
    throw new Error(
      `pglite component not found: ${pglite} (run make -C ../pglite-component build)`,
    );
  }
  const encfs = join(ctx.pkgDir, 'dist', WASM_FILE);
  if (!(await Bun.file(encfs).exists())) await build(ctx);

  const smokeDir = join(ctx.pkgDir, 'target', 'smoke');
  await rm(smokeDir, { recursive: true, force: true });
  const logDir = join(smokeDir, 'logs');
  await mkdir(logDir, { recursive: true });
  const composed = await compose(ctx, smokeDir, pglite, encfs);

  // Standard base64 for A, unpadded base64url for B: both alphabets are accepted.
  const rawA = randomBytes(32);
  const rawB = randomBytes(32);
  const keyA = rawA.toString('base64');
  const keyB = rawB.toString('base64url');
  const secrets = [keyA, keyB, rawA.toString('hex'), rawB.toString('hex')];
  const h = new Harness(ctx, logDir, secrets);
  const enc = composed.encrypted;
  const A = { current: keyA };
  const B = { current: keyB };

  const work = await mkdtemp(join(tmpdir(), 'df-pglite-encfs-smoke.'));
  try {
    const data = join(work, 'data');
    const plain = join(work, 'plain');
    await mkdir(data);
    await mkdir(plain);

    // Control: the same workload without encryption leaves the probes on disk.
    await h.run(composed.plain, plain, 'write', {}, 'smoke ok');
    await h.run(composed.plain, plain, 'marker-write', {}, 'marker-write ok');
    await assertPlaintextProbes(plain);

    // initdb, the full smoke suite, restart and abrupt-exit restart, encrypted.
    await h.run(enc, null, 'no-mount', A, 'no mount ok');
    // A crash during the first start could leave an empty marker (#201 review W3):
    // an otherwise empty root is initialized again, not refused as corrupt.
    await writeFile(join(data, MARKER_FILE), '');
    await h.run(enc, data, 'write', A, 'smoke ok');
    if (await Bun.file(join(data, `${MARKER_FILE}.tmp`)).exists()) {
      throw new Error('marker temp file left behind');
    }
    for (const file of ['PG_VERSION', join('global', 'pg_control')]) {
      if (!(await Bun.file(join(data, 'pglite', 'data', file)).exists()))
        throw new Error(`${file} missing`);
    }
    await h.run(enc, data, 'read', A, 'restart ok');
    await h.run(enc, data, 'abrupt', A, 'abrupt ok');
    await h.run(enc, data, 'read', A, 'restart ok');
    await h.run(enc, data, 'marker-write', A, 'marker-write ok');
    await h.run(enc, data, 'marker-read', A, 'marker-read ok');

    // Only ciphertext on disk.
    const raw = [rawA, rawB, ...secrets.map((s) => Buffer.from(s))];
    const headers = await assertEncrypted(data, keyCheckValue(keyA), raw);
    if (headers < 100) throw new Error(`only ${headers} encrypted files; expected a whole cluster`);
    log(`${headers} files encrypted under key A; no plaintext probe or key material on disk`);

    // Refusals leave the tree byte-identical.
    await h.refused(enc, data, B, 'encrypted with a different key');
    await h.refused(enc, data, {}, 'DI_PGLITE_KEY is not set or invalid');
    await h.refused(
      enc,
      data,
      { current: 'AAAA' },
      'DI_PGLITE_KEY must be base64 of exactly 32 bytes',
    );
    await h.refused(enc, data, { current: 'not base64!' }, 'DI_PGLITE_KEY is not valid base64');
    await h.run(enc, data, 'marker-read', A, 'marker-read ok');
    // A plaintext directory is refused, not migrated or mixed.
    await h.refused(enc, plain, A, 'no encryption marker');

    // A plaintext file inside an encrypted directory is refused, never read or
    // rewritten. postgresql.auto.conf is optional, so PostgreSQL logs the I/O
    // error and starts without it.
    const autoConf = join(data, 'pglite', 'data', 'postgresql.auto.conf');
    const savedConf = await readFile(autoConf);
    const intruder = Buffer.from('# plaintext dropped into an encrypted directory\n');
    await writeFile(autoConf, intruder);
    const intruded = await h.run(enc, data, 'marker-read', A, 'marker-read ok');
    if (!intruded.includes('postgresql.auto.conf: no encryption header; refusing')) {
      throw new Error('a plaintext file was not refused');
    }
    if (!(await readFile(autoConf)).equals(intruder))
      throw new Error('the plaintext file was changed');
    await writeFile(autoConf, savedConf);
    await h.run(enc, data, 'marker-read', A, 'marker-read ok');

    // A crash while creating a file (#201 review W1): the new relation files'
    // size is durable but their header is not (zeroed, or cut short). They hold
    // no data, so they are re-sealed and WAL redo rebuilds the table.
    const beforeCreate = new Set(await regularFiles(data));
    await h.run(enc, data, 'create-commit', A, 'create-commit ok');
    const created = (await regularFiles(data)).filter(
      (f) => !beforeCreate.has(f) && /\/pglite\/data\/base\//.test(f),
    );
    if (created.length === 0) throw new Error('create-commit made no relation file');
    const afterCreate = await snapshot(data, join(work, 'after-create'));
    for (const [length, label] of [
      [HEADER_LEN, 'zeroed header'],
      [100, 'short header'],
    ] as const) {
      const crashed = await snapshot(afterCreate, join(work, 'crashed-create'));
      for (const file of created)
        await writeFile(join(crashed, relative(data, file)), new Uint8Array(length));
      const result = await h.run(enc, crashed, 'check-fresh', A, /^check-fresh /);
      if (!/^check-fresh N=1$/m.test(result))
        throw new Error(`${label}: committed row lost after redo`);
      log(`crash during file creation (${label}, ${created.length} files): redo ok`);
      await rm(crashed, { recursive: true, force: true });
    }
    await rm(afterCreate, { recursive: true, force: true });

    // Power-loss torn writes after two fsynced, never-checkpointed commits.
    await h.run(enc, data, 'commit-a', A, 'commit-a ok');
    const s1 = await snapshot(data, join(work, 's1'));
    await h.run(enc, data, 'commit-b', A, 'commit-b ok');
    const s2 = await snapshot(data, join(work, 's2'));
    const intact = checkAb(await h.run(enc, data, 'check-ab', A, /^check-ab /));
    if (intact.a !== 1 || intact.b !== 1)
      throw new Error(`abrupt commits lost: ${JSON.stringify(intact)}`);
    const cases = [
      { name: 'last WAL write torn', pattern: /^pglite\/data\/pg_wal\/0/, kind: 'last' },
      {
        name: 'WAL page holding commit A torn',
        pattern: /^pglite\/data\/pg_wal\/0/,
        kind: 'first',
      },
      {
        name: 'pg_control rewrite torn',
        pattern: /^pglite\/data\/global\/pg_control$/,
        kind: 'last',
      },
    ] as const;
    for (const [i, c] of cases.entries()) {
      const out = join(work, `torn-${i}`);
      log(`${c.name}: ${await tear(s1, s2, out, c.pattern, c.kind)}`);
      const result = checkAb(await h.run(enc, out, 'check-ab', A, /^check-ab /));
      if (result.a !== 1)
        throw new Error(`${c.name}: fsynced commit A lost (${JSON.stringify(result)})`);
      await rm(out, { recursive: true, force: true });
    }
    await rm(s1, { recursive: true, force: true });
    await rm(s2, { recursive: true, force: true });

    // Rotation A -> B: one start with both keys re-wraps every header, then flips the marker.
    const rotated = await h.run(
      enc,
      data,
      'marker-read',
      { current: keyB, previous: keyA },
      'marker-read ok',
    );
    const count = Number(/re-wrapped (\d+) file keys/.exec(rotated)?.[1] ?? -1);
    if (count < headers)
      throw new Error(`rotation re-wrapped ${count} of at least ${headers} files`);
    const afterRotation = await assertEncrypted(data, keyCheckValue(keyB), raw);
    log(`rotation re-wrapped ${count} file keys; ${afterRotation} headers now under key B`);
    await h.run(enc, data, 'marker-read', B, 'marker-read ok');
    await h.refused(enc, data, A, 'encrypted with a different key');
    // A crash after the sweep but before the marker flip: the next start resumes and finishes.
    await writeFile(
      join(data, MARKER_FILE),
      Buffer.concat([Buffer.from(MARKER_MAGIC), keyCheckValue(keyA)]),
    );
    const resumed = await h.run(
      enc,
      data,
      'marker-read',
      { current: keyB, previous: keyA },
      'marker-read ok',
    );
    if (!/re-wrapped 0 file keys/.test(resumed))
      throw new Error('resumed rotation re-wrapped headers twice');
    await assertEncrypted(data, keyCheckValue(keyB), raw);
    await h.run(enc, data, 'read', B, 'restart ok');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  log('encrypted PGlite passed: smoke, restart, ciphertext, refusals, torn writes, rotation');
}

if (import.meta.main) await run('smoke', smoke);
