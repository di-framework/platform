import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import type { AgentIo, TreeEntry } from './run.ts';

/** Walk `root` without following links. Paths are relative and use `/`. */
async function scan(root: string): Promise<TreeEntry[]> {
  const found: TreeEntry[] = [];
  async function visit(relative: string): Promise<void> {
    const names = (await readdir(relative ? `${root}/${relative}` : root)).sort();
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
      found.push({ path, type, size: info.size, mode: info.mode & 0o7777, mtimeMs: info.mtimeMs });
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
      return (await readdir(path)).sort();
    },
    rename(from, to) {
      return rename(from, to);
    },
  };
}
