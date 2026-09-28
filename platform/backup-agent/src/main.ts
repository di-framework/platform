import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type AgentIo, type AgentRequest, parseRequest, runAgent } from './run.ts';

function nodeIo(): AgentIo {
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
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
  };
}

const parsed = parseRequest(process.env);
if (!('kind' in parsed)) {
  await writeFile(process.env.TERMINATION_LOG ?? '/dev/termination-log', JSON.stringify(parsed));
  process.exit(1);
}

process.exit(await runAgent(parsed as AgentRequest, nodeIo()));
