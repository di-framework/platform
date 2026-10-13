import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lchown,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import type { AgentIo, PipeEnd, TreeEntry } from './run.ts';

/** Byte order, so the result never depends on the locale. */
export function byName(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Walk `root` without following links. Paths are relative and use `/`. */
async function scan(root: string): Promise<TreeEntry[]> {
  const found: TreeEntry[] = [];
  async function visit(relative: string): Promise<void> {
    const names = (await readdir(relative ? `${root}/${relative}` : root)).sort(byName);
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(`${root}/${path}`);
      const type = info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'directory'
          : info.isSymbolicLink()
            ? 'symlink'
            : 'other';
      found.push({
        path,
        type,
        size: info.size,
        mode: info.mode & 0o7777,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: info.ino,
        uid: info.uid,
        gid: info.gid,
      });
      if (type === 'directory') await visit(path);
    }
  }
  await visit('');
  return found;
}

/** Streaming sha256: a volume file can be far larger than the Job's memory. */
function hash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(digest.digest('hex')));
  });
}

function exited(child: ChildProcess, stderr: Buffer[]): Promise<number> {
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (status) => resolve(status ?? 1));
  });
}

function writeTo(stream: Writable, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function pipe(
  from: PipeEnd,
  to: PipeEnd | undefined,
  inspect: (chunk: Uint8Array) => void,
): Promise<{ code: number; stderr: string }> {
  const stderr: Buffer[] = [];
  const waits: Promise<number>[] = [];
  const children: ChildProcess[] = [];
  let source: Readable;
  if ('file' in from) {
    source = createReadStream(from.file);
  } else {
    const child = spawn(from.argv[0] ?? '', from.argv.slice(1), {
      env: { ...process.env, ...from.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    waits.push(exited(child, stderr));
    source = child.stdout as Readable;
  }
  let sink: Writable | undefined;
  let sinkDone: Promise<number> = Promise.resolve(0);
  if (to && 'file' in to) {
    const file = createWriteStream(to.file);
    sink = file;
    sinkDone = new Promise((resolve) => {
      file.on('close', () => resolve(0));
      file.on('error', () => resolve(1));
    });
  } else if (to) {
    const child = spawn(to.argv[0] ?? '', to.argv.slice(1), {
      env: { ...process.env, ...to.env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    children.push(child);
    sinkDone = exited(child, stderr);
    sink = child.stdin as Writable;
    sink.on('error', () => undefined);
  }
  let failed = 0;
  try {
    for await (const chunk of source) {
      inspect(chunk as Uint8Array);
      if (sink) await writeTo(sink, chunk as Uint8Array);
    }
  } catch (error) {
    failed = 1;
    stderr.push(Buffer.from(error instanceof Error ? error.message : String(error)));
    for (const child of children) child.kill('SIGTERM');
  }
  sink?.end();
  const codes = await Promise.all([...waits, sinkDone]);
  const code = failed || codes.find((value) => value !== 0) || 0;
  return { code, stderr: Buffer.concat(stderr).toString('utf8') };
}

export function nodeIo(): AgentIo {
  return {
    async exec(argv, opts) {
      const child = spawn(argv[0] ?? '', argv.slice(1), {
        env: { ...process.env, ...opts?.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (opts?.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const code = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status) => resolve(status ?? 1));
      });
      return {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
    },
    readFile(path) {
      return readFile(path);
    },
    writeFile(path, data) {
      return writeFile(path, data);
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
    async unlink(path) {
      await unlink(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    scan,
    hash,
    async list(path) {
      return (await readdir(path)).sort(byName);
    },
    rename(from, to) {
      return rename(from, to);
    },
    chown(path, uid, gid) {
      return lchown(path, uid, gid);
    },
    async isDirectory(path) {
      return stat(path).then(
        (info) => info.isDirectory(),
        () => false,
      );
    },
    pipe,
  };
}
