import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type IdentityEntry,
  ISSUANCE_ID,
  PLATFORM_ROLES,
  parseIdentityRecord,
  platformUser,
  SCHEDULER_LEAF_DAYS,
  SCHEDULER_LEAF_RENEW_DAYS,
  serializeIdentityRecord,
  tenantHostUser,
  tenantIdentity,
  tenantOperatorUser,
} from '../src/tenancy/scheduler-pki';
import {
  type HostObservation,
  identityTransition,
  issuanceIdOf,
  type OperatorObservation,
  RENEWAL_OVERLAP_MS,
  RENEWAL_STALLED,
  ROTATE_ANNOTATION,
  recordTransition,
  rotationRequested,
  SCHEDULER_TLS_ANNOTATION,
  schedulerCertDigest,
} from '../src/tenancy/scheduler-pki-rotation';

const DAY = 86_400_000;
const now = new Date('2026-10-29T12:00:00.000Z');
const at = (ms: number) => new Date(now.getTime() + ms);
/** Deterministic IDs: 01.., 02.., ... */
const counter = () => {
  let n = 0;
  return (size: number) => Buffer.alloc(size, ++n);
};
const OLD = 'aaaaaaaaaaaaaaaa';
const PREV = 'bbbbbbbbbbbbbbbb';
const left = (ms: number, id = OLD) => ({ notAfter: at(ms), digest: 'd1', id });
const fresh = { notAfter: at(60 * DAY), digest: 'd1', id: OLD };
const operator = (o: Partial<OperatorObservation> = {}): OperatorObservation => ({
  client: 'operator',
  secret: fresh,
  ...o,
});
const host = (o: Partial<HostObservation> = {}): HostObservation => ({
  client: 'host',
  secret: fresh,
  deployment: 'hostgroup-tenant-a',
  rollout: { deployment: 'hostgroup-tenant-a', digest: 'd1', complete: true },
  ...o,
});
const renewing = (untilMs: number): IdentityEntry => ({
  current: OLD,
  previous: PREV,
  previousUntil: at(untilMs).toISOString(),
});

describe('scheduler identity issuance', () => {
  it('issues a new identity for an entry not in the record', () => {
    const t = identityTransition(undefined, operator({ secret: undefined }), now, counter());
    expect(t).toEqual({ entry: { current: '0101010101010101' }, action: 'issue', reason: 'new' });
  });

  it('uses a fresh random ID by default', () => {
    const t = identityTransition(undefined, operator(), now);
    expect(t.entry.current).toMatch(ISSUANCE_ID);
  });

  it('keeps a current identity unchanged, and annotates hosts with the certificate digest', () => {
    expect(identityTransition({ current: OLD }, operator(), now)).toEqual({
      entry: { current: OLD },
      action: 'keep',
      reason: 'current',
    });
    expect(identityTransition({ current: OLD }, host(), now)).toEqual({
      entry: { current: OLD },
      action: 'keep',
      reason: 'current',
      annotate: { [SCHEDULER_TLS_ANNOTATION]: 'd1' },
    });
  });

  it('digests the certificate PEM as sha256 hex', () => {
    expect(schedulerCertDigest('pem')).toBe(createHash('sha256').update('pem').digest('hex'));
  });
});

describe('scheduler identity forced rotation', () => {
  it('rotates on a changed annotation with no previous, even mid-renewal', () => {
    for (const client of [operator({ forced: true }), host({ forced: true })]) {
      const t = identityTransition(renewing(RENEWAL_OVERLAP_MS), client, now, counter());
      expect(t).toEqual({
        entry: { current: '0101010101010101' },
        action: 'issue',
        reason: 'forced',
      });
    }
  });

  it('rotates when the Secret was deleted, with no previous', () => {
    const t = identityTransition({ current: OLD }, host({ secret: undefined }), now, counter());
    expect(t).toEqual({
      entry: { current: '0101010101010101' },
      action: 'issue',
      reason: 'missing',
    });
  });

  it('detects a changed rotation annotation', () => {
    expect(ROTATE_ANNOTATION).toBe('platform.di-framework.dev/rotate-scheduler-identity');
    expect(rotationRequested(undefined, undefined)).toBe(false);
    expect(rotationRequested('1', '1')).toBe(false);
    expect(rotationRequested('2', '1')).toBe(true);
    expect(rotationRequested('1', undefined)).toBe(true);
    expect(rotationRequested(undefined, '1')).toBe(true);
  });
});

