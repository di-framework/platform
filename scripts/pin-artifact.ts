#!/usr/bin/env bun
/**
 * Rewrite the documented digest pins of one published artifact (#172).
 *
 * The publish workflows' pin job runs this after a successful publish and opens a
 * "chore: pin <artifact> to <digest>" PR with the result. Each target is a reference
 * `<ref>@sha256:<64 hex>` or a placeholder `<ref>@sha256:<...>` (or, for a `bare` target such as the
 * operator chart's `image.digest`, a lone `sha256:` digest on its `linePrefix` line); only those are touched.
 * A target that no longer matches anything is an error, so the docs cannot drift away
 * from the bot silently.
 *
 * Tenant host variants (`wash-<variant>`, rows of platform/tenant-host/variants) also update
 * the platform code that names host builds (#346), as read from that table:
 *   - every variant whose patch set includes 0003 appends its digest to
 *     `NATS_CREDENTIALS_HOST_IMAGE_DIGESTS` (platform/platform/src/tenancy/registry-nats.ts).
 *     Older entries stay: existing installs may still run those builds.
 *   - the canonical variant (the table's first row) moves `DEFAULT_HOST_IMAGE`
 *     (platform/platform/src/index.ts) and every verbatim mention of the old default in
 *     {@link DEFAULT_HOST_DOCS}.
 *
 * Each tenant-auth pin also appends its digest to `API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS`
 * (platform/platform/src/tenant-auth-images.ts, #379): every build from #379 on reads API keys
 * from `di-apikeys-<tenant>`, and the platform moves keys there only under a listed build.
 * Rerunning with the same digests changes nothing.
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
  /**
   * The digest stands alone (`digest: sha256:...`), not after `<ref>@`; `ref` only names the
   * target in errors. Requires `linePrefix`, which anchors it to one line.
   */
  bare?: boolean;
}

/** The operator chart's values; its `image.digest` is a bare digest line. */
export const OPERATOR_CHART_VALUES = 'platform/operator/chart/values.yaml';

const HOST_README = 'platform/tenant-host/README.md';
/** The tenant host image tag -> patch set table; its first row is the canonical tag. */
export const HOST_VARIANTS = 'platform/tenant-host/variants';
export const HOST_IMAGE = 'ghcr.io/di-framework/wash';
/** Holds `DEFAULT_HOST_IMAGE`, the platform default `tenantHostImage`. */
export const DEFAULT_HOST_SOURCE = 'platform/platform/src/index.ts';
/** Docs that quote `DEFAULT_HOST_IMAGE` verbatim; each mention follows the default. */
export const DEFAULT_HOST_DOCS = [HOST_README, 'platform/platform/assets/platform/README.md'];
/** Holds `NATS_CREDENTIALS_HOST_IMAGE_DIGESTS`, the host builds known to carry patch 0003. */
export const NATS_CREDENTIALS_SOURCE = 'platform/platform/src/tenancy/registry-nats.ts';
export const NATS_CREDENTIALS_PATCH = '0003-nats-blobstore-credentials.patch';
const NATS_CREDENTIALS_LIST = 'export const NATS_CREDENTIALS_HOST_IMAGE_DIGESTS';
/** Holds `API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS`, the tenant-auth builds that read `di-apikeys-*`. */
export const API_KEY_NAMESPACE_SOURCE = 'platform/platform/src/tenant-auth-images.ts';
const API_KEY_NAMESPACE_LIST = 'export const API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS';
export const TENANT_AUTH_IMAGE = 'ghcr.io/di-framework/tenant-auth';

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
  'pglite-encfs': [
    { file: 'platform/pglite-encfs/README.md', ref: 'ghcr.io/di-framework/pglite-encfs' },
  ],
  'platform-operator': [
    { file: 'platform/operator/README.md', ref: 'ghcr.io/di-framework/platform-operator' },
    {
      file: OPERATOR_CHART_VALUES,
      ref: 'ghcr.io/di-framework/platform-operator',
      linePrefix: '  digest: ',
      bare: true,
    },
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
  const prefix = target.bare ? '' : `${escapeRegExp(target.ref)}@`;
  const pattern = new RegExp(`${prefix}sha256:(?:[0-9a-f]{64}|<[^>\\n]*>)`, 'g');
  const pinned = target.bare ? digest : `${target.ref}@${digest}`;
  let matches = 0;
  const lines = text.split('\n').map((line) => {
    if (target.linePrefix !== undefined && !line.startsWith(target.linePrefix)) return line;
    return line.replace(pattern, () => {
      matches++;
      return pinned;
    });
  });
  return { text: lines.join('\n'), matches };
}

export interface HostVariant {
  /** The `wash-<name>` artifact suffix: the tag without its wash version, e.g. `wasi-tls`. */
  name: string;
  /** Image tag (IMAGE_VERSION), e.g. `2.8.0-wasi-tls`. */
  tag: string;
  /** WASH_PATCHES, in order. */
  patches: string[];
  /** The first row: the tag `DEFAULT_HOST_IMAGE` is pinned to. */
  canonical: boolean;
}

/** Rows of {@link HOST_VARIANTS}, read the way the publish workflow's resolver reads them. */
export function parseHostVariants(text: string): HostVariant[] {
  return text
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([tag]) => tag !== undefined && tag !== '' && !tag.startsWith('#'))
    .map(([tag = '', ...patches], i) => ({
      name: tag.slice(tag.indexOf('-') + 1),
      tag,
      patches,
      canonical: i === 0,
    }));
}

