#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { run } from './cli.ts';

process.exit(
  await run(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    stdin: () => readFileSync(0, 'utf8'),
    env: process.env,
    cwd: process.cwd(),
  }),
);