describe('scheduler identity routine renewal', () => {
  it('keeps a certificate with more than 30 days left', () => {
    const t = identityTransition({ current: OLD }, operator({ secret: left(30 * DAY + 1) }), now);
    expect(t.action).toBe('keep');
  });

  it('renews at exactly 30 days left, keeping the old ID as previous for 10 minutes', () => {
    expect(SCHEDULER_LEAF_DAYS).toBe(90);
    expect(SCHEDULER_LEAF_RENEW_DAYS).toBe(30);
    const t = identityTransition(
      { current: OLD },
      operator({ secret: left(30 * DAY) }),
      now,
      counter(),
    );
    expect(t).toEqual({
      entry: {
        current: '0101010101010101',
        previous: OLD,
        previousUntil: '2026-10-29T12:10:00.000Z',
      },
      action: 'issue',
      reason: 'renewal',
    });
  });

  it('renews an expired certificate, and a fresh 90-day leaf is not renewed for 60 days', () => {
    const expired = identityTransition({ current: OLD }, host({ secret: left(-DAY) }), now);
    expect(expired.reason).toBe('renewal');
    expect(expired.annotate).toBeUndefined();
    const issued = { notAfter: at(SCHEDULER_LEAF_DAYS * DAY), digest: 'd1', id: OLD };
    const keep = identityTransition(
      { current: OLD },
      operator({ secret: issued }),
      at(60 * DAY - 1),
    );
    expect(keep.action).toBe('keep');
    const renew = identityTransition({ current: OLD }, operator({ secret: issued }), at(60 * DAY));
    expect(renew.reason).toBe('renewal');
  });

  it('gives every renewal a new ID', () => {
    const random = counter();
    const ids = new Set<string>();
    let entry: IdentityEntry = { current: OLD };
    for (let i = 0; i < 3; i++) {
      const secret = left(DAY, entry.current);
      entry = identityTransition(entry, operator({ secret }), now, random).entry;
      ids.add(entry.current);
    }
    expect(ids.size).toBe(3);
  });
});

describe('scheduler identity renewal overlap: operators', () => {
  it('keeps previous before previousUntil', () => {
    const t = identityTransition(renewing(1), operator(), now);
    expect(t).toEqual({ entry: renewing(1), action: 'keep', reason: 'current' });
  });

  it('drops previous at and after previousUntil', () => {
    for (const ms of [0, -1]) {
      const t = identityTransition(renewing(ms), operator(), now);
      expect(t.entry).toEqual({ current: OLD });
      expect(t.action).toBe('keep');
    }
  });
});

