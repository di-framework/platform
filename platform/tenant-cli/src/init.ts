import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CliError } from './credentials.ts';

export interface InitOptions {
  /** Positional name, also the directory unless `dir` is given. */
  name?: string;
  dir?: string;
  /** `--name`: the project name when it differs from the directory. */
  projectName?: string;
  force?: boolean;
  cwd: string;
}

/**
 * The minimal di-framework seed: a package manifest, the component config, and one HTTP
 * handler. It creates no platform resources; `services create` and `deploy` do that later.
 */
export function init(options: InitOptions): { directory: string; files: string[] } {
  const directory = resolve(options.cwd, options.dir ?? options.name ?? '.');
  const name = options.projectName ?? options.name ?? basename(directory);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CliError(`project name must be a lowercase DNS label, got ${JSON.stringify(name)}`);
  }
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(
      {
        name,
        private: true,
        type: 'module',
        scripts: { build: 'di-framework platform build', deploy: 'di-tenant deploy apply' },
        dependencies: { '@di-framework/core': '^6.0.3', '@di-framework/http': '^6.0.3' },
      },
      null,
      2,
    )}\n`,
    'di-framework.config.json': `${JSON.stringify(
      { name, entry: 'src/app.ts', output: `dist/${name}.wasm` },
      null,
      2,
    )}\n`,
    'src/app.ts': [
      '/** One HTTP handler; the platform routes requests for this service here. */',
      'export default function fetch(request: Request): Response {',
      '  return Response.json({ service: ' +
        JSON.stringify(name) +
        ', path: new URL(request.url).pathname });',
      '}',
      '',
    ].join('\n'),
  };
  const existing = Object.keys(files).filter((file) => existsSync(join(directory, file)));
  if (existing.length > 0 && !options.force) {
    throw new CliError(
      `${existing.join(', ')} already exist in ${directory}; pass --force to overwrite`,
    );
  }
  mkdirSync(join(directory, 'src'), { recursive: true });
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(directory, file), content);
  return { directory, files: Object.keys(files) };
}
