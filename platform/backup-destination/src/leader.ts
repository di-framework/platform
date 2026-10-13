import type { KubeClient } from './kube.ts';
import { LEASE, statusOf } from './model.ts';

/**
 * One reconciler at a time (#232 W2). Within a process a tick never overlaps the previous one;
 * across pods (a rolling update, a stuck old pod) only the holder of a coordination Lease
 * reconciles. Every write a tick makes also carries a resourceVersion precondition, so a holder
 * that lost the Lease mid-tick cannot overwrite a newer write.
 */

export const LEASE_SECONDS = 15;

interface LeaseObject {
  metadata?: { resourceVersion?: string };
  spec?: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    renewTime?: string;
    leaseTransitions?: number;
  };
}

/** Kubernetes MicroTime: RFC 3339 with exactly six fractional digits. */
export function microTime(now: Date): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, (_, millis: string) => `.${millis}000Z`);
}

function leasePath(namespace: string, name = ''): string {
  return `/apis/coordination.k8s.io/v1/namespaces/${namespace}/leases${name ? `/${name}` : ''}`;
}

/**
 * Take or renew the Lease. True only when this identity holds it after the call. A lost race
 * (409) or an API error is "not leader" for this tick.
 */
export async function acquireLease(
  client: KubeClient,
  namespace: string,
  identity: string,
  now: Date,
  seconds = LEASE_SECONDS,
): Promise<boolean> {
  let lease: LeaseObject | undefined;
  try {
    lease = (await client.get(leasePath(namespace, LEASE))) as LeaseObject;
  } catch (error) {
    if (statusOf(error) !== 404) return false;
  }
  const time = microTime(now);
  if (!lease) {
    try {
      await client.post(leasePath(namespace), {
        apiVersion: 'coordination.k8s.io/v1',
        kind: 'Lease',
        metadata: { name: LEASE, namespace },
        spec: {
          holderIdentity: identity,
          leaseDurationSeconds: seconds,
          acquireTime: time,
          renewTime: time,
          leaseTransitions: 0,
        },
      });
      return true;
    } catch {
      return false;
    }
  }
  const spec = lease.spec ?? {};
  const renewed = spec.renewTime ? new Date(spec.renewTime).getTime() : 0;
  const duration = (spec.leaseDurationSeconds ?? seconds) * 1000;
  const mine = spec.holderIdentity === identity;
  const free = !spec.holderIdentity || Number.isNaN(renewed) || renewed + duration < now.getTime();
  if (!mine && !free) return false;
  try {
    await client.patch(leasePath(namespace, LEASE), {
      // Only the version that was read: two candidates taking over cannot both win.
      metadata: { resourceVersion: lease.metadata?.resourceVersion },
      spec: mine
        ? { renewTime: time, leaseDurationSeconds: seconds }
        : {
            holderIdentity: identity,
            leaseDurationSeconds: seconds,
            acquireTime: time,
            renewTime: time,
            leaseTransitions: (spec.leaseTransitions ?? 0) + 1,
          },
    });
    return true;
  } catch {
    return false;
  }
}

/** Hand the Lease over on shutdown, so the next pod need not wait for it to expire. */
export async function releaseLease(
  client: KubeClient,
  namespace: string,
  identity: string,
): Promise<void> {
  try {
    const lease = (await client.get(leasePath(namespace, LEASE))) as LeaseObject;
    if (lease.spec?.holderIdentity !== identity) return;
    await client.patch(leasePath(namespace, LEASE), {
      metadata: { resourceVersion: lease.metadata?.resourceVersion },
      spec: { holderIdentity: null, renewTime: null },
    });
  } catch {
    // Best effort: the Lease expires on its own.
  }
}

/** Run `task` unless the previous run is still going. Resolves false for a skipped call. */
export function singleFlight(task: () => Promise<void>): () => Promise<boolean> {
  let running = false;
  return async () => {
    if (running) return false;
    running = true;
    try {
      await task();
      return true;
    } finally {
      running = false;
    }
  };
}

/** One operator tick: reconcile only while holding the Lease. */
export function leaderTick(input: {
  client: KubeClient;
  namespace: string;
  identity: string;
  clock?: () => Date;
  reconcile: () => Promise<void>;
}): () => Promise<boolean> {
  const clock = input.clock ?? (() => new Date());
  return singleFlight(async () => {
    if (!(await acquireLease(input.client, input.namespace, input.identity, clock()))) return;
    await input.reconcile();
  });
}
