#!/usr/bin/env bun
/**
 * Rewrite the documented digest pins of one published artifact (#172).
 *
 * The publish workflows' pin job runs this after a successful publish and opens a
 * "chore: pin <artifact> to <digest>" PR with the result. Each target is a reference
 * `<ref>@sha256:<64 hex>` or a placeholder `<ref>@sha256:<...>`; only those are touched.
 * A target that no longer matches anything is an error, so the docs cannot drift away
 * from the bot silently.
 *
 * The platform default host image (`DEFAULT_HOST_IMAGE` in platform/platform/src/index.ts)
 * is deliberately not a target: changing the default host is a reviewed decision, not a
 * side effect of a publish. Host variants only update the "Published images" table.
 *
 * Usage (from the repository root):
 *   bun scripts/pin-artifact.ts <artifact> <sha256:digest> [<artifact> <sha256:digest> ...]
 * Several pairs make one combined edit (the tenant host pins both variants in one PR).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PinTarget {
  /** Repository-relative file. */
  file: string;
  /** Reference before `@sha256:`, e.g. `ghcr.io/di-framework/tenant-auth`. */
  ref: string;
  /** Only lines starting with this are rewritten. */
  linePrefix?: string;
}

const HOST_README = 'platform/tenant-host/README.md';

export const ARTIFACTS: Record<string, PinTarget[]> = {
  'tenant-auth': [
    { file: 'platform/platform/README.md', ref: 'ghcr.io/di-framework/tenant-auth' },
    { file: 'platform/tenant-auth/README.md', ref: 'ghcr.io/di-framework/tenant-auth' },
  ],
  'oci-registry': [
    { file: 'platform/platform/README.md', ref: 'ghcr.io/di-framework/oci-registry' },
    { file: 'platform/oci-registry/README.md', ref: 'ghcr.io/di-framework/oci-registry' },
  ],
  'pglite-component': [
    { file: 'platform/pglite-component/README.md', ref: 'ghcr.io/di-framework/pglite-component' },
  ],
  'wash-wasi-tls': [
    {
      file: HOST_README,
      ref: 'ghcr.io/di-framework/wash:2.8.0-wasi-tls',
      linePrefix: '| `wasi-tls` |',
    },
  ],
  'wash-wasi-tls-exclusive': [
    {
      file: HOST_README,
      ref: 'ghcr.io/di-framework/wash:2.8.0-wasi-tls-exclusive',
      linePrefix: '| `wasi-tls-exclusive` |',
    },
  ],
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rewrite one target in `text`; returns the new text and how many references matched. */
export function pinText(
  text: string,
  target: PinTarget,
  digest: string,
): { text: string; matches: number } {
  if (!DIGEST.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
  // The ref is followed directly by `@`, so `wash:2.8.0-wasi-tls` never matches `...-exclusive`.
  const pattern = new RegExp(`${escapeRegExp(target.ref)}@sha256:(?:[0-9a-f]{64}|<[^>\\n]*>)`, 'g');
  let matches = 0;
  const lines = text.split('\n').map((line) => {
    if (target.linePrefix !== undefined && !line.startsWith(target.linePrefix)) return line;
    return line.replace(pattern, () => {
      matches++;
      return `${target.ref}@${digest}`;
    });
  });
  return { text: lines.join('\n'), matches };
}

/** Apply every target of `artifact` under `root`; returns the files whose content changed. */
export function pinArtifact(root: string, artifact: string, digest: string): string[] {
  const targets = ARTIFACTS[artifact];
  if (!targets) {
    throw new Error(`unknown artifact ${artifact}; expected one of ${Object.keys(ARTIFACTS)}`);
  }
  const changed: string[] = [];
  for (const target of targets) {
    const path = join(root, target.file);
    const before = readFileSync(path, 'utf8');
    const { text, matches } = pinText(before, target, digest);
    if (matches === 0) throw new Error(`${target.file}: no ${target.ref}@sha256 pin found`);
    if (text !== before) {
      writeFileSync(path, text);
      if (!changed.includes(target.file)) changed.push(target.file);
    }
  }
  return changed;
}

/** `[artifact, digest, artifact, digest, ...]` to pairs. */
export function parsePairs(argv: string[]): [string, string][] {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new Error('usage: bun scripts/pin-artifact.ts <artifact> <sha256:digest> [...]');
  }
  const pairs: [string, string][] = [];
  for (let i = 0; i < argv.length; i += 2) pairs.push([argv[i] as string, argv[i + 1] as string]);
  return pairs;
}

if (import.meta.main) {
  let pairs: [string, string][];
  try {
    pairs = parsePairs(Bun.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const changed = new Set<string>();
  for (const [artifact, digest] of pairs) {
    for (const file of pinArtifact(process.cwd(), artifact, digest)) changed.add(file);
  }
  for (const file of changed) console.log(file);
}
