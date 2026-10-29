import { describe, expect, test } from 'bun:test';
import { acceptedModes, recordFor, storageRecordsOf } from '../src/storage-records.ts';

const EXPECTED = { installation: 'di', ownerUid: 'uid-tenant' };
const LABELS = {
  'platform.di-framework.dev/installation': 'di',
  'platform.di-framework.dev/owner-uid': 'uid-tenant',
};
const map = (keys: unknown, labels: Record<string, string> = LABELS) => ({
  metadata: { labels },
  data: { keys: typeof keys === 'string' ? keys : JSON.stringify(keys) },
});

describe('di-storage-records (#553)', () => {
  test('404 is absent', () => {
    expect(storageRecordsOf(undefined, EXPECTED)).toEqual({ state: 'absent' });
  });

  test('reads a copy of status.storage.keys, keeping kind, requested and mode', () => {
    const records = storageRecordsOf(
      map({
        identity: { kind: 'PgliteEncfs', requested: 'AEAD', mode: 'AEAD', observed: 'aead' },
        fresh: { kind: 'PgliteEncfs', requested: 'Off' },
        old: { kind: 'Other', mode: 'XTS', observed: 'xts' },
        actors: { kind: 'Other' },
      }),
      EXPECTED,
    );
    expect(records).toEqual({
      state: 'present',
      keys: {
        identity: { kind: 'PgliteEncfs', requested: 'AEAD', mode: 'AEAD' },
        fresh: { kind: 'PgliteEncfs', requested: 'Off' },
        old: { kind: 'Other', mode: 'XTS' },
        actors: { kind: 'Other' },
      },
    });
    expect(storageRecordsOf(map({}), EXPECTED)).toEqual({ state: 'present', keys: {} });
  });

  test('keys named like Object.prototype members are own keys only', () => {
    const empty = storageRecordsOf(map({}), EXPECTED);
    if (empty.state !== 'present') throw new Error('expected present');
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(recordFor(empty.keys, key)).toBeUndefined();
    }
    const named = storageRecordsOf(
      map(
        '{"__proto__":{"kind":"Other","mode":"XTS"},"constructor":{"kind":"PgliteEncfs","requested":"AEAD"},"toString":{"kind":"Other"}}',
      ),
      EXPECTED,
    );
    if (named.state !== 'present') throw new Error('expected present');
    expect(recordFor(named.keys, '__proto__')).toEqual({ kind: 'Other', mode: 'XTS' });
    expect(recordFor(named.keys, 'constructor')).toEqual({
      kind: 'PgliteEncfs',
      requested: 'AEAD',
    });
    expect(recordFor(named.keys, 'toString')).toEqual({ kind: 'Other' });
    expect(Object.getPrototypeOf(named.keys)).toBeNull();
    expect(Object.keys(named.keys).sort()).toEqual(['__proto__', 'constructor', 'toString']);
  });

  test('a copy without the controller labels is untrusted, never absent', () => {
    const untrusted = (
      labels: Record<string, string>,
      expected: { installation?: string; ownerUid?: string } = EXPECTED,
    ) => storageRecordsOf(map({}, labels), expected).state;
    expect(untrusted({})).toBe('untrusted');
    expect(untrusted({ ...LABELS, 'platform.di-framework.dev/owner-uid': 'other' })).toBe(
      'untrusted',
    );
    expect(untrusted({ ...LABELS, 'platform.di-framework.dev/installation': 'x' })).toBe(
      'untrusted',
    );
    // Without the host Deployment's labels there is nothing to compare with.
    expect(untrusted(LABELS, {})).toBe('untrusted');
    expect(storageRecordsOf({ data: {} }, EXPECTED)).toMatchObject({
      state: 'untrusted',
      message: expect.stringContaining('ConfigMap di-storage-records'),
    });
  });

  test('malformed content fails closed', () => {
    const invalid = (item: unknown) => storageRecordsOf(item, EXPECTED);
    expect(invalid({ metadata: { labels: LABELS } })).toEqual({
      state: 'invalid',
      message: 'ConfigMap di-storage-records is malformed: no keys entry',
    });
    expect(invalid(map('{'))).toMatchObject({ message: expect.stringContaining('not JSON') });
    for (const value of ['[]', 'null', '7']) {
      expect(invalid(map(value))).toMatchObject({
        message: expect.stringContaining('not an object'),
      });
    }
    for (const entry of [
      null,
      [],
      'AEAD',
      {},
      { kind: 'Sqlite' },
      { kind: 'PgliteEncfs' },
      { kind: 'PgliteEncfs', requested: 'On' },
      { kind: 'PgliteEncfs', requested: 'Off', mode: 'GCM' },
      { kind: 'Other', requested: 'Off' },
      { kind: 'Other', mode: 'AEAD' },
    ]) {
      expect(invalid(map({ ok: { kind: 'Other' }, bad: entry }))).toEqual({
        state: 'invalid',
        message: 'ConfigMap di-storage-records is malformed: entry "bad" is not a storage record',
      });
    }
  });

  test('the restore table', () => {
    expect(acceptedModes({ kind: 'PgliteEncfs', requested: 'Off', mode: 'XTS' })).toEqual(['XTS']);
    expect(acceptedModes({ kind: 'Other', mode: 'NotEncfs' })).toEqual(['NotEncfs']);
    expect(acceptedModes({ kind: 'PgliteEncfs', requested: 'AEAD' })).toEqual(['AEAD']);
    expect(acceptedModes({ kind: 'PgliteEncfs', requested: 'Off' })).toEqual(['XTS', 'AEAD']);
    expect(acceptedModes({ kind: 'Other' })).toEqual(['XTS', 'NotEncfs']);
  });
});