describe('scheduler identity renewal overlap: hosts', () => {
  it('drops previous once the rollout of the current certificate is observed', () => {
    const t = identityTransition(renewing(RENEWAL_OVERLAP_MS), host(), now);
    expect(t.entry).toEqual({ current: OLD });
    expect(t.stalled).toBeUndefined();
  });

  it('keeps both users while the rollout is pending, and annotates the new digest', () => {
    const pending = host({
      rollout: { deployment: 'hostgroup-tenant-a', digest: 'd0', complete: true },
    });
    const t = identityTransition(renewing(1), pending, now);
    expect(t).toEqual({
      entry: renewing(1),
      action: 'keep',
      reason: 'current',
      annotate: { [SCHEDULER_TLS_ANNOTATION]: 'd1' },
    });
  });

  it('ignores previousUntil for hosts, and never drops previous on an incomplete rollout', () => {
    const incomplete = host({
      rollout: { deployment: 'hostgroup-tenant-a', digest: 'd1', complete: false },
    });
    const t = identityTransition(renewing(-DAY), incomplete, now);
    expect(t.entry).toEqual(renewing(-DAY));
  });

  it('reports SchedulerIdentityRenewalStalled from previousUntil on, naming the Deployment', () => {
    const incomplete = host({
      rollout: { deployment: 'hostgroup-tenant-a', digest: 'd1', complete: false },
    });
    expect(identityTransition(renewing(1), incomplete, now).stalled).toBeUndefined();
    expect(identityTransition(renewing(0), incomplete, now).stalled).toEqual({
      type: RENEWAL_STALLED,
      deployment: 'hostgroup-tenant-a',
    });
    expect(RENEWAL_STALLED).toBe('SchedulerIdentityRenewalStalled');
  });

  it('keeps both users when no rollout was observed, stalled past previousUntil', () => {
    const before = identityTransition(renewing(1), host({ rollout: undefined }), now);
    expect(before.entry).toEqual(renewing(1));
    expect(before.stalled).toBeUndefined();
    const named = host({ rollout: undefined, deployment: 'hostgroup-default' });
    const t = identityTransition(renewing(-1), named, now);
    expect(t.entry).toEqual(renewing(-1));
    expect(t.stalled).toEqual({ type: RENEWAL_STALLED, deployment: 'hostgroup-default' });
  });

  it('treats a missing or invalid previousUntil as passed', () => {
    const incomplete = host({
      rollout: { deployment: 'hostgroup-tenant-a', digest: 'd0', complete: false },
    });
    for (const previousUntil of [undefined, 'not a time']) {
      const entry: IdentityEntry = { current: OLD, previous: PREV, previousUntil };
      expect(identityTransition(entry, operator(), now).entry).toEqual({ current: OLD });
      const h = identityTransition(entry, incomplete, now);
      expect(h.entry).toEqual(entry);
      expect(h.stalled).toEqual({ type: RENEWAL_STALLED, deployment: 'hostgroup-tenant-a' });
    }
  });
});

