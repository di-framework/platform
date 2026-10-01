/**
 * Optional pull-through registry mirrors for the local k0s containerd. The
 * mirrors are written as containerd `hosts.toml` files, so containerd tries each
 * mirror in order and falls back to the upstream registry.
 */

/** Registry host (`docker.io`, `registry.example:5000`) to ordered mirror URLs. */
export type RegistryMirrors = Record<string, string[]>;

/** A file written inside the k0s container before k0s starts; its content travels in `variable`. */
export interface StartupFile {
  path: string;
  variable: string;
  content: string;
}

export const CONTAINERD_DROP_IN = '/etc/k0s/containerd.d/di-framework-registry-mirrors.toml';
export const CONTAINERD_CERTS_DIR = '/etc/containerd/certs.d';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const PORT =
  '(?::(?:6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?';
const HOST = `${LABEL}(?:\\.${LABEL})*${PORT}`;
const REGISTRY = new RegExp(`^${HOST}$`);
const MIRROR = new RegExp(`^https?://${HOST}(?:/[A-Za-z0-9._~-]+)*/?$`);

/**
 * Validates the `registryMirrors` config value. Undefined or `{}` means no
 * mirrors. Registry hosts and mirror URLs are restricted to characters that
 * need no quoting in TOML or a shell.
 */
export function registryMirrors(value: unknown): RegistryMirrors | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'registryMirrors must be an object mapping a registry host to a list of mirror URLs',
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  const mirrors: RegistryMirrors = {};
  for (const [registry, urls] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!REGISTRY.test(registry)) {
      throw new Error(
        `registryMirrors key must be a lowercase registry host or host:port such as docker.io; received ${JSON.stringify(registry)}`,
      );
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error(`registryMirrors.${registry} must be a non-empty list of mirror URLs`);
    }
    for (const url of urls) {
      if (typeof url !== 'string' || !MIRROR.test(url)) {
        throw new Error(
          `registryMirrors.${registry} entries must be http:// or https:// URLs with a lowercase host and optional path; received ${JSON.stringify(url)}`,
        );
      }
    }
    if (new Set(urls).size !== urls.length) {
      throw new Error(`registryMirrors.${registry} lists a mirror more than once`);
    }
    mirrors[registry] = [...urls];
  }
  return mirrors;
}

/** The containerd drop-in and one `hosts.toml` per registry, in a stable order. */
export function registryMirrorFiles(mirrors: RegistryMirrors | undefined): StartupFile[] {
  if (!mirrors) return [];
  const files = [
    {
      path: CONTAINERD_DROP_IN,
      content: [
        '# Managed by @di-framework/platform: registry mirrors.',
        'version = 3',
        '',
        '[plugins."io.containerd.cri.v1.images".registry]',
        `  config_path = "${CONTAINERD_CERTS_DIR}"`,
        '',
      ].join('\n'),
    },
    ...Object.entries(mirrors).map(([registry, urls]) => ({
      path: `${CONTAINERD_CERTS_DIR}/${registry}/hosts.toml`,
      content: [
        '# Managed by @di-framework/platform: registry mirrors.',
        `server = "${upstream(registry)}"`,
        ...urls.flatMap((url) => ['', `[host."${url}"]`, '  capabilities = ["pull", "resolve"]']),
        '',
      ].join('\n'),
    })),
  ];
  return files.map((file, index) => ({ ...file, variable: `DI_K0S_FILE_${index}` }));
}

function upstream(registry: string): string {
  return registry === 'docker.io' ? 'https://registry-1.docker.io' : `https://${registry}`;
}
