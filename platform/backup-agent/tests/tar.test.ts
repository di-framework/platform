import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byName, nodeIo } from '../src/io.ts';
import { type AgentRequest, runAgent } from '../src/run.ts';
import { type TarEntry, TarReader } from '../src/tar.ts';
import { chunkSize } from '../src/volume.ts';

interface Header {
  name?: string;
  type?: string;
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  prefix?: string;
  ustar?: boolean;
  /** Write the size in GNU base-256. */
  binarySize?: boolean;
  corrupt?: boolean;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

/** One header block, as tar writes it. */
function header(fields: Header): Buffer {
  const block = Buffer.alloc(512);
  block.write(fields.name ?? '', 0, 100, 'utf8');
  block.write(octal(fields.mode ?? 0o644, 8), 100, 'ascii');
  block.write(octal(fields.uid ?? 65532, 8), 108, 'ascii');
  block.write(octal(fields.gid ?? 65532, 8), 116, 'ascii');
  if (fields.binarySize) {
    block[124] = 0x80;
    block.writeUIntBE(fields.size ?? 0, 124 + 6, 6);
  } else {
    block.write(octal(fields.size ?? 0, 12), 124, 'ascii');
  }
  block.write(octal(0, 12), 136, 'ascii');
  block.write(fields.type ?? '0', 156, 'ascii');
  if (fields.ustar !== false) {
    block.write('ustar\0', 257, 'ascii');
    block.write('00', 263, 'ascii');
    block.write(fields.prefix ?? '', 345, 155, 'utf8');
  } else {
    block.write('ustar  \0', 257, 'ascii');
  }
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(fields.corrupt ? sum + 1 : sum, 7), 148, 'ascii');
  block[155] = 0x20;
  return block;
}

