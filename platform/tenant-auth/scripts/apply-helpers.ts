import { createHash } from 'node:crypto';

/** Server-side apply: no last-applied annotation, so large ConfigMaps are fine. */
export const APPLY_ARGS = [
  'apply',
  '--server-side',
  '--field-manager=tenant-auth-deploy-local',
  '--force-conflicts',
  '-f',
  '-',
];

/** Kubernetes caps an object at 1 MiB; fail clearly before the API server does. */
export const MAX_CONFIGMAP_DATA_BYTES = 900 * 1024;

interface Manifest {
  kind?: string;
}

/** Config objects first; Deployments only after those applied, so a failed bundle never recycles pods. */
export function splitManifests<T extends Manifest>(
  manifests: T[],
): { config: T[]; workloads: T[] } {
  return {
    config: manifests.filter((m) => m.kind !== 'Deployment'),
    workloads: manifests.filter((m) => m.kind === 'Deployment'),
  };
}

export function assertBundleSize(data: Record<string, string>): void {
  const bytes = Object.values(data).reduce((sum, v) => sum + Buffer.byteLength(v), 0);
  if (bytes > MAX_CONFIGMAP_DATA_BYTES) {
    throw new Error(
      `tenant-auth-bundle data is ${bytes} bytes, over the ${MAX_CONFIGMAP_DATA_BYTES} byte limit (ConfigMaps cap at 1 MiB)`,
    );
  }
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export function assertDigestsMatch(built: string, live: string): void {
  if (built !== live) {
    throw new Error(`in-cluster controller.js sha256 ${live} does not match built ${built}`);
  }
}
