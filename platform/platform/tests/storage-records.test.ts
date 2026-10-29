import { describe, expect, it } from 'bun:test';
import {
  admissionResources,
  STORAGE_FORMAT_ACTORS_MESSAGE,
  STORAGE_FORMAT_IMMUTABLE_MESSAGE,
  STORAGE_FORMAT_STORAGE_MESSAGE,
  STORAGE_FORMAT_VALUE_MESSAGE,
  STORAGE_RECORDS_AEAD_MESSAGE,
  STORAGE_RECORDS_KEPT_MESSAGE,
  STORAGE_RECORDS_NEW_MESSAGE,
  storageRecordsDenials,
  workloadStorageFormatDenials,
} from '../src/tenancy/admission';
import { crds, type Resource } from '../src/tenancy/resources';
import type { StorageClass } from '../src/tenancy/storage-mode';
import {
  integrityCondition,
  parseListing,
  planStorage,
  recordsPatch,
  STORAGE_RECORD_LIMIT,
  type StorageRecords,
  storageAllowed,
  workloadKind,
} from '../src/tenancy/storage-records';
import {
  STORAGE_ANNOTATION,
  STORAGE_FORMAT_ANNOTATION,
  STORAGE_MOUNT_ANNOTATION,
  type WorkloadDeployment,
} from '../src/tenancy/workload-storage';
import { evaluate } from './support/cel';

function workload(
  name: string,
  opts: { key?: string; pglite?: boolean; format?: string; mount?: string } = {},
): WorkloadDeployment {
  return {
    metadata: {
      name,
      labels: opts.key ? { 'di-framework.dev/workload': opts.key } : {},
      annotations: {
        [STORAGE_ANNOTATION]: 'true',
        ...(opts.pglite ? { [STORAGE_FORMAT_ANNOTATION]: 'pglite-encfs' } : {}),
        ...(opts.format ? { [STORAGE_FORMAT_ANNOTATION]: opts.format } : {}),
        ...(opts.mount ? { [STORAGE_MOUNT_ANNOTATION]: opts.mount } : {}),
      },
    },
  };
}
const listing = (entries: Record<string, StorageClass>) => new Map(Object.entries(entries));

