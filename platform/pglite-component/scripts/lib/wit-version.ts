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