function body(content: Buffer): Buffer {
  return Buffer.concat([content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

function pax(records: Record<string, string>): Buffer {
  return Buffer.from(
    Object.entries(records)
      .map(([key, value]) => {
        const line = ` ${key}=${value}\n`;
        let length = line.length + 1;
        while (`${length}${line}`.length !== length) length += 1;
        return `${length}${line}`;
      })
      .join(''),
  );
}

const END = Buffer.alloc(1024);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function read(archive: Buffer, hashing = true, chunk = archive.length) {
  const reader = new TarReader(hashing);
  for (let offset = 0; offset < archive.length; offset += chunk) {
    reader.push(archive.subarray(offset, offset + chunk));
  }
  return reader.finish();
}

describe('tar reader', () => {
  test('reads ustar, GNU long names, and pax headers, and hashes file content', () => {
    const long = `deep/${'a'.repeat(120)}/file`;
    const content = Buffer.from('hello volume');
    const archive = Buffer.concat([
      header({ name: './', type: '5', mode: 0o755 }),
      header({ name: './dir/', type: '5', mode: 0o700, uid: 0, gid: 0 }),
      header({ name: 'file', prefix: 'dir', size: content.length, mode: 0o600 }),
      body(content),
      header({ name: '././@LongLink', type: 'L', size: long.length + 1, ustar: false }),
      body(Buffer.from(`${long}\0`)),
      header({ name: 'truncated', size: 3, ustar: false }),
      body(Buffer.from('abc')),
      header({
        name: 'PaxHeader',
        type: 'x',
        size: pax({ path: 'pax/name', uid: '7', gid: '8' }).length,
      }),
      body(pax({ path: 'pax/name', uid: '7', gid: '8' })),
      header({ name: 'short', size: 0 }),
      header({ name: 'global', type: 'g', size: pax({ comment: 'x' }).length }),
      body(pax({ comment: 'x' })),
      header({ name: 'link', type: '2' }),
      header({ name: 'big', size: 1, binarySize: true }),
      body(Buffer.from('z')),
      END,
      Buffer.alloc(512, 9), // trailing record padding is ignored
    ]);
    const expected: TarEntry[] = [
      { path: 'dir', type: 'directory', size: 0, mode: 0o700, uid: 0, gid: 0 },
      {
        path: 'dir/file',
        type: 'file',
        size: content.length,
        mode: 0o600,
        uid: 65532,
        gid: 65532,
        sha256: sha(content),
      },
      {
        path: long,
        type: 'file',
        size: 3,
        mode: 0o644,
        uid: 65532,
        gid: 65532,
        sha256: sha(Buffer.from('abc')),
      },
      {
        path: 'pax/name',
        type: 'file',
        size: 0,
        mode: 0o644,
        uid: 7,
        gid: 8,
        sha256: sha(Buffer.alloc(0)),
      },
      { path: 'link', type: 'other', size: 0, mode: 0o644, uid: 65532, gid: 65532 },
      {
        path: 'big',
        type: 'file',
        size: 1,
        mode: 0o644,
        uid: 65532,
        gid: 65532,
        sha256: sha(Buffer.from('z')),
      },
    ];
    expect(read(archive)).toEqual(expected);
    // The same result whatever the chunking.
    for (const size of [1, 7, 511, 513]) expect(read(archive, true, size)).toEqual(expected);
    expect(read(archive, false).every((entry) => entry.sha256 === undefined)).toBe(true);
  });

  test('a pax size decides how many bytes follow', () => {
    const content = Buffer.from('0123456789');
    const records = pax({ size: String(content.length) });
    const archive = Buffer.concat([
      header({ name: 'x', type: 'x', size: records.length }),
      body(records),
      header({ name: 'sized', size: 0 }),
      body(content),
      END,
    ]);
    expect(read(archive)).toEqual([
      expect.objectContaining({ path: 'sized', size: 10, sha256: sha(content) }),
    ]);
  });

  test('refuses corrupt or cut-short archives', () => {
    const bad = (archive: Buffer) => () => read(archive);
    expect(bad(Buffer.concat([header({ name: 'a', corrupt: true }), END]))).toThrow(
      'ArchiveInvalid',
    );
    const nonOctal = header({ name: 'a' });
    nonOctal.write('99999999999\0', 124, 'ascii');
    expect(bad(nonOctal)).toThrow('ArchiveInvalid');
    expect(bad(header({ name: 'a', size: 5 }))).toThrow('ArchiveInvalid');
    expect(bad(Buffer.concat([header({ name: 'a', size: 5 }), Buffer.from('ab')]))).toThrow(
      'ArchiveInvalid',
    );
    expect(bad(Buffer.alloc(100))).toThrow('ArchiveInvalid');
    const junk = Buffer.from('x y=z\n');
    expect(
      bad(Buffer.concat([header({ name: 'x', type: 'x', size: junk.length }), body(junk), END])),
    ).toThrow('ArchiveInvalid');
    const huge = pax({ size: '-1' });
    expect(
      bad(
        Buffer.concat([
          header({ name: 'x', type: 'x', size: huge.length }),
          body(huge),
          header({ name: 'n' }),
          END,
        ]),
      ),
    ).toThrow('ArchiveInvalid');
    // Records without a space or `=` are skipped, not trusted.
    const odd = Buffer.from('8 novalu');
    expect(
      read(
        Buffer.concat([
          header({ name: 'x', type: 'x', size: odd.length + 3 }),
          body(Buffer.concat([odd, Buffer.from('end')])),
          header({ name: 'kept' }),
          END,
        ]),
      ).map((entry) => entry.path),
    ).toEqual(['kept']);
  });
});

describe('node io pipe, ownership, and placement', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pipe-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('streams a command or a file into a command, a file, or nowhere', async () => {
    const io = nodeIo();
    const seen: number[] = [];
    const inspect = (chunk: Uint8Array) => seen.push(chunk.length);
    const out = join(dir, 'out');
    expect(await io.pipe({ argv: ['printf', 'abc'] }, { file: out }, inspect)).toEqual({
      code: 0,
      stderr: '',
    });
    expect(await readFile(out, 'utf8')).toBe('abc');
    const copy = join(dir, 'copy');
    expect(
      (await io.pipe({ file: out }, { argv: ['sh', '-c', `cat > "${copy}"`] }, inspect)).code,
    ).toBe(0);
    expect(await readFile(copy, 'utf8')).toBe('abc');
    expect((await io.pipe({ file: out }, undefined, inspect)).code).toBe(0);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(9);

    // Failures: the source, the sink, a missing tool, a missing file, and the inspector.
    expect((await io.pipe({ argv: ['sh', '-c', 'echo x; exit 3'] }, undefined, inspect)).code).toBe(
      3,
    );
    const sink = await io.pipe(
      { argv: ['sh', '-c', 'yes | head -c 1000000'] },
      { argv: ['sh', '-c', 'exit 5'] },
      inspect,
    );
    expect(sink.code).not.toBe(0);
    expect((await io.pipe({ argv: ['/nonexistent/tool'] }, undefined, inspect)).code).not.toBe(0);
    expect((await io.pipe({ file: join(dir, 'absent') }, undefined, inspect)).code).toBe(1);
    const thrown = await io.pipe({ argv: ['printf', 'abc'] }, undefined, () => {
      throw new Error('ArchiveInvalid');
    });
    expect(thrown).toMatchObject({ code: 1, stderr: 'ArchiveInvalid' });
    const thrownFile = await io.pipe({ argv: ['printf', 'abc'] }, { file: join(dir, 'x') }, () => {
      throw 'plain';
    });
    expect(thrownFile.code).toBe(1);
    expect(
      (
        await io.pipe(
          { argv: ['printf', 'abc'] },
          { file: join(dir, 'no', 'such', 'dir') },
          inspect,
        )
      ).code,
    ).not.toBe(0);
  });

  test('chowns without following links, tells directories, and sorts by byte order', async () => {
    const io = nodeIo();
    await writeFile(join(dir, 'f'), 'x');
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    await io.chown(join(dir, 'f'), uid, gid);
    expect(await io.isDirectory(dir)).toBe(true);
    expect(await io.isDirectory(join(dir, 'f'))).toBe(false);
    expect(await io.isDirectory(join(dir, 'absent'))).toBe(false);
    expect(['b', 'B', 'a', 'a'].sort(byName)).toEqual(['B', 'a', 'a', 'b']);
  });

  test('the placement probe checks every path is a directory on this node', async () => {
    const termination = join(dir, 'termination');
    const probe = (probePaths: string | undefined) =>
      runAgent(
        {
          kind: 'probe-placement',
          host: '',
          port: '',
          bucket: '',
          prefix: '',
          workdir: dir,
          terminationLog: termination,
          gcKeys: '',
          endpoint: '',
          region: '',
          pgUser: '',
          pgDatabase: '',
          probePaths,
        } satisfies AgentRequest,
        nodeIo(),
      );
    await mkdir(join(dir, 'claim'));
    expect(await probe(`${dir}:${join(dir, 'claim')}`)).toBe(0);
    expect(JSON.parse(await readFile(termination, 'utf8'))).toEqual({
      ok: true,
      tool: 'probe',
      format: 'placement',
    });
    expect(await probe(`${dir}:${join(dir, 'missing')}`)).toBe(1);
    expect(JSON.parse(await readFile(termination, 'utf8'))).toEqual({
      ok: false,
      error: 'PlacementInvalid',
    });
    expect(await probe(undefined)).toBe(1);
  });

  test('picks an S3 part size that fits any volume in 10,000 parts', () => {
    const tree = (bytes: number, files = 1) => ({
      files: Array.from({ length: files }, (_, i) => ({
        path: `f${i}`,
        type: 'file' as const,
        size: bytes / files,
        mode: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        ino: i,
        uid: 0,
        gid: 0,
      })),
      directories: [],
    });
    expect(chunkSize(tree(1024))).toBe('5Mi');
    expect(chunkSize(tree(40 * 1024 ** 3))).toBe('5Mi');
    expect(chunkSize(tree(100 * 1024 ** 3, 4))).toBe('12Mi');
    expect(chunkSize(tree(1024 ** 4))).toBe('117Mi');
  });
});
