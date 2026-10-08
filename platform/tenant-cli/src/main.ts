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

process.exit(
  await run(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    stdin: () => readFileSync(0, 'utf8'),
    open: openBrowser,
    env: process.env,
    cwd: process.cwd(),
  }),
);