/** The variant a `wash-<name>` artifact pins, or undefined for any other artifact. */
export function hostVariant(root: string, artifact: string): HostVariant | undefined {
  if (!artifact.startsWith('wash-')) return undefined;
  const name = artifact.slice('wash-'.length);
  const variant = parseHostVariants(readFileSync(join(root, HOST_VARIANTS), 'utf8')).find(
    (v) => v.name === name,
  );
  if (!variant) throw new Error(`${HOST_VARIANTS}: no row for ${artifact}`);
  return variant;
}

/** Point `DEFAULT_HOST_IMAGE` in `text` at `image`; returns the image it named before. */
export function setDefaultHostImage(
  text: string,
  image: string,
): { text: string; previous: string } {
  const pattern = /(export const DEFAULT_HOST_IMAGE =\s*')([^'\n]+)(')/;
  const previous = pattern.exec(text)?.[2];
  if (previous === undefined) throw new Error(`${DEFAULT_HOST_SOURCE}: no DEFAULT_HOST_IMAGE`);
  return {
    text: text.replace(pattern, (_, open, _old, close) => `${open}${image}${close}`),
    previous,
  };
}

/**
 * Append `digest` to `NATS_CREDENTIALS_HOST_IMAGE_DIGESTS` in `text`, after a `// <label>`
 * comment. A digest already listed is left alone, and no entry is ever removed.
 */
export function allowNatsCredentials(text: string, digest: string, label: string): string {
  return allowDigest(text, NATS_CREDENTIALS_SOURCE, NATS_CREDENTIALS_LIST, digest, label);
}

/**
 * Append `digest` to `API_KEY_NAMESPACE_TENANT_AUTH_DIGESTS` in `text` (#379), after a `// <label>`
 * comment. A digest already listed is left alone, and no entry is ever removed.
 */
export function allowApiKeyNamespace(text: string, digest: string, label: string): string {
  return allowDigest(text, API_KEY_NAMESPACE_SOURCE, API_KEY_NAMESPACE_LIST, digest, label);
}

/**
 * Append `digest` to the `readonly string[]` literal that `list` declares in `text`, which is
 * either multi-line (`[` ... `\n];`) or still empty (`[];`).
 */
function allowDigest(
  text: string,
  file: string,
  list: string,
  digest: string,
  label: string,
): string {
  if (!DIGEST.test(digest)) throw new Error(`not a sha256 digest: ${digest}`);
  const start = text.indexOf(list);
  // The literal, not the `readonly string[]` annotation before it.
  const assign = start < 0 ? -1 : text.indexOf('= [', start + list.length);
  const open = assign < 0 ? -1 : assign + 2;
  if (open < 0) throw new Error(`${file}: no ${list} list`);
  const entry = `\n  // ${label}\n  '${digest}',`;
  if (text.startsWith('[];', open))
    return `${text.slice(0, open + 1)}${entry}\n${text.slice(open + 1)}`;
  const close = text.indexOf('\n];', open);
  if (close < 0) throw new Error(`${file}: no ${list} list`);
  if (text.slice(open, close).includes(`'${digest}'`)) return text;
  return `${text.slice(0, close)}${entry}${text.slice(close)}`;
}

/** Every file `artifact` may rewrite (relative to the repository root). */
export function artifactFiles(artifact: string): string[] {
  const files = (ARTIFACTS[artifact] ?? []).map((t) => t.file);
  if (artifact.startsWith('wash-')) {
    files.push(NATS_CREDENTIALS_SOURCE, DEFAULT_HOST_SOURCE, ...DEFAULT_HOST_DOCS);
  }
  if (artifact === 'tenant-auth') files.push(API_KEY_NAMESPACE_SOURCE);
  return [...new Set(files)];
}

/** Apply every target of `artifact` under `root`; returns the files whose content changed. */
export function pinArtifact(root: string, artifact: string, digest: string): string[] {
  const targets = ARTIFACTS[artifact];
  if (!targets) {
    throw new Error(`unknown artifact ${artifact}; expected one of ${Object.keys(ARTIFACTS)}`);
  }
  const variant = hostVariant(root, artifact);
  const changed: string[] = [];
  const edit = (file: string, rewrite: (before: string) => string) => {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    const text = rewrite(before);
    if (text !== before) {
      writeFileSync(path, text);
      if (!changed.includes(file)) changed.push(file);
    }
  };
  for (const target of targets) {
    edit(target.file, (before) => {
      const { text, matches } = pinText(before, target, digest);
      if (matches === 0) throw new Error(`${target.file}: no ${target.ref}@sha256 pin found`);
      return text;
    });
  }
  if (artifact === 'tenant-auth')
    edit(API_KEY_NAMESPACE_SOURCE, (before) =>
      allowApiKeyNamespace(before, digest, TENANT_AUTH_IMAGE),
    );
  if (!variant) return changed;
  const image = `${HOST_IMAGE}:${variant.tag}@${digest}`;
  if (variant.patches.includes(NATS_CREDENTIALS_PATCH)) {
    edit(NATS_CREDENTIALS_SOURCE, (before) =>
      allowNatsCredentials(before, digest, `${HOST_IMAGE}:${variant.tag}`),
    );
  }
  if (variant.canonical) {
    let previous = '';
    edit(DEFAULT_HOST_SOURCE, (before) => {
      const result = setDefaultHostImage(before, image);
      previous = result.previous;
      return result.text;
    });
    for (const file of DEFAULT_HOST_DOCS) {
      edit(file, (before) => {
        const text = previous === image ? before : before.replaceAll(previous, image);
        if (!text.includes(image)) throw new Error(`${file}: does not name the default host image`);
        return text;
      });
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