describe('storage records (#200)', () => {
  it('declares a kind only with the exact pglite-encfs value', () => {
    expect(workloadKind(workload('a', { pglite: true }))).toBe('PgliteEncfs');
    expect(workloadKind(workload('a', { format: 'PGLITE-ENCFS' }))).toBe('Other');
    expect(workloadKind(workload('a'))).toBe('Other');
    expect(workloadKind({ metadata: { name: 'bare' } })).toBe('Other');
  });

  it('parses a complete listing and nothing else', () => {
    expect(parseListing('pg reserved\nact unencrypted\nx other link\ndone count=3\n')).toEqual(
      listing({ pg: 'reserved', act: 'unencrypted', x: 'other' }),
    );
    expect(parseListing('done count=0')).toEqual(new Map());
    expect(parseListing('pg reserved\n')).toBeUndefined();
    expect(parseListing('pg reserved\ndone count=2')).toBeUndefined();
    expect(parseListing('pg weird\ndone count=1')).toBeUndefined();
    expect(parseListing(' \ndone count=1')).toBeUndefined();
    expect(parseListing('')).toBeUndefined();
  });

  it('records keys write-ahead with their kind, and requested only for pglite-encfs keys', () => {
    const plan = planStorage({
      records: {},
      workloads: [
        workload('db', { pglite: true }),
        workload('actors', { mount: '/data/actors' }),
        workload('bad', { mount: '/etc' }),
      ],
      integrity: 'AEAD',
    });
    expect(plan.records).toEqual({
      db: { kind: 'PgliteEncfs', requested: 'AEAD' },
      actors: { kind: 'Other' },
    });
    expect(plan.mounted).toEqual(['actors', 'db']);
    expect(plan.reserve).toEqual(['db']);
    expect(plan.conflicts).toEqual([]);
    // A recorded key keeps its request when the spec changes.
    const later = planStorage({
      records: plan.records,
      workloads: [workload('db', { pglite: true }), workload('new', { pglite: true })],
      integrity: 'Off',
    });
    expect(later.records.db).toEqual({ kind: 'PgliteEncfs', requested: 'AEAD' });
    expect(later.records.new).toEqual({ kind: 'PgliteEncfs', requested: 'Off' });
    expect(later.reserve).toEqual(['db']);
  });

  it('sets the mode once from the first observation that is not empty', () => {
    const records: StorageRecords = {
      db: { kind: 'PgliteEncfs', requested: 'AEAD' },
      old: { kind: 'PgliteEncfs', requested: 'AEAD' },
      act: { kind: 'Other' },
      x: { kind: 'Other', mode: 'XTS' },
    };
    const workloads = [
      workload('db', { pglite: true }),
      workload('old', { pglite: true }),
      workload('act'),
      workload('x'),
    ];
    const first = planStorage({
      records,
      workloads,
      integrity: 'AEAD',
      listing: listing({ db: 'empty', old: 'xts', act: 'unencrypted', x: 'xts' }),
    });
    expect(first.records).toEqual({
      db: { kind: 'PgliteEncfs', requested: 'AEAD', observed: 'empty' },
      old: { kind: 'PgliteEncfs', requested: 'AEAD', mode: 'XTS', observed: 'xts' },
      act: { kind: 'Other', mode: 'NotEncfs', observed: 'unencrypted' },
      x: { kind: 'Other', mode: 'XTS', observed: 'xts' },
    });
    // The request, not the observed mode, keeps a key on the reserve list (S4).
    expect(first.reserve).toEqual(['db', 'old']);
    expect(integrityCondition(first, { state: 'read', listing: new Map() })).toMatchObject({
      status: 'False',
      reason: 'IntegrityNotApplied',
      message: expect.stringContaining('old (XTS)'),
    });
    const second = planStorage({
      records: first.records,
      workloads,
      integrity: 'AEAD',
      listing: listing({ db: 'reserved', old: 'aead', act: 'xts', x: 'xts' }),
    });
    expect(second.records.db?.mode).toBe('AEAD');
    expect(second.records.old?.mode).toBe('XTS');
    expect(second.records.act?.mode).toBe('NotEncfs');
  });

  it('never records AEAD on an Other key', () => {
    const plan = planStorage({
      records: { act: { kind: 'Other' } },
      workloads: [workload('act')],
      integrity: 'AEAD',
      listing: listing({ act: 'reserved' }),
    });
    expect(plan.records.act).toEqual({ kind: 'Other', observed: 'reserved' });
    expect(plan.conflicts).toEqual(['key act is recorded Other but its directory is reserved']);
  });

  it('backfills directories the listing finds, prunes only absent unused entries', () => {
    const plan = planStorage({
      records: {
        gone: { kind: 'Other', mode: 'NotEncfs', observed: 'absent' },
        used: { kind: 'Other', mode: 'NotEncfs', observed: 'absent' },
        stale: { kind: 'PgliteEncfs', mode: 'XTS', observed: 'xts' },
      },
      workloads: [workload('used')],
      integrity: 'Off',
      listing: listing({
        free: 'empty',
        a: 'xts',
        b: 'aead',
        c: 'reserved',
        d: 'unencrypted',
        e: 'other',
        used: 'unencrypted',
      }),
    });
    expect(plan.records).toEqual({
      used: { kind: 'Other', mode: 'NotEncfs', observed: 'unencrypted' },
      stale: { kind: 'PgliteEncfs', mode: 'XTS', observed: 'absent' },
      a: { kind: 'PgliteEncfs', mode: 'XTS', observed: 'xts' },
      b: { kind: 'PgliteEncfs', mode: 'AEAD', observed: 'aead' },
      c: { kind: 'PgliteEncfs', mode: 'AEAD', observed: 'reserved' },
      d: { kind: 'Other', mode: 'NotEncfs', observed: 'unencrypted' },
      e: { kind: 'Other', observed: 'other' },
    });
    expect(
      integrityCondition(plan, { state: 'read', listing: new Map([['used', 'empty']]) }),
    ).toEqual({
      status: 'False',
      reason: 'IntegrityMismatch',
      message: 'e (recorded without a mode, observed other)',
    });
  });

  it('refuses a key used by both kinds', () => {
    const fresh = planStorage({
      records: {},
      workloads: [workload('a', { key: 'mesh', pglite: true }), workload('b', { key: 'mesh' })],
      integrity: 'AEAD',
    });
    expect(fresh.records).toEqual({});
    expect(fresh.mounted).toEqual([]);
    expect(fresh.conflicts).toEqual([
      'key mesh is used by workloads of both kinds: a (PgliteEncfs), b (Other)',
    ]);
    const recorded = planStorage({
      records: { mesh: { kind: 'PgliteEncfs', requested: 'Off' } },
      workloads: [workload('a', { key: 'mesh', pglite: true }), workload('b', { key: 'mesh' })],
      integrity: 'AEAD',
    });
    expect(recorded.mounted).toEqual(['mesh']);
    expect(recorded.conflicts).toEqual([
      'key mesh is recorded PgliteEncfs; not mounted for b (Other)',
    ]);
    const stray = planStorage({
      records: { mesh: { kind: 'PgliteEncfs', requested: 'Off' } },
      workloads: [workload('b', { key: 'mesh' })],
      integrity: 'AEAD',
    });
    expect(stray.mounted).toEqual([]);
    const records = recorded.records;
    expect(storageAllowed(records, workload('a', { key: 'mesh', pglite: true }))).toBe(true);
    expect(storageAllowed(records, workload('b', { key: 'mesh' }))).toBe(false);
    expect(storageAllowed(records, workload('c'))).toBe(false);
    expect(storageAllowed(records, workload('d', { key: '..' }))).toBe(false);
  });

  it('records nothing new at the size bound', () => {
    const full: StorageRecords = {};
    for (let i = 0; i < STORAGE_RECORD_LIMIT; i++) full[`k${i}`] = { kind: 'Other' };
    const plan = planStorage({
      records: full,
      workloads: [workload('k0'), workload('extra')],
      integrity: 'Off',
      listing: listing({ k0: 'empty', more: 'xts' }),
    });
    expect(plan.mounted).toEqual(['k0']);
    expect(plan.records.extra).toBeUndefined();
    expect(plan.records.more).toBeUndefined();
    expect(plan.limited).toEqual(['key extra (extra (Other))', 'directory more']);
    expect(
      integrityCondition(plan, { state: 'read', listing: new Map([['k0', 'empty']]) }),
    ).toMatchObject({
      reason: 'RecordLimitReached',
    });
  });

  it('writes only the changes, and removes pruned entries with null', () => {
    expect(recordsPatch({ a: { kind: 'Other' } }, { a: { kind: 'Other' } })).toBeUndefined();
    expect(
      recordsPatch(
        { a: { kind: 'Other', observed: 'absent' }, b: { kind: 'Other' } },
        { b: { kind: 'Other', observed: 'empty' }, c: { kind: 'Other' } },
      ),
    ).toEqual({ a: null, b: { kind: 'Other', observed: 'empty' }, c: { kind: 'Other' } });
  });

  it('reports the first reason and counts the others', () => {
    const plan = planStorage({
      records: { x: { kind: 'PgliteEncfs', mode: 'AEAD' }, y: { kind: 'Other', mode: 'NotEncfs' } },
      workloads: [workload('a', { key: 'm', pglite: true }), workload('b', { key: 'm' })],
      integrity: 'Off',
      listing: listing({ x: 'xts', y: 'empty' }),
    });
    expect(
      integrityCondition(plan, { state: 'failed', message: 'pg: no room' }, 'foreign'),
    ).toEqual({
      status: 'False',
      reason: 'ObservationFailed',
      message:
        'pg: no room (also StorageKindConflict: 1, IntegrityMismatch: 1, StorageRecordsForeign: 1)',
    });
    expect(integrityCondition(plan, { state: 'read', listing: new Map() }, 'foreign').reason).toBe(
      'StorageKindConflict',
    );
    const quiet = planStorage({ records: {}, workloads: [workload('db')], integrity: 'Off' });
    expect(integrityCondition(quiet, { state: 'read', listing: new Map() }, 'cm')).toMatchObject({
      reason: 'StorageRecordsForeign',
      message: 'cm (also AwaitingObservation: 1)',
    });
    expect(integrityCondition(quiet, { state: 'pending' })).toEqual({
      status: 'Unknown',
      reason: 'AwaitingObservation',
      message: "the host pod's storage listing has not been read for db",
    });
    const none = planStorage({ records: {}, workloads: [], integrity: 'Off' });
    expect(integrityCondition(none, { state: 'pending' }).message).toBe(
      "the host pod's storage listing has not been read",
    );
    expect(
      integrityCondition(quiet, { state: 'read', listing: new Map([['db', 'empty']]) }),
    ).toEqual({
      status: 'True',
      reason: 'AsRecorded',
      message: '1 storage keys as recorded',
    });
  });

  it('treats each class against each recorded mode', () => {
    const condition = (
      mode: 'XTS' | 'AEAD' | 'NotEncfs' | undefined,
      observed: StorageClass | 'absent',
    ) =>
      integrityCondition(
        {
          records: {
            k: { kind: 'PgliteEncfs', requested: 'Off', ...(mode ? { mode } : {}), observed },
          },
          mounted: [],
          reserve: [],
          conflicts: [],
          limited: [],
        },
        { state: 'read', listing: new Map() },
      ).reason;
    expect(condition('XTS', 'xts')).toBe('AsRecorded');
    expect(condition('XTS', 'empty')).toBe('IntegrityMismatch');
    expect(condition('XTS', 'aead')).toBe('IntegrityMismatch');
    expect(condition('AEAD', 'reserved')).toBe('AsRecorded');
    expect(condition('AEAD', 'aead')).toBe('AsRecorded');
    expect(condition('AEAD', 'empty')).toBe('IntegrityMismatch');
    expect(condition('NotEncfs', 'empty')).toBe('AsRecorded');
    expect(condition('NotEncfs', 'xts')).toBe('IntegrityMismatch');
    expect(condition('AEAD', 'absent')).toBe('AsRecorded');
    expect(condition(undefined, 'empty')).toBe('AsRecorded');
    expect(condition(undefined, 'other')).toBe('IntegrityMismatch');
  });
});

