import { load } from 'js-yaml';
import { names } from './tenancy/resources';

export interface TenantKubeconfigArgs {
  /** Kubernetes API server URL reachable by the user, e.g. `https://127.0.0.1:26443`. */
  server: string;
  tenant: string;
  user: string;
  /** `data` of the user's `kubernetes.io/service-account-token` Secret (base64 values). */
  secretData: Record<string, string> | undefined;
}

/**
 * Kubeconfig for one tenant membership: the cluster CA and the user's ServiceAccount token as
 * its only credential, with the tenant workload namespace selected.
 */
export function tenantKubeconfig(args: TenantKubeconfigArgs): string {
  const token = args.secretData?.token;
  const ca = args.secretData?.['ca.crt'];
  if (!token || !ca)
    throw new Error(`Token Secret for user ${args.user} in tenant ${args.tenant} is not populated`);
  const name = `${args.user}@${args.tenant}`;
  const q = (value: string) => JSON.stringify(value);
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    `  - name: ${q(args.tenant)}`,
    '    cluster:',
    `      server: ${q(args.server)}`,
    `      certificate-authority-data: ${q(ca)}`,
    'users:',
    `  - name: ${q(name)}`,
    '    user:',
    `      token: ${q(Buffer.from(token, 'base64').toString('utf8'))}`,
    'contexts:',
    `  - name: ${q(name)}`,
    '    context:',
    `      cluster: ${q(args.tenant)}`,
    `      user: ${q(name)}`,
    `      namespace: ${q(names(args.tenant).namespace)}`,
    `current-context: ${q(name)}`,
    '',
  ].join('\n');
}

/**
 * API server URL of the selected context (or `current-context`) in an administrator
 * kubeconfig. Returns undefined when it cannot be resolved unambiguously.
 */
export function kubeconfigServer(text: string, context?: string): string | undefined {
  let config: unknown;
  try {
    config = load(text);
  } catch {
    return undefined;
  }
  if (!config || typeof config !== 'object') return undefined;
  const {
    contexts,
    clusters,
    'current-context': current,
  } = config as {
    contexts?: { name?: string; context?: { cluster?: string } }[];
    clusters?: { name?: string; cluster?: { server?: string } }[];
    'current-context'?: string;
  };
  const selected = context || current;
  if (!selected || !Array.isArray(contexts) || !Array.isArray(clusters)) return undefined;
  const cluster = contexts.find((c) => c?.name === selected)?.context?.cluster;
  const server = clusters.find((c) => c?.name === cluster)?.cluster?.server;
  return typeof server === 'string' && /^https:\/\/[^\s/]+/.test(server) ? server : undefined;
}
