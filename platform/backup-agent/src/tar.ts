import { createHash, type Hash } from 'node:crypto';

/**
 * A streaming reader for the tar archives of workload volumes (#232). It sees every byte the
 * archive holds as it passes through, so a backup's manifest hashes are the archived bytes
 * (read once, not hashed and then archived), and a restore can list an archive before a single
 * byte of it is extracted. ustar, GNU (long names) and pax (path, size, uid, gid) headers are
 * understood; any member other than a regular file or a directory is reported as `other`.
 */

export interface TarEntry {
  /** Relative, `/`-separated, without a leading `./` or a trailing `/`. */
  path: string;
  type: 'file' | 'directory' | 'other';
  size: number;
  mode: number;
  uid: number;
  gid: number;
  /** Hex sha256 of a file's content, when the reader hashes. */
  sha256?: string;
}

const BLOCK = 512;

function text(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString('utf8');
}

/** Octal digits, or GNU base-256 when the high bit of the first byte is set. */
function numeric(block: Uint8Array, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    let value = (field[0] ?? 0) & 0x7f;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + (field[i] ?? 0);
    return value;
  }
  const digits = text(block, start, length).trim();
  if (!/^[0-7]*$/.test(digits)) throw new Error('ArchiveInvalid');
  return digits ? Number.parseInt(digits, 8) : 0;
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  return sum === numeric(block, 148, 8);
}

function normalize(path: string): string {
  return path.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function paxRecords(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(Buffer.from(data.subarray(offset, space)).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0) throw new Error('ArchiveInvalid');
    const record = Buffer.from(data.subarray(space + 1, offset + length - 1)).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

type Pending = { kind: 'entry'; entry: TarEntry; hash?: Hash } | { kind: 'meta'; flag: string };

export class TarReader {
  readonly entries: TarEntry[] = [];
  private header = new Uint8Array(BLOCK);
  private filled = 0;
  private remaining = 0;
  private padding = 0;
  private pending: Pending | undefined;
  private meta: Uint8Array[] = [];
  private longName: string | undefined;
  private pax: Record<string, string> = {};
  private ended = false;

  constructor(private readonly hashing = false) {}

  /** Feed the next bytes of the archive. Throws `ArchiveInvalid` on a malformed header. */
  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.ended) return;
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - offset);
        this.content(chunk.subarray(offset, offset + take));
        this.remaining -= take;
        offset += take;
        if (this.remaining === 0) this.close();
        continue;
      }
      if (this.padding > 0) {
        const skip = Math.min(this.padding, chunk.length - offset);
        this.padding -= skip;
        offset += skip;
        continue;
      }
      const take = Math.min(BLOCK - this.filled, chunk.length - offset);
      this.header.set(chunk.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === BLOCK) {
        this.filled = 0;
        this.begin(this.header);
      }
    }
  }

  /** The archive ended properly: an end-of-archive block, nothing cut off. */
  finish(): TarEntry[] {
    if (!this.ended || this.remaining > 0 || this.pending) throw new Error('ArchiveInvalid');
    return this.entries;
  }

  private content(bytes: Uint8Array): void {
    const pending = this.pending;
    if (pending?.kind === 'entry') pending.hash?.update(bytes);
    else if (pending?.kind === 'meta') this.meta.push(Uint8Array.from(bytes));
  }

  private begin(block: Uint8Array): void {
    if (block.every((byte) => byte === 0)) {
      this.ended = true;
      return;
    }
    if (!checksumOk(block)) throw new Error('ArchiveInvalid');
    const flag = String.fromCharCode(block[156] ?? 0);
    const meta = flag === 'L' || flag === 'x' || flag === 'g' || flag === 'K';
    // A pax `size` replaces the header's, which cannot hold more than 8 GiB in octal.
    const size =
      !meta && this.pax.size !== undefined ? Number(this.pax.size) : numeric(block, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('ArchiveInvalid');
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (meta) {
      this.pending = { kind: 'meta', flag };
      this.meta = [];
    } else {
      const ustar = text(block, 257, 6) === 'ustar';
      const prefix = ustar ? text(block, 345, 155) : '';
      const name =
        this.pax.path ?? this.longName ?? (prefix ? `${prefix}/` : '') + text(block, 0, 100);
      const type = flag === '0' || flag === '\0' ? 'file' : flag === '5' ? 'directory' : 'other';
      const entry: TarEntry = {
        path: normalize(name),
        type,
        size,
        mode: numeric(block, 100, 8) & 0o7777,
        uid: this.pax.uid !== undefined ? Number(this.pax.uid) : numeric(block, 108, 8),
        gid: this.pax.gid !== undefined ? Number(this.pax.gid) : numeric(block, 116, 8),
      };
      this.longName = undefined;
      this.pax = {};
      this.pending = {
        kind: 'entry',
        entry,
        ...(this.hashing && type === 'file' ? { hash: createHash('sha256') } : {}),
      };
    }
    if (this.remaining === 0) this.close();
  }

  private close(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending?.kind === 'meta') {
      const data = Buffer.concat(this.meta);
      if (pending.flag === 'L') this.longName = text(data, 0, data.length);
      else if (pending.flag === 'x') this.pax = paxRecords(data);
      return;
    }
    if (!pending) return;
    const { entry, hash } = pending;
    if (entry.path) this.entries.push(hash ? { ...entry, sha256: hash.digest('hex') } : entry);
  }
}