describe('Tenant CRD storage fields (#200)', () => {
  const tenantCrd = crds.find(
    (c) => c.metadata.name === 'tenants.platform.di-framework.dev',
  ) as unknown as {
    spec: { versions: { schema: { openAPIV3Schema: { properties: Record<string, any> } } }[] };
  };
  const schema = tenantCrd.spec.versions[0]?.schema.openAPIV3Schema.properties;

  it('takes spec.storage.integrity Off or AEAD, default Off', () => {
    expect(schema?.spec.properties.storage).toEqual({
      type: 'object',
      default: {},
      properties: { integrity: { type: 'string', enum: ['Off', 'AEAD'], default: 'Off' } },
    });
  });

  it('bounds status.storage.keys as a map of records', () => {
    const keys = schema?.status.properties.storage.properties.keys;
    expect(keys.maxProperties).toBe(2048);
    expect(keys.additionalProperties.required).toEqual(['kind']);
    expect(keys.additionalProperties.properties.mode.enum).toEqual(['XTS', 'AEAD', 'NotEncfs']);
  });
});

const policies = admissionResources('test', 'wasmcloud');
const policy = (name: string) =>
  policies.find(
    (r) => r.kind === 'ValidatingAdmissionPolicy' && r.metadata.name === name,
  ) as Resource & {
    spec: {
      variables?: { name: string; expression: string }[];
      validations: { expression: string; message: string }[];
      matchConstraints: unknown;
    };
  };

