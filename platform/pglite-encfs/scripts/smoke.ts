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
 *      refused cleanly, leaving the tree byte-identical. The root probe
 *      (tests/root-probe) checks that the root reopened as `.`, `pglite/..` or
 *      through a symlink keeps the marker hidden and out of reach (#207), also
 *      through a symlink partway through a path or a chain of them (#349),
 *      while ordinary symlinks keep working.
 *   5. Power-loss torn writes (the spike's cases) keep fsynced commits.
 *   6. Rotation re-wraps every header, including encfs files fsck moved into
 *      lost+found (fragments there are left and reported), names a stub that
 *      stops it by its path from the root, resumes after a crash before the
 *      marker flips, and then refuses the old key.
 *   7. Codecs (#206). Two variants are built: the default (publishes; writes
 *      codec 2, so a rollback to it stays possible) and `write-codec-3`.
 *      - A fresh directory holds only the codec the variant writes.
 *      - A directory initialized by the published v1 build (codec 2) keeps
 *        working: the codec-3 variant reads it, writes to it, and creates
 *        codec-3 files next to the codec-2 ones.
 *      - Rollback: v1 over that mixed directory, after a clean shutdown and
 *        after an abrupt exit, must fail loudly (never start and lose
 *        commits), and the new builds then still recover every commit. The
 *        default variant also reads the mixed directory and never creates
 *        codec-3 files.
 *
 * pglite: $PGLITE_ENCFS_PGLITE_WASM, else ../pglite-component/dist (make build there).
 * v1 encfs: $PGLITE_ENCFS_V1_WASM, else fetched anonymously from ghcr.io by its
 * pinned digest (the only network access; wasmtime itself runs without one).
 * Keys are generated per run, passed to wasmtime by inherited environment
 * (never on a command line) and never printed; every log is checked for them.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { $ } from 'bun';
import { build } from './build.ts';
import { type Context, logger, RUST_TARGET, run, WASM_FILE } from './lib/env.ts';
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
/** Header byte 9; see src/header.rs. */
const CODEC_AT = 9;
const CODEC_STEALING = 2;
const CODEC_TAIL = 3;
/**
 * The v1 build (codec 2 only), as published by #201/#211: the Wasm layer of
 * ghcr.io/di-framework/pglite-encfs@sha256:46863e8bc92be13104f4be1b489f5500ba008f51f4662f382a211f7a78a5d414.
 * Do NOT sync this with the README pin: the publish bot rewrites that one to
 * the latest release, and the codec-2 and rollback tests need exactly v1.
 */
const V1_REPOSITORY = 'di-framework/pglite-encfs';
const V1_WASM_SHA256 = '041784d169d3bc1f80136af6399fc7a54d8635600c8ff02275c00a68cca274cf';
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
    const { output, code, name, signal } = await this.exec(composed, dataDir, mode, keys);
    const lines = output.split('\n');
    const found =
      typeof expected === 'string' ? lines.includes(expected) : lines.some((l) => expected.test(l));
    if (code !== 0 || !found) {
      console.error(lines.slice(-60).join('\n'));
      const why = signal ? `signal ${signal}` : `exit ${code}`;
      throw new Error(`${name}: ${why}, expected ${expected}`);
    }
    log(
      `${mode}: ${typeof expected === 'string' ? expected : lines.find((l) => expected.test(l))}`,
    );
    return output;
  }

  /** A run that must fail, loudly, and say `reason`. Returns its output. */
  async fails(
    composed: string,
    dataDir: string,
    mode: string,
    keys: Keys,
    reason: string,
    ok: RegExp,
  ): Promise<string> {
    const { output, code, name } = await this.exec(composed, dataDir, mode, keys);
    if (code === 0 || output.split('\n').some((l) => ok.test(l))) {
      console.error(output.split('\n').slice(-60).join('\n'));
      throw new Error(`${name}: expected a failure, got exit ${code} (${ok} printed)`);
    }
    if (!output.includes(reason)) {
      console.error(output.split('\n').slice(-60).join('\n'));
      throw new Error(`${name}: failed without "${reason}"`);
    }
    log(`${mode}: failed as expected ("${reason}", exit ${code})`);
    return output;
  }

  /** Run the root probe (tests/root-probe) plugged onto encfs; it must report ok. */
  async probe(composed: string, dataDir: string, keys: Keys): Promise<void> {
    const { output, code, name } = await this.exec(
      composed,
      dataDir,
      'root-probe',
      keys,
      'probe()',
    );
    if (code !== 0 || !output.includes('root-probe ok')) {
      console.error(output.split('\n').slice(-60).join('\n'));
      throw new Error(`${name}: exit ${code}, expected root-probe ok`);
    }
    log('root-probe: every descriptor and every path reaching the root keeps the marker guard');
  }

  private async exec(
    composed: string,
    dataDir: string | null,
    mode: string,
    keys: Keys,
    invoke?: string,
  ): Promise<{ output: string; code: number; name: string; signal: string | null }> {
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
    if (invoke) args.push('--invoke', invoke);
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
    return { output, code, name, signal: proc.signalCode };
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

/** Number of encrypted files per header codec id. */
async function codecCounts(dataDir: string): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const file of await regularFiles(dataDir)) {
    if (file === join(dataDir, MARKER_FILE)) continue;
    const bytes = await readFile(file);
    if (bytes.length < HEADER_LEN) continue;
    const codec = bytes[CODEC_AT] ?? -1;
    if (codec !== CODEC_STEALING && codec !== CODEC_TAIL)
      throw new Error(`${relative(dataDir, file)} has codec ${codec}`);
    counts.set(codec, (counts.get(codec) ?? 0) + 1);
  }
  return counts;
}

/** Paths (relative) of the codec-3 files in a directory. */
async function codec3Files(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const file of await regularFiles(dataDir)) {
    if (file === join(dataDir, MARKER_FILE)) continue;
    const bytes = await readFile(file);
    if (bytes.length >= HEADER_LEN && bytes[CODEC_AT] === CODEC_TAIL)
      out.push(relative(dataDir, file));
  }
  return out;
}

