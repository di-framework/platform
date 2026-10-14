/** The `di-framework:pglite` package version, read from `wit/world.wit` so build guards cannot drift. */
import { join } from 'node:path';

const PACKAGE_RE = /^package\s+di-framework:pglite@(\d+\.\d+\.\d+)\s*;/m;

export function parseWitVersion(wit: string): string {
  const match = PACKAGE_RE.exec(wit);
  if (!match?.[1]) {
    throw new Error('wit/world.wit does not declare package di-framework:pglite@<version>');
  }
  return match[1];
}

export async function readWitVersion(pkgDir: string): Promise<string> {
  return parseWitVersion(await Bun.file(join(pkgDir, 'wit', 'world.wit')).text());
}

/** The versioned interface name consumers import and the provider exports. */
export function databaseInterface(version: string): string {
  return `di-framework:pglite/database@${version}`;
}

/** Whether a `wasm-tools component wit` world has an `import`/`export` line for exactly `name`. */
function hasWorldItem(wit: string, kind: 'import' | 'export', name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${kind} ${escaped};`, 'm').test(wit);
}

/**
 * Build guard: the bundled provider must export the `database` interface at the version in
 * `wit/world.wit`, and must not import sockets or the unplugged engine.
 */
export function assertProviderWit(wit: string, version: string): void {
  const database = databaseInterface(version);
  if (!hasWorldItem(wit, 'export', database)) {
    throw new Error(`component does not export ${database} (see dist/di-framework-pglite.wit)`);
  }
  if (/(^|\s)import (wasi:sockets|di-framework:pglite-engine)/m.test(wit)) {
    throw new Error('unexpected socket or unresolved engine import in bundled provider');
  }
}

/** Compose guard: after `wac plug`, the composed component must no longer import `database`. */
export function assertComposedWit(wit: string, version: string, out: string): void {
  const database = databaseInterface(version);
  if (hasWorldItem(wit, 'import', database)) {
    throw new Error(`${out} still imports ${database}; plug did not apply`);
  }
}