describe('storage-format admission (#200)', () => {
  const spec = policy('test-workloads').spec;
  const messages = [
    STORAGE_FORMAT_VALUE_MESSAGE,
    STORAGE_FORMAT_STORAGE_MESSAGE,
    STORAGE_FORMAT_ACTORS_MESSAGE,
    STORAGE_FORMAT_IMMUTABLE_MESSAGE,
  ];
  const cel = (
    operation: string,
    annotations?: Record<string, string>,
    old?: Record<string, string>,
  ) => {
    const request = { operation };
    const object = { metadata: annotations ? { annotations } : {} };
    const oldObject = operation === 'UPDATE' ? { metadata: old ? { annotations: old } : {} } : null;
    const variables: Record<string, unknown> = {};
    for (const name of ['hasFormat', 'format', 'hadFormat', 'oldFormat', 'formatChanged']) {
      const expression = spec.variables?.find((v) => v.name === name)?.expression as string;
      variables[name] = evaluate(expression, { request, object, oldObject, variables });
    }
    return messages.filter((message) => {
      const rule = spec.validations.find((v) => v.message === message) as { expression: string };
      return evaluate(rule.expression, { request, object, oldObject, variables }) !== true;
    });
  };

  const storage = { [STORAGE_ANNOTATION]: 'true' };
  const pg = { ...storage, [STORAGE_FORMAT_ANNOTATION]: 'pglite-encfs' };
  const cases: [
    string,
    'CREATE' | 'UPDATE',
    Record<string, string> | undefined,
    Record<string, string> | undefined,
    string[],
  ][] = [
    ['plain create', 'CREATE', undefined, undefined, []],
    ['pglite create', 'CREATE', pg, undefined, []],
    [
      'bad value',
      'CREATE',
      { ...storage, [STORAGE_FORMAT_ANNOTATION]: 'sqlite' },
      undefined,
      [STORAGE_FORMAT_VALUE_MESSAGE],
    ],
    [
      'no storage',
      'CREATE',
      { [STORAGE_FORMAT_ANNOTATION]: 'pglite-encfs' },
      undefined,
      [STORAGE_FORMAT_STORAGE_MESSAGE],
    ],
    [
      'actors',
      'CREATE',
      { ...pg, [STORAGE_MOUNT_ANNOTATION]: '/data/actors' },
      undefined,
      [STORAGE_FORMAT_ACTORS_MESSAGE],
    ],
    ['data mount', 'CREATE', { ...pg, [STORAGE_MOUNT_ANNOTATION]: '/data' }, undefined, []],
    ['unchanged update', 'UPDATE', pg, pg, []],
    // Not ratcheting: an old invalid value that does not change is not checked again.
    [
      'legacy value kept',
      'UPDATE',
      { [STORAGE_FORMAT_ANNOTATION]: 'x' },
      { [STORAGE_FORMAT_ANNOTATION]: 'x' },
      [],
    ],
    ['legacy value removed', 'UPDATE', storage, { [STORAGE_FORMAT_ANNOTATION]: 'x' }, []],
    ['added on update', 'UPDATE', pg, storage, [STORAGE_FORMAT_IMMUTABLE_MESSAGE]],
    ['removed on update', 'UPDATE', storage, pg, [STORAGE_FORMAT_IMMUTABLE_MESSAGE]],
    [
      'changed on update',
      'UPDATE',
      { ...pg, [STORAGE_FORMAT_ANNOTATION]: 'y' },
      pg,
      [STORAGE_FORMAT_VALUE_MESSAGE, STORAGE_FORMAT_IMMUTABLE_MESSAGE],
    ],
    ['update without annotations', 'UPDATE', undefined, undefined, []],
  ];

  it('agrees with its TypeScript mirror on every case', () => {
    for (const [name, operation, annotations, old, expected] of cases) {
      expect(
        `${name}: ${workloadStorageFormatDenials({ operation, annotations, oldAnnotations: old }).join('|')}`,
      ).toBe(`${name}: ${expected.join('|')}`);
      expect(`${name}: ${cel(operation, annotations, old).join('|')}`).toBe(
        `${name}: ${expected.join('|')}`,
      );
    }
  });

  it('applies to every user, the controller included', () => {
    for (const message of messages) {
      const rule = spec.validations.find((v) => v.message === message);
      expect(rule?.expression).not.toContain('variables.controller');
    }
  });
});

