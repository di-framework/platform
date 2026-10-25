/**
 * Kubeconfig access through status.kubeconfigSecretRef. The Secret is read on demand through
 * Headlamp's API proxy with the viewer's own credentials, so Kubernetes RBAC decides who may see
 * it. Nothing here caches: callers keep the decoded text only in component state.
 */

/** The key in the Secret that holds the kubeconfig (see the operator README). */
export const KUBECONFIG_KEY = 'kubeconfig';

export function secretPath(namespace: string, name: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`;
}

/** A Secret as the API returns it; only `data` matters here. */
export interface SecretLike {
  data?: Record<string, string>;
}

/** Decodes data.kubeconfig (base64), or throws if the Secret has no kubeconfig. */
export function decodeKubeconfig(secret: SecretLike): string {
  const encoded = secret.data?.[KUBECONFIG_KEY];
  if (!encoded) {
    throw new Error(`The Secret has no "${KUBECONFIG_KEY}" key.`);
  }
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A readable message for a failed Secret read; 403 says which permission is missing. */
export function kubeconfigErrorMessage(err: unknown, namespace: string, name: string): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 403) {
    return (
      `You don't have permission to read the kubeconfig: your account can't "get" the Secret ` +
      `"${name}" in namespace "${namespace}" (403 Forbidden). Ask a cluster admin for a Role ` +
      `that allows get on that Secret.`
    );
  }
  if (status === 404) {
    return `The kubeconfig Secret "${name}" was not found in namespace "${namespace}".`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Couldn't read the kubeconfig Secret "${name}": ${message}`;
}

export function kubeconfigFileName(instanceName: string): string {
  return `${instanceName}-kubeconfig.yaml`;
}
