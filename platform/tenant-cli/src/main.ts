#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { run } from './cli.ts';

/** The platform's URL opener; a failure only means the printed URL has to be visited by hand. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(command, { stdio: ['ignore', 'ignore', 'ignore'] }).unref();
  } catch {
    // Printed URL stays the fallback.
  }
}

/** Runs a login tool with the password on stdin and the terminal for its output. */
async function exec(command: string[], stdin: string): Promise<number> {
  try {
    const child = Bun.spawn(command, { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });
    child.stdin.write(stdin);
    await child.stdin.end();
    return await child.exited;
  } catch (error) {
    console.error(`cannot run ${command[0]}: ${(error as Error).message}`);
    return 127;
  }
}

process.exit(
  await run(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    stdin: () => readFileSync(0, 'utf8'),
    open: openBrowser,
    exec,
    env: process.env,
    cwd: process.cwd(),
  }),
);