describe('tenants/status storage records policy (#200)', () => {
  const spec = policy('test-tenant-storage-records').spec;
  const binding = policies.find(
    (r) =>
      r.kind === 'ValidatingAdmissionPolicyBinding' &&
      r.metadata.name === 'test-tenant-storage-records',
  );
  const tenantWith = (keys?: StorageRecords) => (keys ? { status: { storage: { keys } } } : {});
  const cel = (old?: StorageRecords, next?: StorageRecords) =>
    spec.validations
      .filter(
        (rule) =>
          evaluate(rule.expression, { oldObject: tenantWith(old), object: tenantWith(next) }) !==
          true,
      )
      .map((rule) => rule.message);

  it('matches only tenants/status updates and binds without a namespace selector', () => {
    expect(spec.matchConstraints).toEqual({
      resourceRules: [
        {
          apiGroups: ['platform.di-framework.dev'],
          apiVersions: ['*'],
          operations: ['UPDATE'],
          resources: ['tenants/status'],
        },
      ],
    });
    expect(binding?.spec).toEqual({
      policyName: 'test-tenant-storage-records',
      validationActions: ['Deny'],
    });
  });

  const pg = { kind: 'PgliteEncfs' as const, requested: 'AEAD' as const };
  const cases: [string, StorageRecords | undefined, StorageRecords | undefined, string[]][] = [
    ['no records', undefined, undefined, []],
    ['first records', undefined, { a: pg, b: { kind: 'Other' } }, []],
    ['mode set', { a: pg }, { a: { ...pg, mode: 'AEAD', observed: 'reserved' } }, []],
    [
      'observed changes',
      { a: { ...pg, mode: 'AEAD', observed: 'reserved' } },
      { a: { ...pg, mode: 'AEAD', observed: 'aead' } },
      [],
    ],
    ['kind changed', { a: pg }, { a: { ...pg, kind: 'Other' } }, [STORAGE_RECORDS_KEPT_MESSAGE]],
    [
      'requested changed',
      { a: pg },
      { a: { ...pg, requested: 'Off' } },
      [STORAGE_RECORDS_KEPT_MESSAGE],
    ],
    [
      'requested added',
      { a: { kind: 'PgliteEncfs', mode: 'XTS' } },
      { a: { kind: 'PgliteEncfs', mode: 'XTS', requested: 'Off' } },
      [STORAGE_RECORDS_KEPT_MESSAGE],
    ],
    [
      'mode changed',
      { a: { ...pg, mode: 'AEAD' } },
      { a: { ...pg, mode: 'XTS' } },
      [STORAGE_RECORDS_KEPT_MESSAGE],
    ],
    ['mode removed', { a: { ...pg, mode: 'AEAD' } }, { a: pg }, [STORAGE_RECORDS_KEPT_MESSAGE]],
    ['removed while present', { a: pg }, {}, [STORAGE_RECORDS_KEPT_MESSAGE]],
    ['records dropped', { a: pg }, undefined, [STORAGE_RECORDS_KEPT_MESSAGE]],
    ['absent pruned', { a: { ...pg, observed: 'absent' } }, {}, []],
    [
      'pglite without request or mode',
      undefined,
      { a: { kind: 'PgliteEncfs' } },
      [STORAGE_RECORDS_NEW_MESSAGE],
    ],
    ['backfilled pglite', {}, { a: { kind: 'PgliteEncfs', mode: 'XTS' } }, []],
    [
      'other with request',
      undefined,
      { a: { kind: 'Other', requested: 'Off' } },
      [STORAGE_RECORDS_NEW_MESSAGE],
    ],
    [
      'other aead',
      undefined,
      { a: { kind: 'Other', mode: 'AEAD' } },
      [STORAGE_RECORDS_AEAD_MESSAGE],
    ],
  ];

  it('agrees with its TypeScript mirror on every case', () => {
    for (const [name, old, next, expected] of cases) {
      expect(`${name}: ${storageRecordsDenials(old, next).join('|')}`).toBe(
        `${name}: ${expected.join('|')}`,
      );
      expect(`${name}: ${cel(old, next).join('|')}`).toBe(`${name}: ${expected.join('|')}`);
    }
  });

  it('accepts every transition the planner makes', () => {
    let records: StorageRecords = {};
    const steps: [WorkloadDeployment[], Record<string, StorageClass> | undefined][] = [
      [[workload('db', { pglite: true }), workload('act')], undefined],
      [
        [workload('db', { pglite: true }), workload('act')],
        { db: 'reserved', act: 'empty', old: 'xts' },
      ],
      [[workload('db', { pglite: true })], { db: 'aead', old: 'xts' }],
      [[workload('db', { pglite: true })], { db: 'aead' }],
      [[workload('db', { pglite: true })], { db: 'aead' }],
    ];
    for (const [workloads, found] of steps) {
      const next = planStorage({
        records,
        workloads,
        integrity: 'AEAD',
        listing: found ? listing(found) : undefined,
      }).records;
      expect(storageRecordsDenials(records, next)).toEqual([]);
      expect(cel(records, next)).toEqual([]);
      records = next;
    }
    expect(Object.keys(records)).toEqual(['db']);
  });
});
