import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, loadAll } from 'js-yaml';

/**
 * nats-server flags that turn on debug or protocol trace logging. Trace logging writes message
 * payloads to the container log; the runtime-operator chart starts its scheduler NATS with `-DV`
 * and has no value to change it (#550).
 */
const NATS_DEBUG_ARGS = new Set([
  '-D',
  '-V',
  '-DV',
  '-VD',
  '-VV',
  '-DVV',
  '-VVD',
  '--debug',
  '--trace',
]);

interface Container {
  name?: unknown;
  args?: unknown;
}

/** Drop debug/trace flags from the `nats` container args of every Deployment in a Helm render. */
export function stripNatsDebugArgs(manifests: string): string {
  const documents = loadAll(manifests).filter((doc) => doc !== null && doc !== undefined);
  for (const doc of documents) {
    const manifest = doc as {
      kind?: unknown;
      spec?: { template?: { spec?: { containers?: Container[] } } };
    };
    if (manifest.kind !== 'Deployment') continue;
    for (const container of manifest.spec?.template?.spec?.containers ?? [])
      if (container.name === 'nats' && Array.isArray(container.args))
        container.args = container.args.filter((arg) => !NATS_DEBUG_ARGS.has(String(arg)));
  }
  return documents.map((doc) => `---\n${dump(doc, { lineWidth: -1 })}`).join('');
}

/** Helm post-renderer entry: rendered manifests on stdin, the patched manifests on stdout. */
export function runNatsPostrender(
  read: () => string = () => readFileSync(0, 'utf8'),
  write: (text: string) => void = (text) => process.stdout.write(text),
): void {
  write(stripNatsDebugArgs(read()));
}

/**
 * Write the executable Helm runs as the runtime-operator release's post-renderer and return its
 * path. Helm takes a single executable, so the file runs this module with the current Node.
 */
export function natsPostrenderer(
  dir: string = join(tmpdir(), 'di-framework-platform'),
  module: string = __filename,
  runtime: string = process.execPath,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'nats-postrender');
  writeFileSync(path, `#!${runtime}\nrequire(${JSON.stringify(module)}).runNatsPostrender();\n`);
  chmodSync(path, 0o755);
  return path;
}