describe('scheduler identity pending issuance', () => {
  it('reads the issuance ID from the m1 user of every client', () => {
    for (const role of PLATFORM_ROLES) expect(issuanceIdOf(platformUser(role, OLD))).toBe(OLD);
    expect(issuanceIdOf(tenantHostUser('a', OLD))).toBe(OLD);
    expect(issuanceIdOf(tenantOperatorUser('a', OLD))).toBe(OLD);
    expect(issuanceIdOf('nats.ns.svc')).toBeUndefined();
  });

  it('treats a Secret whose certificate carries no issuance ID as pending', () => {
    const secret = { ...fresh, id: issuanceIdOf('nats.ns.svc') };
    const t = identityTransition({ current: OLD }, operator({ secret }), now);
    expect(t).toEqual({ entry: { current: OLD }, action: 'issue', reason: 'pending' });
  });

  it('retries a renewal that did not land for the same ID, keeping previous', () => {
    const renewal = identityTransition(
      { current: OLD },
      operator({ secret: left(DAY) }),
      now,
      counter(),
    );
    expect(renewal.entry).toEqual({
      current: '0101010101010101',
      previous: OLD,
      previousUntil: '2026-10-29T12:10:00.000Z',
    });
    const retry = identityTransition(
      renewal.entry,
      operator({ secret: left(DAY) }),
      at(RENEWAL_OVERLAP_MS),
      counter(),
    );
    expect(retry).toEqual({
      entry: { ...renewal.entry, previousUntil: '2026-10-29T12:20:00.000Z' },
      action: 'issue',
      reason: 'pending',
    });
  });

  it('keeps the old user admitted until 10 minutes after a late issuance lands', () => {
    const renewal = identityTransition({ current: OLD }, operator({ secret: left(DAY) }), now);
    const NEW = renewal.entry.current;
    const late = at(15 * 60_000);
    const retry = identityTransition(renewal.entry, operator({ secret: left(DAY) }), late);
    expect(retry.entry).toEqual({
      current: NEW,
      previous: OLD,
      previousUntil: '2026-10-29T12:25:00.000Z',
    });
    const landed = { notAfter: at(60 * DAY), digest: 'd2', id: NEW };
    const after = (ms: number) =>
      identityTransition(retry.entry, operator({ secret: landed }), at(15 * 60_000 + ms));
    expect(after(1).entry).toEqual(retry.entry);
    expect(after(RENEWAL_OVERLAP_MS - 1).entry).toEqual(retry.entry);
    expect(after(RENEWAL_OVERLAP_MS).entry).toEqual({ current: NEW });
  });

  it('reports no host stall right after a late issuance', () => {
    const renewal = identityTransition({ current: OLD }, host({ secret: left(DAY) }), now);
    const late = at(15 * 60_000);
    const retry = identityTransition(renewal.entry, host({ secret: left(DAY) }), late);
    const secret = { notAfter: at(60 * DAY), digest: 'd2', id: renewal.entry.current };
    const rolling = { deployment: 'hostgroup-tenant-a', digest: 'd1', complete: true };
    const first = identityTransition(retry.entry, host({ secret, rollout: rolling }), late);
    expect(first.entry).toEqual(retry.entry);
    expect(first.stalled).toBeUndefined();
    const stalled = identityTransition(
      retry.entry,
      host({ secret, rollout: rolling }),
      at(15 * 60_000 + RENEWAL_OVERLAP_MS),
    );
    expect(stalled.stalled).toEqual({ type: RENEWAL_STALLED, deployment: 'hostgroup-tenant-a' });
  });

  it('leaves a pending entry without previous unchanged', () => {
    const t = identityTransition(
      { current: OLD },
      operator({ secret: { ...fresh, id: PREV } }),
      now,
    );
    expect(t.entry).toEqual({ current: OLD });
  });

  it('drops previous for neither client while the Secret holds the old certificate', () => {
    const old = { ...fresh, id: PREV };
    const incomplete = { deployment: 'hostgroup-tenant-a', digest: 'd1', complete: true };
    for (const o of [operator({ secret: old }), host({ secret: old, rollout: incomplete })]) {
      const t = identityTransition(renewing(-DAY), o, now);
      expect(t).toEqual({
        entry: renewing(RENEWAL_OVERLAP_MS),
        action: 'issue',
        reason: 'pending',
      });
    }
  });
});

describe('scheduler identity record transition', () => {
  const hosts = tenantIdentity('a', 'hosts');
  const op = tenantIdentity('a', 'operator');

  it('produces the record to write before issuance, with a new ID per certificate', () => {
    const out = recordTransition(
      { 'platform/operator': { current: OLD }, [op]: { current: PREV } },
      { [op]: operator({ forced: true }), [hosts]: host({ forced: true }) },
      now,
      counter(),
    );
    // Visited in code-unit order: hosts before operator.
    expect(out.transitions.map(([key]) => key)).toEqual([hosts, op]);
    expect(out.record).toEqual({
      'platform/operator': { current: OLD },
      [hosts]: { current: '0101010101010101' },
      [op]: { current: '0202020202020202' },
    });
    for (const [key, t] of out.transitions) {
      expect(t.action).toBe('issue');
      expect(out.record[key]?.current).toBe(t.entry.current);
    }
    const text = serializeIdentityRecord(out.record);
    expect(serializeIdentityRecord(parseIdentityRecord(text))).toBe(text);
    expect(out.stalled).toEqual([]);
  });

  it('is independent of insertion order and lists stalled keys', () => {
    const incomplete = host({
      rollout: { deployment: 'hostgroup-tenant-a', digest: 'd0', complete: false },
    });
    const record = { [hosts]: renewing(-1), [op]: renewing(-1) };
    const a = recordTransition(record, { [op]: operator(), [hosts]: incomplete }, now);
    const b = recordTransition(record, { [hosts]: incomplete, [op]: operator() }, now);
    expect(serializeIdentityRecord(a.record)).toBe(serializeIdentityRecord(b.record));
    expect(a.stalled).toEqual([hosts]);
    expect(a.record[op]).toEqual({ current: OLD });
  });
});
