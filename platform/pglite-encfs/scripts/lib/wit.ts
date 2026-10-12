/** Read the root world of `wasm-tools component wit` output. */

export interface WorldItems {
  imports: string[];
  exports: string[];
}

/**
 * Top-level `import`/`export` names of the first world. Dependency packages
 * printed after it can contain more worlds; they are ignored. Inline
 * (`import x: interface { ... }`) items are rejected, as in the publisher.
 */
export function worldItems(wit: string): WorldItems {
  const items: WorldItems = { imports: [], exports: [] };
  let depth = 0;
  let inside = false;
  for (const raw of wit.split('\n')) {
    const line = raw.trim();
    if (!inside && /^world \S+ \{$/.test(line)) inside = true;
    if (!inside) continue;
    if (depth === 1) {
      const match = line.match(/^(import|export) (.+);$/);
      if (match) {
        const [, kind, name] = match as [string, 'import' | 'export', string];
        if (/[\s{]/.test(name)) throw new Error(`expected a named interface, got \`${line}\``);
        (kind === 'import' ? items.imports : items.exports).push(name);
      } else if (/^(import|export) /.test(line)) {
        throw new Error(`expected a named interface, got \`${line}\``);
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return items;
  }
  throw new Error('no complete world in WIT');
}

/** Interfaces encfs must export: everything that carries filesystem-owned resources, plus env. */
export const ENCFS_EXPORTS = [
  'wasi:io/error@0.2.9',
  'wasi:io/poll@0.2.9',
  'wasi:io/streams@0.2.9',
  'wasi:clocks/monotonic-clock@0.2.9',
  'wasi:cli/stdout@0.2.9',
  'wasi:cli/stderr@0.2.9',
  'wasi:cli/stdin@0.2.9',
  'wasi:cli/environment@0.2.9',
  'wasi:filesystem/types@0.2.9',
  'wasi:filesystem/preopens@0.2.9',
] as const;

/**
 * Problems with plugging `encfs` into `pglite`, or with the composed result.
 * Empty when the layer fits exactly: it exports {@link ENCFS_EXPORTS}, every
 * one of them is a pglite import, it imports nothing pglite does not already
 * import, and the composition keeps pglite's imports and exports unchanged.
 */
export function compositionProblems(
  pglite: WorldItems,
  encfs: WorldItems,
  composed?: WorldItems,
): string[] {
  const problems: string[] = [];
  const sorted = (list: readonly string[]) => [...list].sort();
  const same = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  if (!same(encfs.exports, ENCFS_EXPORTS)) {
    problems.push(
      `encfs exports ${sorted(encfs.exports).join(', ')}; expected ${ENCFS_EXPORTS.join(', ')}`,
    );
  }
  for (const name of encfs.exports) {
    if (!pglite.imports.includes(name))
      problems.push(`pglite does not import ${name}; rebuild encfs from its WIT`);
  }
  for (const name of encfs.imports) {
    if (!pglite.imports.includes(name))
      problems.push(`encfs imports ${name}, which pglite does not`);
  }
  if (composed) {
    if (!same(composed.imports, pglite.imports)) {
      problems.push(`composed imports ${sorted(composed.imports).join(', ')} differ from pglite's`);
    }
    if (!same(composed.exports, pglite.exports)) {
      problems.push(`composed exports ${sorted(composed.exports).join(', ')} differ from pglite's`);
    }
  }
  return problems;
}
