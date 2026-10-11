import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import type { SecretDataReader } from './token-wait';

/**
 * Builds a Secret reader from exactly the kubeconfig (and optional context) that the program's
 * Kubernetes provider uses. It never consults `$KUBECONFIG`, `~/.kube/config` or in-cluster
 * config. A kubeconfig that uses an `exec` credential plugin runs that same plugin here, as the
 * provider does.
 */
export function secretReaderFromKubeconfig(kubeconfig: string, context?: string): SecretDataReader {
  const kc = new KubeConfig();
  kc.loadFromString(kubeconfig);
  if (context) kc.setCurrentContext(context);
  const api = kc.makeApiClient(CoreV1Api);
  return async (namespace, name) => (await api.readNamespacedSecret({ name, namespace })).data;
}