/** Describe a codec census, and require both codecs to be present. */
function checkCodecsMixed(counts: Map<number, number>): string {
  if (!counts.get(CODEC_STEALING) || !counts.get(CODEC_TAIL))
    throw new Error(`expected a mixed codec-2/3 directory: ${describeCodecs(counts)}`);
  return describeCodecs(counts);
}

function describeCodecs(counts: Map<number, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([codec, n]) => `${n} codec-${codec}`)
    .join(', ');
}

const FETCH_TIMEOUT_MS = 60_000;

/** GET with a per-attempt timeout and one retry; throws unless the response is ok. */
async function fetchRetry(url: string, init: RequestInit = {}): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (error) {
      last = error;
    }
    log(`fetch ${new URL(url).pathname} failed (attempt ${attempt}): ${String(last)}`);
  }
  throw new Error(`${url}: ${String(last)}`);
}

/** The v1 encfs component, checked against its pinned digest. */
async function v1Component(ctx: Context, smokeDir: string): Promise<string> {
  let bytes: Uint8Array;
  const local = ctx.env.PGLITE_ENCFS_V1_WASM;
  if (local) {
    bytes = new Uint8Array(await readFile(local));
  } else {
    const auth = await fetchRetry(`https://ghcr.io/token?scope=repository:${V1_REPOSITORY}:pull`);
    const { token } = (await auth.json()) as { token?: unknown };
    if (typeof token !== 'string' || token === '') throw new Error('ghcr.io token: none returned');
    const blob = await fetchRetry(
      `https://ghcr.io/v2/${V1_REPOSITORY}/blobs/sha256:${V1_WASM_SHA256}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== V1_WASM_SHA256)
    throw new Error(`v1 encfs is sha256:${digest}, expected sha256:${V1_WASM_SHA256}`);
  const out = join(smokeDir, 'pglite-encfs-v1.wasm');
  await writeFile(out, bytes);
  return out;
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

async function compose(
  ctx: Context,
  smokeDir: string,
  pglite: string,
  encfs: string,
  tag: string,
  writeCodec: 2 | 3,
) {
  const witOf = async (wasm: string) =>
    worldItems(await $`wasm-tools component wit ${wasm}`.text());
  const pgliteEnc = join(smokeDir, `pglite-enc-${tag}.wasm`);
  await $`wac plug --plug ${encfs} ${pglite} -o ${pgliteEnc}`;
  await $`wasm-tools validate --features all ${pgliteEnc}`;
  const problems = compositionProblems(
    await witOf(pglite),
    await witOf(encfs),
    await witOf(pgliteEnc),
  );
  if (problems.length > 0) throw new Error(`encfs does not fit pglite:\n${problems.join('\n')}`);
  const provider = await readFile(pgliteEnc);
  if (!provider.includes(CUSTOM_SECTION)) {
    throw new Error(`composed provider lacks the ${CUSTOM_SECTION} custom section`);
  }
  const marker = `codec=aes-256-xts write-codec=${writeCodec}`;
  const other = `write-codec=${writeCodec === 2 ? 3 : 2}`;
  if (!provider.includes(marker) || provider.includes(other))
    throw new Error(`composed provider (${tag}) does not advertise ${marker}`);
  log(`interfaces match pglite; ${pgliteEnc}`);

  // The pglite smoke consumer, built from its own workspace with its own toolchain file.
  const consumerTarget = join(ctx.pkgDir, 'target', 'consumer');
  await $`cargo build --locked --release --target wasm32-wasip2 -p pglite-smoke-consumer`
    .cwd(ctx.pgliteDir)
    .env({ ...ctx.env, CARGO_TARGET_DIR: consumerTarget });
  const consumer = join(consumerTarget, 'wasm32-wasip2', 'release', 'pglite-smoke-consumer.wasm');
  const composed = {
    encrypted: join(smokeDir, `encrypted-${tag}.wasm`),
    plain: join(smokeDir, `plain-${tag}.wasm`),
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
  return { ...composed, consumer };
}

/** Plug another encfs build into pglite and the consumer, as `compose` does. */
async function composeWith(smokeDir: string, pglite: string, encfs: string, consumer: string) {
  const provider = join(smokeDir, 'pglite-enc-v1.wasm');
  const out = join(smokeDir, 'encrypted-v1.wasm');
  await $`wac plug --plug ${encfs} ${pglite} -o ${provider}`;
  await $`wac plug --plug ${provider} ${consumer} -o ${out}`;
  await $`wasm-tools validate --features all ${out}`;
  return out;
}

/**
 * Build tests/root-probe and plug `encfs` into it. The probe drives encfs's
 * wasi:filesystem export directly, which pglite cannot be made to do (#207).
 */
async function composeProbe(ctx: Context, smokeDir: string, encfs: string): Promise<string> {
  const probeDir = join(ctx.pkgDir, 'tests', 'root-probe');
  const targetDir = join(ctx.pkgDir, 'target', 'root-probe');
  await $`cargo build --locked --release --target ${RUST_TARGET}`
    .cwd(probeDir)
    .env({ ...ctx.env, CARGO_TARGET_DIR: targetDir });
  const core = join(targetDir, RUST_TARGET, 'release', 'pglite_encfs_root_probe.wasm');
  const probe = join(smokeDir, 'root-probe.wasm');
  const out = join(smokeDir, 'root-probe-enc.wasm');
  await $`wasm-tools component new ${core} -o ${probe}`;
  await $`wac plug --plug ${encfs} ${probe} -o ${out}`;
  await $`wasm-tools validate --features all ${out}`;
  return out;
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
  // `encfs` (dist/) is the default build, which writes codec 2; the matrix below
  // runs on the opt-in write-codec-3 build so codec 3 stays fully covered.
  const encfs3 = await build(ctx, { writeCodec3: true, outDir: join(smokeDir, 'codec3') });
  const composedDefault = await compose(ctx, smokeDir, pglite, encfs, 'default', 2);
  const composed = await compose(ctx, smokeDir, pglite, encfs3, 'codec3', 3);
  const rootProbe = await composeProbe(ctx, smokeDir, encfs3);

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
    const fresh = await codecCounts(data);
    if (fresh.get(CODEC_TAIL) !== headers)
      throw new Error(`a fresh directory is not all codec 3: ${describeCodecs(fresh)}`);
    log(`fresh directory: ${describeCodecs(fresh)}`);

    // The default build writes codec 2 only: a deployment can roll back to it.
    const dflt = join(work, 'default');
    await mkdir(dflt);
    await h.run(composedDefault.encrypted, dflt, 'write', A, 'smoke ok');
    await h.run(composedDefault.encrypted, dflt, 'abrupt', A, 'abrupt ok');
    await h.run(composedDefault.encrypted, dflt, 'read', A, 'restart ok');
    const dfltHeaders = await assertEncrypted(dflt, keyCheckValue(keyA), raw);
    const dfltCodecs = await codecCounts(dflt);
    if (dfltCodecs.get(CODEC_STEALING) !== dfltHeaders)
      throw new Error(`the default build wrote codec 3: ${describeCodecs(dfltCodecs)}`);
    log(`default build, fresh directory: ${describeCodecs(dfltCodecs)}`);

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
    // A file this short is also what a failed header write leaves (#207).
    if (!intruded.includes('truncating it to 0 bytes is safe')) {
      throw new Error('a short file without a header was refused without operator guidance');
    }
    if (!(await readFile(autoConf)).equals(intruder))
      throw new Error('the plaintext file was changed');
    await writeFile(autoConf, savedConf);
    await h.run(enc, data, 'marker-read', A, 'marker-read ok');

    // The root reopened as `.`, `pglite/..` or through a symlink, also one
    // partway through a path or a chain of them, keeps the marker hidden and
    // out of reach (#207, #349); the probe leaves the tree as it was.
    const beforeProbe = await treeHash(data);
    await h.probe(rootProbe, data, A);
    if ((await treeHash(data)) !== beforeProbe) throw new Error('the root probe changed the tree');
    for (const dir of [data, join(data, 'pglite')]) {
      const left = (await readdir(dir)).filter((name) => name.startsWith('root-probe-'));
      if (left.length > 0) throw new Error(`the root probe left ${left.join(', ')} in ${dir}`);
    }

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

    // A stub stops a rotation, and the log names it by its path from the root:
    // relation file names repeat across databases (#207). On a copy, so the
    // partial sweep does not touch the directory rotated below.
    const stubbed = await snapshot(data, join(work, 'stubbed'));
    await writeFile(join(stubbed, 'pglite', 'data', 'base', '1', '99999'), 'stub');
    await h.fails(
      enc,
      stubbed,
      'marker-read',
      { current: keyB, previous: keyA },
      'pglite/data/base/1/99999: no encryption header; refusing',
      /^marker-read ok$/,
    );
    await rm(stubbed, { recursive: true, force: true });

    // Rotation A -> B: one start with both keys re-wraps every header, then flips the marker.
    // The root's lost+found is swept best-effort (#207): an encfs file fsck
    // reconnected there is re-wrapped, a fragment is left as it was and
    // reported, and neither aborts the rotation.
    const lostAndFound = join(data, 'lost+found');
    const fragment = join(lostAndFound, '#131073');
    const fragmentBytes = Buffer.from('fsck fragment, not an encfs file\n');
    const recovered = join(lostAndFound, '#131074');
    await mkdir(lostAndFound, { recursive: true });
    await writeFile(fragment, fragmentBytes);
    await cp(join(data, 'pglite', 'data', 'PG_VERSION'), recovered);
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
    if (!(await readFile(fragment)).equals(fragmentBytes))
      throw new Error('rotation changed a fragment in lost+found');
    if (!(await readFile(recovered)).subarray(32, 48).equals(keyCheckValue(keyB)))
      throw new Error('rotation left a recovered encfs file in lost+found under the old key');
    if (!rotated.includes('lost+found/#131073: left as it was during key rotation'))
      throw new Error('rotation did not report the fragment it left in lost+found');
    if (
      !rotated.includes(
        'left 1 entries in lost+found as they were; DI_PGLITE_KEY_PREVIOUS can be removed',
      )
    )
      throw new Error('rotation summary does not count the lost+found entries it left');
    await rm(lostAndFound, { recursive: true, force: true });
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

    // A codec-2 directory created by the published v1 build (#206 migration).
    const v1 = await composeWith(
      smokeDir,
      pglite,
      await v1Component(ctx, smokeDir),
      composed.consumer,
    );
    const legacy = join(work, 'legacy');
    await mkdir(legacy);
    await h.run(v1, legacy, 'write', A, 'smoke ok');
    await h.run(v1, legacy, 'marker-write', A, 'marker-write ok');
    const legacyHeaders = await assertEncrypted(legacy, keyCheckValue(keyA), raw);
    const before = await codecCounts(legacy);
    if (before.get(CODEC_STEALING) !== legacyHeaders)
      throw new Error(`v1 did not write codec 2 only: ${describeCodecs(before)}`);
    log(`v1 directory: ${describeCodecs(before)}`);
    // This build reads it, survives an abrupt exit, and keeps writing to it.
    await h.run(enc, legacy, 'read', A, 'restart ok');
    await h.run(enc, legacy, 'marker-read', A, 'marker-read ok');
    await h.run(enc, legacy, 'abrupt', A, 'abrupt ok');
    await h.run(enc, legacy, 'commit-a', A, 'commit-a ok');
    await h.run(enc, legacy, 'commit-b', A, 'commit-b ok');
    const ab = checkAb(await h.run(enc, legacy, 'check-ab', A, /^check-ab /));
    if (ab.a !== 1 || ab.b !== 1)
      throw new Error(`v1 directory lost commits: ${JSON.stringify(ab)}`);
    await h.run(enc, legacy, 'create-commit', A, 'create-commit ok');
    // The state right after an abrupt exit, kept for the rollback checks below.
    const abrupt = await snapshot(legacy, join(work, 'legacy-abrupt'));
    if (!/^check-fresh N=1$/m.test(await h.run(enc, legacy, 'check-fresh', A, /^check-fresh /)))
      throw new Error('v1 directory: committed row lost');
    await h.run(enc, legacy, 'marker-read', A, 'marker-read ok');
    await assertEncrypted(legacy, keyCheckValue(keyA), raw);
    const after = await codecCounts(legacy);
    if (!after.get(CODEC_STEALING) || !after.get(CODEC_TAIL))
      throw new Error(`expected codec-2 and codec-3 files side by side: ${describeCodecs(after)}`);
    log(`v1 directory after this build wrote to it: ${describeCodecs(after)}`);

    // Rollback (#206 review W2): v1 over the mixed directory must fail loudly,
    // never start, end WAL replay early and drop commits. Tried after a clean
    // shutdown and after an abrupt exit, directly on the directories (no
    // copy), then this build must still recover everything.
    const REFUSAL = 'unsupported header (format 1, codec 3)';
    const abruptBefore = checkCodecsMixed(await codecCounts(abrupt));
    await h.fails(v1, legacy, 'read', A, REFUSAL, /^restart ok$/);
    await h.fails(v1, abrupt, 'check-ab', A, REFUSAL, /^check-ab /);
    await h.fails(v1, abrupt, 'check-fresh', A, REFUSAL, /^check-fresh /);
    log(`v1 refuses the mixed directory (clean and abrupt); abrupt codecs: ${abruptBefore}`);
    for (const [label, dir] of [
      ['clean', legacy],
      ['abrupt', abrupt],
    ] as const) {
      await h.run(enc, dir, 'read', A, 'restart ok');
      const rolled = checkAb(await h.run(enc, dir, 'check-ab', A, /^check-ab /));
      if (rolled.a !== 1 || rolled.b !== 1)
        throw new Error(`${label}: commits lost after the v1 attempt: ${JSON.stringify(rolled)}`);
      if (!/^check-fresh N=1$/m.test(await h.run(enc, dir, 'check-fresh', A, /^check-fresh /)))
        throw new Error(`${label}: committed row lost after the v1 attempt`);
    }
    await rm(abrupt, { recursive: true, force: true });

    // Narrow case: one start and one abruptly stopped commit by this build on a
    // v1 directory. PostgreSQL's recovery treats a WAL read error as end of WAL,
    // so this is where v1 could silently drop commits. It does not: the start
    // rewrites replorigin_checkpoint and pg_internal.init (codec 3), and
    // PostgreSQL PANICs on reading the former before it replays any WAL.
    const narrow = join(work, 'legacy-narrow');
    await mkdir(narrow);
    await h.run(v1, narrow, 'write', A, 'smoke ok');
    await h.run(v1, narrow, 'marker-write', A, 'marker-write ok');
    await h.run(enc, narrow, 'commit-a', A, 'commit-a ok');
    const narrowCodec3 = await codec3Files(narrow);
    log(`narrow case: codec-3 files: ${narrowCodec3.join(', ') || 'none'}`);
    if (narrowCodec3.length === 0) throw new Error('the narrow case wrote no codec-3 file');
    await h.fails(v1, narrow, 'check-ab', A, REFUSAL, /^check-ab /);
    if (checkAb(await h.run(enc, narrow, 'check-ab', A, /^check-ab /)).a !== 1)
      throw new Error('narrow case: commit A lost after the v1 attempt');
    await rm(narrow, { recursive: true, force: true });

    // The default build (writes codec 2) reads the mixed directory too, keeps
    // every commit, and creates no codec-3 files.
    const mixed = await codecCounts(legacy);
    await h.run(composedDefault.encrypted, legacy, 'read', A, 'restart ok');
    await h.run(composedDefault.encrypted, legacy, 'abrupt', A, 'abrupt ok');
    await h.run(composedDefault.encrypted, legacy, 'marker-read', A, 'marker-read ok');
    const viaDefault = checkAb(
      await h.run(composedDefault.encrypted, legacy, 'check-ab', A, /^check-ab /),
    );
    if (viaDefault.a !== 1 || viaDefault.b !== 1)
      throw new Error(`default build lost commits: ${JSON.stringify(viaDefault)}`);
    const afterDefault = await codecCounts(legacy);
    if ((afterDefault.get(CODEC_TAIL) ?? 0) > (mixed.get(CODEC_TAIL) ?? 0))
      throw new Error(`the default build created codec-3 files: ${describeCodecs(afterDefault)}`);
    log(`default build over the mixed directory: ${describeCodecs(afterDefault)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  log(
    'encrypted PGlite passed: smoke, restart, ciphertext, refusals, torn writes, rotation, v1 directory',
  );
}

if (import.meta.main) await run('smoke', smoke);
