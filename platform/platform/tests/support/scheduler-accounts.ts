import type { AccountsTenant } from '../../src/tenancy/scheduler-nats';
import type { IdentityRecord } from '../../src/tenancy/scheduler-pki';

/**
 * The inputs of the golden `accounts.conf` (`tests/fixtures/scheduler-nats-accounts.conf`), shared
 * by the renderer's unit tests and the broker test (design-541 §8.1, §8.2): platform namespace
 * `wasmcloud`, tenants `a` (2 host replicas, in a routine renewal of its operator) and `b`.
 */
export const GOLDEN_NAMESPACE = 'wasmcloud';
export const GOLDEN_NOW = new Date('2026-10-29T12:00:00Z');
export const GOLDEN_TENANTS: AccountsTenant[] = [
  { metadata: { name: 'b' } },
  { metadata: { name: 'a' }, spec: { runtime: { replicas: 2 } } },
];
export const GOLDEN_IDS = {
  platformOperator: '0000000000000001',
  platformHost: '0000000000000002',
  platformData: '0000000000000003',
  aHosts: 'aaaaaaaaaaaaaaa1',
  aOperator: 'aaaaaaaaaaaaaaa2',
  aOperatorPrevious: 'aaaaaaaaaaaaaaa3',
  bHosts: 'bbbbbbbbbbbbbbb1',
  bOperator: 'bbbbbbbbbbbbbbb2',
} as const;
export const GOLDEN_RECORD: IdentityRecord = {
  'tenant/b/operator': { current: GOLDEN_IDS.bOperator },
  'tenant/b/hosts': { current: GOLDEN_IDS.bHosts },
  'tenant/a/operator': {
    current: GOLDEN_IDS.aOperator,
    previous: GOLDEN_IDS.aOperatorPrevious,
    previousUntil: '2026-10-29T12:10:00Z',
  },
  'tenant/a/hosts': { current: GOLDEN_IDS.aHosts },
  'platform/data': { current: GOLDEN_IDS.platformData },
  'platform/host': { current: GOLDEN_IDS.platformHost },
  'platform/operator': { current: GOLDEN_IDS.platformOperator },
};
export const GOLDEN_FILE = `${import.meta.dir}/../fixtures/scheduler-nats-accounts.conf`;
