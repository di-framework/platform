import { describe, expect, test } from 'bun:test';
import { handle, render } from '../src/console.ts';
import { applyActions, type KubeClient, loadWorld } from '../src/kube.ts';
import {
  DUMP_CAP_BYTES,
  endpointAllowed,
  jobName,
  parseBytes,
  pickS3Owner,
  postgresConnectionSecret,
  runtimeNamespaceFor,
  type World,
} from '../src/model.ts';
import { jobBody, reconcile, reconcileAll } from '../src/reconcile.ts';
import { cronMatches, isDue, previousFire } from '../src/schedule.ts';

function world(overrides: Partial<World> = {}): World {
  return {
    now: '2026-09-28T15:00:00.000Z',
    tenantNamespace: 'di-tenant-alpha',
    runtimeNamespace: 'di-runtime-alpha',
    agentImage: 'di-framework/backup-agent:dev',
    services: [],
    backups: [],
    restores: [],
    jobs: [],
    runtimeSecretPresent: true,
    credentialKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    networkEgress: [],
    destination: {
      name: 'default',
      generation: 2,
      annotations: {},
      spec: {
        type: 's3',
        bucket: 'tenant-alpha-backups',
        credentialsSecretRef: { name: 'di-backup-s3' },
        schedule: '0 2 * * *',
      },
      status: { lastAttemptTime: '2026-09-28T02:00:00.000Z' },
    },
    ...overrides,
  };
}

const orders = {
  name: 'orders',
  uid: 'uid-orders',
  type: 'postgres' as const,
  className: 'postgres-dedicated',
  storage: '1Gi',
  memory: '512Mi',
  cpu: '250m',
  ready: true,
  suspended: false,
  deleting: false,
};

describe('schedule and names', () => {
  test('matches the daily UTC schedule and rejects malformed cron', () => {
    const atTwo = new Date('2026-09-28T02:00:00Z');
    expect(cronMatches('0 2 * * *', atTwo)).toBe(true);
    expect(cronMatches('0 2 * * *', new Date('2026-09-28T03:00:00Z'))).toBe(false);
    expect(cronMatches('not cron', atTwo)).toBe(false);
    expect(cronMatches('* * * *', atTwo)).toBe(false);
    expect(cronMatches('*/15 0-2 1,15 1-6 1-5', new Date('2026-01-15T02:15:00Z'))).toBe(true);
    expect(cronMatches('*/0 * * * *', atTwo)).toBe(false);
    expect(cronMatches('nope * * * *', atTwo)).toBe(false);
    expect(cronMatches('0 2 * * 7', new Date('2026-09-27T02:00:00Z'))).toBe(true);
    expect(previousFire('0 2 31 2 *', atTwo)).toBeUndefined();
    expect(isDue('0 2 * * *', undefined, new Date('2026-09-28T15:00:00Z'))).toBe(true);
    expect(isDue('0 2 * * *', 'not-a-date', new Date('2026-09-28T15:00:00Z'))).toBe(true);
    expect(isDue('0 2 31 2 *', undefined, atTwo)).toBe(false);
    expect(isDue('0 2 * * *', '2026-09-28T02:00:00.000Z', new Date('2026-09-28T15:00:00Z'))).toBe(
      false,
    );
  });

  test('derives the runtime namespace wasmCloud already created', () => {
    expect(runtimeNamespaceFor('di-tenant-alpha')).toBe('di-runtime-alpha');
    expect(() => runtimeNamespaceFor('kube-system')).toThrow(/wasmCloud tenant namespace/);
    expect(() => runtimeNamespaceFor('di-tenant-')).toThrow(/wasmCloud tenant namespace/);
    expect(parseBytes('1.5Gi')).toBe(1.5 * 1024 ** 3);
    expect(parseBytes('2Ki')).toBe(2048);
    expect(parseBytes('3Mi')).toBe(3 * 1024 ** 2);
    expect(parseBytes('1Ti')).toBe(1024 ** 4);
    expect(parseBytes('10')).toBe(10);
    expect(parseBytes('nope')).toBeUndefined();
    expect(parseBytes(undefined)).toBeUndefined();
    expect(endpointAllowed(undefined)).toBe(true);
    expect(endpointAllowed('https://s3.amazonaws.com')).toBe(true);
    expect(endpointAllowed('http://rustfs.wasmcloud.svc.cluster.local:9000')).toBe(true);
    expect(endpointAllowed('http://localhost:9000')).toBe(true);
    expect(endpointAllowed('http://attacker:9000')).toBe(false);
    expect(endpointAllowed('ftp://files')).toBe(false);
    expect(endpointAllowed('not a url')).toBe(false);
    expect(postgresConnectionSecret('orders', 'uid-orders')).toMatch(
      /^di-pg-orders-[0-9a-f]{16}-conn$/,
    );
    expect(jobName('di-backup', 'orders', 10).length).toBeLessThanOrEqual(63);
    const truncated = jobName(
      'di-backup',
      'service-name-that-is-quite-long-already-and-more',
      1_725_000_000,
    );
    expect(truncated.length).toBeLessThanOrEqual(63);
    expect(truncated).toContain('di-backup-');
    expect(DUMP_CAP_BYTES).toBe(4 * 1024 ** 3);
  });
});

describe('reconcile', () => {
  test('stops for an empty namespace, a suspended tenant, a bad endpoint, and missing keys', () => {
    expect(reconcile(world({ destination: undefined }))).toEqual([]);
    expect(
      JSON.stringify(
        reconcile(
          world({
            destination: {
              ...world().destination!,
              spec: { ...world().destination!.spec, suspend: true },
            },
          }),
        ),
      ),
    ).toContain('TenantSuspended');
    const rejected = reconcile(
      world({
        destination: {
          ...world().destination!,
          spec: { ...world().destination!.spec, endpoint: 'http://attacker:9000' },
        },
      }),
    );
    expect(JSON.stringify(rejected)).toContain('EndpointRejected');
    const missing = reconcile(world({ credentialKeys: ['AWS_ACCESS_KEY_ID'] }));
    expect(JSON.stringify(missing)).toContain('CredentialsInvalid');
    const unnamed = reconcile(
      world({
        destination: {
          ...world().destination!,
          spec: { ...world().destination!.spec, credentialsSecretRef: {} },
        },
      }),
    );
    expect(JSON.stringify(unnamed)).toContain('CredentialsInvalid');
  });

  test('copies credentials, syncs egress, and starts a postgres dump when the schedule is due', () => {
    const actions = reconcile(
      world({
        runtimeSecretPresent: false,
        networkEgress: [],
        services: [orders],
        destination: {
          ...world().destination!,
          status: {},
          annotations: { 'platform.di-framework.dev/backup-now': '2026-09-28T15:00:00.000Z' },
          spec: {
            ...world().destination!.spec,
            endpoint: 'http://rustfs.wasmcloud.svc.cluster.local:9000',
            extraEgress: [{ cidr: '10.8.0.10/32', port: 9000, protocol: 'TCP' }],
          },
        },
      }),
    );
    expect(actions.some((action) => action.type === 'copy-credentials')).toBe(true);
    expect(actions.some((action) => action.type === 'sync-egress')).toBe(true);
    expect(actions.some((action) => action.type === 'clear-annotation')).toBe(true);
    const job = actions.find((action) => action.type === 'create-job');
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain('secretKeyRef');
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).not.toContain(
      'super-secret',
    );
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain(
      'di-runtime-alpha',
    );
    expect(actions.some((action) => action.type === 'create-backup')).toBe(true);
  });

  test('skips oversized, unready, and deleting services, then records a finished dump', () => {
    const huge = reconcile(
      world({
        services: [
          { ...orders, storage: '5Gi', name: 'huge' },
          { ...orders, ready: false, name: 'cold' },
          { ...orders, deleting: true, name: 'gone' },
        ],
        destination: { ...world().destination!, status: {} },
      }),
    );
    expect(JSON.stringify(huge)).toContain('DumpTooLarge');
    expect(JSON.stringify(huge)).toContain('NotReady');
    expect(huge.some((action) => action.type === 'create-job')).toBe(false);

    const finished = reconcile(
      world({
        services: [orders],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Running',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        jobs: [
          {
            name: 'di-backup-orders-1',
            backupKind: 'dump',
            serviceName: 'orders',
            phase: 'Succeeded',
            backupName: 'di-backup-orders-1',
            message: JSON.stringify({
              ok: true,
              digest: 'sha256:abc',
              bytes: 4,
              objectKey: 'k/data.dump',
              format: 'custom',
            }),
          },
        ],
        destination: {
          ...world().destination!,
          status: {
            lastAttemptTime: '2026-09-28T02:00:00.000Z',
            services: [
              {
                name: 'orders',
                type: 'postgres',
                lastAttemptTime: '2026-09-28T02:00:00.000Z',
                lastBackupName: 'di-backup-orders-1',
                lastReason: 'Running',
              },
            ],
          },
        },
      }),
    );
    expect(JSON.stringify(finished)).toContain('Succeeded');
    const again = reconcile(
      world({
        services: [orders],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Succeeded',
            objectKey: 'k/data.dump',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        jobs: [
          {
            name: 'di-backup-orders-1',
            backupKind: 'dump',
            serviceName: 'orders',
            phase: 'Succeeded',
            backupName: 'di-backup-orders-1',
            message: '{"ok":true}',
          },
        ],
        destination: {
          ...world().destination!,
          status: {
            lastAttemptTime: '2026-09-28T02:00:00.000Z',
            services: [
              {
                name: 'orders',
                type: 'postgres',
                lastAttemptTime: '2026-09-28T02:00:00.000Z',
                lastBackupName: 'di-backup-orders-1',
                lastReason: 'Completed',
                lastSuccessTime: '2026-09-28T02:01:00.000Z',
              },
            ],
          },
        },
      }),
    );
    expect(again.some((action) => action.type === 'backup-status')).toBe(false);
    expect(JSON.stringify(again)).toContain('DestinationReady');
  });

  test('marks a failed dump, restores into an empty target, and garbage-collects extras', () => {
    const failed = reconcile(
      world({
        services: [orders],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Running',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        jobs: [
          {
            name: 'job',
            backupKind: 'dump',
            serviceName: 'orders',
            phase: 'Failed',
            backupName: 'di-backup-orders-1',
            message: 'not-json',
          },
        ],
      }),
    );
    expect(JSON.stringify(failed)).toContain('DumpFailed');

    const probe = reconcile(
      world({
        services: [orders, { ...orders, name: 'orders-restored', uid: 'uid-2' }],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Succeeded',
            objectKey: 'di-framework/alpha/orders/uid/20260927T020012Z/data.dump',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        restores: [
          {
            name: 'restore-orders-restored',
            sourceBackupName: 'di-backup-orders-1',
            targetServiceName: 'orders-restored',
          },
        ],
      }),
    );
    expect(JSON.stringify(probe)).toContain('probe-empty');
    const mismatch = reconcile(
      world({
        services: [{ ...orders, name: 'cache', type: 'keyvalue', className: 'keyvalue-redis' }],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Succeeded',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        restores: [{ name: 'r', sourceBackupName: 'missing', targetServiceName: 'cache' }],
      }),
    );
    expect(JSON.stringify(mismatch)).toContain('BackupNotFound');
    const wrong = reconcile(
      world({
        services: [{ ...orders, name: 'cache', type: 'keyvalue', className: 'keyvalue-redis' }],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Succeeded',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        restores: [
          { name: 'r', sourceBackupName: 'di-backup-orders-1', targetServiceName: 'cache' },
        ],
      }),
    );
    expect(JSON.stringify(wrong)).toContain('TargetMismatch');
    const done = reconcile(
      world({
        services: [orders, { ...orders, name: 'orders-restored', uid: 'uid-2' }],
        backups: [
          {
            name: 'di-backup-orders-1',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Succeeded',
            objectKey: 'p/data.dump',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        restores: [
          {
            name: 'restore-orders-restored',
            sourceBackupName: 'di-backup-orders-1',
            targetServiceName: 'orders-restored',
          },
        ],
        jobs: [
          {
            name: 'probe',
            backupKind: 'probe',
            serviceName: 'orders-restored',
            phase: 'Succeeded',
            backupName: 'restore-orders-restored',
            message: '{"ok":true}',
          },
        ],
      }),
    );
    expect(JSON.stringify(done)).toContain('restore-postgres');
    const empty = reconcile(
      world({
        restores: [
          {
            name: 'restore-orders-restored',
            sourceBackupName: 'di-backup-orders-1',
            targetServiceName: 'orders-restored',
          },
        ],
        jobs: [
          {
            name: 'probe',
            backupKind: 'probe',
            serviceName: 'orders-restored',
            phase: 'Failed',
            backupName: 'restore-orders-restored',
            message: '{"ok":false,"error":"TargetNotEmpty"}',
          },
        ],
      }),
    );
    expect(JSON.stringify(empty)).toContain('TargetNotEmpty');

    const backups = Array.from({ length: 3 }, (_, index) => ({
      name: `b${index}`,
      serviceName: 'orders',
      destinationName: 'default',
      phase: 'Succeeded' as const,
      objectKey: `k/${index}/data.dump`,
      uid: orders.uid,
      type: 'postgres',
      className: orders.className,
      storage: '1Gi',
      createdAt: `2026-09-2${index}T00:00:00.000Z`,
    }));
    const gc = reconcile(
      world({
        services: [orders],
        backups,
        destination: {
          ...world().destination!,
          spec: { ...world().destination!.spec, retention: { successful: 1 } },
        },
      }),
    );
    expect(JSON.stringify(gc)).toContain('backup-kind":"gc"');
    const removed = reconcile(
      world({
        jobs: [
          {
            name: 'di-gc-alpha-1',
            backupKind: 'gc',
            serviceName: '',
            phase: 'Succeeded',
            message: '{"ok":true}',
            gcBackups: ['b0'],
          },
        ],
      }),
    );
    expect(removed.some((action) => action.type === 'delete-backup' && action.name === 'b0')).toBe(
      true,
    );
  });

  test('waits while a job is running and builds a two-copy redis restore job', () => {
    const running = reconcile(
      world({
        jobs: [{ name: 'job', backupKind: 'dump', serviceName: 'orders', phase: 'Running' }],
      }),
    );
    expect(JSON.stringify(running)).toContain('BackupInProgress');
    const body = jobBody({
      world: world(),
      name: 'di-restore-cache-1',
      backupKind: 'restore',
      agentKind: 'restore-redis',
      service: { ...orders, type: 'keyvalue', name: 'cache' },
      objectPrefix: 'p',
      storage: '1Gi',
    });
    expect(JSON.stringify(body)).toContain('restore-redis');
    expect(JSON.stringify(body)).toContain('sizeLimit');
    const nats = jobBody({
      world: world(),
      name: 'di-backup-events-1',
      backupKind: 'dump',
      agentKind: 'nats',
      service: { ...orders, type: 'messaging', name: 'events' },
      objectPrefix: 'p',
      gcBackups: ['old'],
    });
    expect(JSON.stringify(nats)).toContain('gc-backups');
    const blank = jobBody({
      world: world(),
      name: 'di-probe-orders-1',
      backupKind: 'probe',
      agentKind: 'probe-empty',
      service: orders,
      objectPrefix: '',
      storage: 'nope',
    });
    expect(JSON.stringify(blank)).toContain('sizeLimit');
  });

  test('covers redis and nats restores plus terminal job results', () => {
    const redis = reconcile(
      world({
        services: [
          {
            ...orders,
            name: 'cache',
            uid: 'uid-cache',
            type: 'keyvalue',
            className: 'keyvalue-redis',
          },
        ],
        backups: [
          {
            name: 'b',
            serviceName: 'cache',
            destinationName: 'default',
            phase: 'Succeeded',
            objectKey: 'p/dump.rdb',
            uid: 'uid-cache',
            type: 'keyvalue',
            className: 'keyvalue-redis',
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        restores: [{ name: 'r', sourceBackupName: 'b', targetServiceName: 'cache' }],
        jobs: [
          {
            name: 'probe',
            backupKind: 'probe',
            serviceName: 'cache',
            phase: 'Succeeded',
            backupName: 'r',
            message: '{"ok":true}',
          },
        ],
      }),
    );
    expect(JSON.stringify(redis)).toContain('restore-redis');
    const nats = reconcile(
      world({
        services: [
          {
            ...orders,
            name: 'events',
            uid: 'uid-events',
            type: 'messaging',
            className: 'messaging-nats',
          },
        ],
        backups: [
          {
            name: 'b',
            serviceName: 'events',
            destinationName: 'default',
            phase: 'Succeeded',
            uid: 'uid-events',
            type: 'messaging',
            className: 'messaging-nats',
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        restores: [{ name: 'r', sourceBackupName: 'b', targetServiceName: 'events' }],
        jobs: [
          {
            name: 'probe',
            backupKind: 'probe',
            serviceName: 'events',
            phase: 'Succeeded',
            backupName: 'r',
            message: '{"ok":true}',
          },
        ],
      }),
    );
    expect(JSON.stringify(nats)).toContain('restore-nats');
    const restored = reconcile(
      world({
        restores: [{ name: 'r', sourceBackupName: 'b', targetServiceName: 'cache' }],
        jobs: [
          {
            name: 'ok',
            backupKind: 'restore',
            serviceName: 'cache',
            phase: 'Succeeded',
            backupName: 'r',
            message: '{"ok":true}',
          },
          {
            name: 'bad',
            backupKind: 'restore',
            serviceName: 'cache',
            phase: 'Failed',
            backupName: 'missing',
            message: '{"ok":false}',
          },
          {
            name: 'gc',
            backupKind: 'gc',
            serviceName: '',
            phase: 'Succeeded',
            message: '{"ok":true}',
          },
        ],
      }),
    );
    expect(JSON.stringify(restored)).toContain('restore completed');
    const noted = reconcile(
      world({
        services: [
          orders,
          { ...orders, name: 'paused', ready: true, suspended: true },
          { ...orders, name: 'sleeping', suspended: true },
        ],
        backups: [
          {
            name: 'b',
            serviceName: 'orders',
            destinationName: 'default',
            phase: 'Succeeded',
            uid: orders.uid,
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
          {
            name: 'f',
            serviceName: 'paused',
            destinationName: 'default',
            phase: 'Failed',
            uid: 'uid-paused',
            type: 'postgres',
            className: orders.className,
            storage: '1Gi',
            createdAt: '2026-09-28T02:00:00.000Z',
          },
        ],
        destination: {
          ...world().destination!,
          spec: { ...world().destination!.spec, schedule: '' },
          status: {
            lastAttemptTime: '2026-09-28T02:00:00.000Z',
            services: [
              {
                name: 'orders',
                type: 'postgres',
                lastBackupName: 'b',
                lastReason: 'Running',
                lastAttemptTime: '2026-09-28T02:00:00.000Z',
              },
              {
                name: 'paused',
                type: 'postgres',
                lastBackupName: 'f',
                lastReason: 'Running',
                lastAttemptTime: '2026-09-28T02:00:00.000Z',
              },
            ],
          },
        },
      }),
    );
    expect(JSON.stringify(noted)).toContain('Completed');
    expect(JSON.stringify(noted)).toContain('DumpFailed');
    const mixed = reconcile(
      world({
        services: [
          {
            ...orders,
            name: 'events',
            uid: 'uid-events',
            type: 'messaging',
            className: 'messaging-nats',
          },
          {
            ...orders,
            name: 'cache',
            uid: 'uid-cache',
            type: 'keyvalue',
            className: 'keyvalue-redis',
          },
        ],
        destination: { ...world().destination!, status: {} },
      }),
    );
    expect(JSON.stringify(mixed)).toContain('redis-cli');
    const failedRestore = reconcile(
      world({
        restores: [{ name: 'r', sourceBackupName: 'b', targetServiceName: 'cache' }],
        jobs: [
          {
            name: 'bad',
            backupKind: 'restore',
            serviceName: 'cache',
            phase: 'Failed',
            backupName: 'r',
            message: 'not-json',
          },
        ],
      }),
    );
    expect(JSON.stringify(failedRestore)).toContain('RestoreFailed');
    const failures = Array.from({ length: 6 }, (_, index) => ({
      name: `f${index}`,
      serviceName: 'orders',
      destinationName: 'default',
      phase: 'Failed' as const,
      uid: orders.uid,
      type: 'postgres',
      className: orders.className,
      storage: '1Gi',
      createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
    }));
    const gc = reconcile(world({ services: [orders], backups: failures }));
    expect(JSON.stringify(gc)).toContain('backup-kind":"gc"');
  });
});

describe('console', () => {
  test('renders status without secrets and accepts backup and restore posts', () => {
    const current = world({
      services: [orders],
      backups: [
        {
          name: 'di-backup-orders-1',
          serviceName: 'orders',
          destinationName: 'default',
          phase: 'Succeeded',
          objectKey: 'k/data.dump',
          uid: orders.uid,
          type: 'postgres',
          className: orders.className,
          storage: '1Gi',
          createdAt: '2026-09-28T02:00:00.000Z',
        },
      ],
      destination: {
        ...world().destination!,
        status: {
          skipped: 1,
          enrolledServices: 1,
          conditions: [
            { type: 'Ready', status: 'True', reason: 'DestinationReady', message: 'ok' },
          ],
          services: [{ name: '<orders>', type: 'postgres', lastReason: 'Completed' }],
        },
      },
    });
    const html = render(current);
    expect(html).toContain('di-backup-orders-1');
    expect(html).toContain('&lt;orders&gt;');
    expect(html).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(html).not.toContain('super-secret-password');
    const posted = handle('POST', '/backups', '', current);
    expect(posted.actions.some((action) => action.type === 'annotate')).toBe(true);
    const restored = handle(
      'POST',
      '/restores',
      'source=di-backup-orders-1&target=orders-restored',
      current,
    );
    expect(restored.actions.some((action) => action.type === 'create-restore')).toBe(true);
    expect(
      handle('POST', '/restores', 'source=missing&target=orders-restored', current).status,
    ).toBe(400);
    expect(
      handle('POST', '/restores', 'source=di-backup-orders-1&target=orders', current).status,
    ).toBe(400);
    expect(handle('PUT', '/backups', '', current).status).toBe(405);
    expect(handle('GET', '/missing', '', current).status).toBe(404);
    expect(handle('GET', '/', '', world({ destination: undefined })).html).toContain('none');
    expect(handle('POST', '/backups', '', world({ destination: undefined })).actions).toEqual([]);
    expect(
      render(
        world({
          destination: {
            ...world().destination!,
            status: { services: [{ name: `a"b'c`, type: 'keyvalue' }] },
          },
        }),
      ),
    ).toContain('a&quot;b&#39;c');
  });
});

describe('kubernetes client', () => {
  test('loads a world and applies every action', async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const routes = new Map<string, unknown>([
      [
        '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backupdestinations',
        {
          items: [
            {
              metadata: { name: 'default', generation: 3, annotations: { note: 'x' } },
              spec: {
                bucket: 'b',
                credentialsSecretRef: { name: 'di-backup-s3' },
                extraEgress: [],
              },
              status: { lastAttemptTime: 't' },
            },
          ],
        },
      ],
      [
        '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backingservices',
        {
          items: [
            {
              metadata: { name: 'orders', uid: 'uid-orders' },
              spec: {
                type: 'postgres',
                className: 'postgres-dedicated',
                parameters: { storage: '1Gi' },
              },
              status: { conditions: [{ type: 'Ready', status: 'True' }] },
            },
            { metadata: { name: 'skip' }, spec: { type: 'warehouse' } },
            { spec: { type: 'postgres' } },
            null,
          ],
        },
      ],
      [
        '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backups',
        {
          items: [
            {
              metadata: { name: 'b1', creationTimestamp: 't' },
              spec: {
                serviceName: 'orders',
                uid: 'uid-orders',
                type: 'postgres',
                className: 'postgres-dedicated',
                parameters: { storage: '1Gi' },
              },
              status: {
                phase: 'Succeeded',
                objectKey: 'k',
                digest: 'sha256:abc',
                bytes: 1,
                reason: 'Completed',
              },
            },
            {
              metadata: { name: 'b2' },
              spec: {},
              status: { phase: 'Other', objectKey: 1, bytes: 'x' },
            },
            { metadata: {} },
          ],
        },
      ],
      [
        '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backuprestores',
        {
          items: [
            {
              metadata: { name: 'r1' },
              spec: { sourceBackupName: 'b1', targetServiceName: 'next' },
              status: { phase: 'Running', reason: 'Waiting' },
            },
          ],
        },
      ],
      [
        '/apis/batch/v1/namespaces/di-runtime-alpha/jobs',
        {
          items: [
            {
              metadata: {
                name: 'job',
                labels: {
                  'platform.di-framework.dev/backup-kind': 'dump',
                  'platform.di-framework.dev/service': 'orders',
                  'platform.di-framework.dev/backup-name': 'b1',
                },
                annotations: { 'platform.di-framework.dev/gc-backups': 'old,' },
              },
              status: { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] },
            },
            {
              metadata: {
                name: 'retry',
                labels: { 'platform.di-framework.dev/backup-kind': 'dump' },
              },
              status: { failed: 1 },
            },
            {
              metadata: {
                name: 'live',
                labels: { 'platform.di-framework.dev/backup-kind': 'probe' },
              },
              status: {},
            },
            {
              metadata: {
                name: 'other',
                labels: { 'platform.di-framework.dev/backup-kind': 'nope' },
              },
              status: {},
            },
          ],
        },
      ],
      [
        '/api/v1/namespaces/di-runtime-alpha/pods',
        {
          items: [
            {
              metadata: { ownerReferences: [{ name: 'job' }] },
              status: {
                containerStatuses: [{ state: { terminated: { message: '{"ok":false}' } } }],
              },
            },
          ],
        },
      ],
      [
        '/api/v1/namespaces/di-tenant-alpha/secrets',
        {
          items: [
            {
              metadata: { name: 'di-backup-s3' },
              data: { AWS_ACCESS_KEY_ID: 'YQ==', AWS_SECRET_ACCESS_KEY: 'Yg==' },
            },
          ],
        },
      ],
      [
        '/api/v1/namespaces/di-tenant-alpha/secrets/di-backup-s3',
        { data: { AWS_ACCESS_KEY_ID: 'YQ==', AWS_SECRET_ACCESS_KEY: 'Yg==' } },
      ],
      [
        '/apis/networking.k8s.io/v1/namespaces/di-runtime-alpha/networkpolicies/di-backup-agent-network',
        {
          spec: {
            egress: [
              { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ port: 443 }] },
              { to: [{ ipBlock: { cidr: '10.8.0.10/32' } }], ports: [{ port: 9000 }] },
            ],
          },
        },
      ],
    ]);
    const client: KubeClient = {
      async get(path) {
        calls.push({ method: 'GET', path });
        if (path.endsWith('/secrets/di-backup-destination'))
          return { data: { AWS_ACCESS_KEY_ID: 'YQ==' } };
        if (!(routes.has(path) || path.endsWith('/secrets/di-backup-destination')))
          throw new Error(path);
        return routes.get(path);
      },
      async post(path, body) {
        calls.push({ method: 'POST', path, body });
        if (
          path.endsWith('/secrets') &&
          calls.filter((call) => call.method === 'POST' && call.path.endsWith('/secrets'))
            .length === 1
        ) {
          throw new Error('exists');
        }
        return {};
      },
      async patch(path, body) {
        calls.push({ method: 'PATCH', path, body });
        return {};
      },
      async remove(path) {
        calls.push({ method: 'DELETE', path });
      },
    };
    const loaded = await loadWorld(
      client,
      'di-tenant-alpha',
      'image:dev',
      '2026-09-28T15:00:00.000Z',
    );
    expect(loaded.destination?.name).toBe('default');
    expect(loaded.services).toHaveLength(1);
    expect(loaded.jobs[0]?.message).toBe('{"ok":false}');
    expect(loaded.jobs[0]?.phase).toBe('Failed');
    expect(loaded.jobs.find((job) => job.name === 'retry')?.phase).toBe('Running');
    expect(loaded.networkEgress).toEqual([{ cidr: '10.8.0.10/32', port: 9000, protocol: 'TCP' }]);
    expect(loaded.credentialKeys).toContain('AWS_ACCESS_KEY_ID');
    const current = world();
    await applyActions(client, current, [
      { type: 'destination-status', status: { lastAttemptTime: 't' } },
      {
        type: 'annotate',
        name: 'default',
        key: 'platform.di-framework.dev/backup-now',
        value: 't',
      },
      { type: 'clear-annotation', name: 'default', key: 'platform.di-framework.dev/backup-now' },
      { type: 'copy-credentials', secretName: 'di-backup-s3' },
      { type: 'sync-egress', extraEgress: [{ cidr: '10.1.0.1/32', port: 9000, protocol: 'TCP' }] },
      { type: 'create-backup', body: { metadata: { name: 'b' } } },
      { type: 'create-restore', body: { metadata: { name: 'r' } } },
      { type: 'backup-status', name: 'b', status: { phase: 'Succeeded' } },
      { type: 'restore-status', name: 'r', status: { phase: 'Failed' } },
      { type: 'delete-backup', name: 'b' },
      { type: 'create-job', body: { metadata: { name: 'job', namespace: 'di-runtime-alpha' } } },
    ]);
    expect(
      calls.some(
        (call) => call.method === 'PATCH' && call.path.endsWith('/secrets/di-backup-destination'),
      ),
    ).toBe(true);
    expect(
      calls.find(
        (call) => call.method === 'PATCH' && call.path.endsWith('/di-backup-agent-network'),
      )?.body,
    ).toEqual({
      spec: {
        egress: [
          { to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ port: 443 }] },
          {
            to: [{ ipBlock: { cidr: '10.1.0.1/32' } }],
            ports: [{ protocol: 'TCP', port: 9000 }],
          },
        ],
      },
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  test('tolerates empty lists and a missing network policy', async () => {
    const client: KubeClient = {
      async get(path) {
        if (path.includes('networkpolicies') || path.endsWith('/secrets/di-backup-destination')) {
          throw new Error('missing');
        }
        if (path.endsWith('/secrets')) throw new Error('forbidden');
        if (path.includes('/jobs')) {
          return {
            items: [
              {
                metadata: {
                  name: 'done',
                  labels: { 'platform.di-framework.dev/backup-kind': 'gc' },
                },
                status: { succeeded: 1 },
              },
            ],
          };
        }
        if (path.includes('/backups')) return null;
        if (path.includes('/pods')) return { items: 'bad' };
        return { items: [] };
      },
      async post() {
        return {};
      },
      async patch() {
        return {};
      },
      async remove() {},
    };
    const loaded = await loadWorld(
      client,
      'di-tenant-alpha',
      'image:dev',
      '2026-09-28T15:00:00.000Z',
    );
    expect(loaded.destination).toBeUndefined();
    expect(loaded.networkEgress).toEqual([]);
    expect(loaded.runtimeSecretPresent).toBe(false);
    await applyActions(client, world({ destination: undefined }), [
      { type: 'destination-status', status: {} },
    ]);
  });

  test('rejects PVC destination without existingClaimName or volumeClaimTemplate.size', () => {
    const actions = reconcile(
      world({
        destination: {
          name: 'default',
          generation: 2,
          annotations: {},
          spec: {
            type: 'pvc',
          },
          status: {},
        },
      }),
    );
    expect(JSON.stringify(actions)).toContain('ConfigInvalid');
    expect(JSON.stringify(actions)).toContain('existingClaimName or volumeClaimTemplate.size');
  });

  test('accepts PVC destination with existingClaimName', () => {
    const actions = reconcile(
      world({
        services: [orders],
        destination: {
          name: 'default',
          generation: 2,
          annotations: { 'platform.di-framework.dev/backup-now': '2026-09-28T15:00:00.000Z' },
          spec: {
            type: 'pvc',
            existingClaimName: 'my-backup-pvc',
            schedule: '0 2 * * *',
          },
          status: {},
        },
      }),
    );
    expect(actions.some((action) => action.type === 'create-backup')).toBe(true);
    const job = actions.find((action) => action.type === 'create-job');
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain(
      'BACKUP_DESTINATION_TYPE',
    );
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain('pvc');
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain('my-backup-pvc');
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain(
      'BACKUP_PVC_MOUNT_PATH',
    );
  });

  test('accepts PVC destination with volumeClaimTemplate', () => {
    const actions = reconcile(
      world({
        services: [orders],
        destination: {
          name: 'default',
          generation: 2,
          annotations: { 'platform.di-framework.dev/backup-now': '2026-09-28T15:00:00.000Z' },
          spec: {
            type: 'pvc',
            volumeClaimTemplate: { size: '100Gi' },
            schedule: '0 2 * * *',
          },
          status: {},
        },
      }),
    );
    expect(actions.some((action) => action.type === 'create-backup')).toBe(true);
    const job = actions.find((action) => action.type === 'create-job');
    expect(job && job.type === 'create-job' && JSON.stringify(job.body)).toContain('di-backup-pvc');
  });
});

describe('several destinations (#233)', () => {
  const pvc = {
    name: 'pvc',
    generation: 1,
    annotations: {},
    spec: { type: 'pvc' as const, volumeClaimTemplate: { size: '10Gi' }, schedule: '0 2 * * *' },
    status: { lastAttemptTime: '2026-09-28T02:00:00.000Z' },
  };
  const now = { 'platform.di-framework.dev/backup-now': '2026-09-28T15:00:00.000Z' };

  test('a PVC Job mounts the claim and never references the S3 Secret', () => {
    const job = jobBody({
      world: world({ destination: pvc }),
      name: 'di-backup-orders-1',
      backupKind: 'dump',
      agentKind: 'postgres',
      service: orders,
      objectPrefix: 'p',
    });
    const text = JSON.stringify(job);
    expect(text).not.toContain('di-backup-destination');
    expect(text).not.toContain('envFrom');
    expect(text).toContain('"claimName":"di-backup-pvc"');
    expect(text).toContain('"platform.di-framework.dev/destination":"pvc"');
    const s3 = JSON.stringify(
      jobBody({
        world: world(),
        name: 'x',
        backupKind: 'gc',
        agentKind: 'gc',
        objectPrefix: '',
      }),
    );
    expect(s3).toContain('di-backup-destination');
    expect(s3).not.toContain('backup-pvc');
  });

  test('loadWorld reports missing claims and carries creation times', async () => {
    const destination = (name: string, spec: object, created: string) => ({
      metadata: { name, creationTimestamp: created },
      spec,
    });
    const client: KubeClient = {
      async get(path) {
        if (path.endsWith('/backupdestinations'))
          return {
            items: [
              destination('archive', { type: 's3', bucket: 'b' }, '2026-10-01T00:00:00Z'),
              destination('default', { type: 's3', bucket: 'b' }, '2026-09-01T00:00:00Z'),
              destination(
                'pvc',
                { type: 'pvc', existingClaimName: 'typo' },
                '2026-09-02T00:00:00Z',
              ),
              destination('local', { type: 'pvc' }, '2026-09-03T00:00:00Z'),
            ],
          };
        if (path.endsWith('/persistentvolumeclaims'))
          return { items: [{ metadata: { name: 'di-backup-pvc' } }] };
        return { items: [] };
      },
      async post() {
        return {};
      },
      async patch() {
        return {};
      },
      async remove() {},
    };
    const loaded = await loadWorld(client, 'di-tenant-alpha', 'image:dev', '2026-10-02T00:00:00Z');
    expect(loaded.missingClaims).toEqual(['typo']);
    expect(loaded.destinations?.find((item) => item.name === 'default')?.createdAt).toBe(
      '2026-09-01T00:00:00Z',
    );
  });

  test('the oldest S3 destination owns the credentials even when another sorts first', () => {
    const base = world().destination!;
    const archive = { ...base, name: 'archive', createdAt: '2026-10-01T00:00:00Z' };
    const original = { ...base, name: 'default', createdAt: '2026-09-01T00:00:00Z' };
    expect(pickS3Owner([archive, original])?.name).toBe('default');
    expect(pickS3Owner([{ ...archive, createdAt: undefined }, original])?.name).toBe('default');
    const tie = [
      { ...original, name: 'b' },
      { ...original, name: 'a' },
    ];
    expect(pickS3Owner(tie)?.name).toBe('a');
    const actions = reconcileAll(
      world({ destinations: [archive, original], destination: archive }),
    );
    const text = JSON.stringify(actions);
    expect(text).toContain('Only one S3 destination per tenant: default');
    expect(text).toContain('archive');
  });

  test('a missing claim fails the PVC destination early with ClaimMissing', () => {
    const claimless = {
      ...world().destination!,
      name: 'pvc',
      spec: { type: 'pvc' as const, existingClaimName: 'typo' },
    };
    const actions = reconcile(world({ destination: claimless, missingClaims: ['typo'] }));
    expect(JSON.stringify(actions)).toContain('ClaimMissing');
    expect(actions.some((action) => action.type === 'create-job')).toBe(false);
    const present = reconcile(world({ destination: claimless, missingClaims: [] }));
    expect(JSON.stringify(present)).not.toContain('ClaimMissing');
  });

  test('refuses a second S3 destination and an S3 destination without a bucket', () => {
    const second = reconcile(world({ s3Owner: 'other' }));
    expect(JSON.stringify(second)).toContain('Only one S3 destination per tenant: other');
    const bucketless = reconcile(
      world({
        destination: {
          ...world().destination!,
          spec: { ...world().destination!.spec, bucket: undefined },
        },
      }),
    );
    expect(JSON.stringify(bucketless)).toContain('S3 bucket is missing');
    const pvcReady = reconcile(world({ destination: pvc }));
    expect(JSON.stringify(pvcReady)).toContain('Claim configured');
    expect(pvcReady.some((action) => action.type === 'copy-credentials')).toBe(false);
  });

  test('reconciles S3 and PVC side by side, one Job at a time', () => {
    const s3 = { ...world().destination!, annotations: now, status: {} };
    const both = world({
      services: [orders],
      runtimeSecretPresent: false,
      destinations: [s3, { ...pvc, annotations: now, status: {} }],
      destination: undefined,
    });
    const actions = reconcileAll(both);
    const jobs = actions.filter((action) => action.type === 'create-job');
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0])).toContain('"platform.di-framework.dev/destination":"default"');
    const statuses = actions.flatMap((action) =>
      action.type === 'destination-status' ? [action.name] : [],
    );
    expect(statuses).toEqual(['default', 'pvc']);
    expect(JSON.stringify(actions.filter((a) => a.type === 'destination-status')[1])).toContain(
      'BackupInProgress',
    );
    // The S3 dump is running: the PVC destination waits for it.
    const running = reconcileAll({
      ...both,
      jobs: [
        {
          name: 'di-backup-orders-1',
          backupKind: 'dump',
          serviceName: 'orders',
          phase: 'Running',
          destinationName: 'default',
        },
      ],
    });
    expect(running.some((action) => action.type === 'create-job')).toBe(false);
    // Once it is done, the PVC destination takes its turn.
    const after = reconcileAll({
      ...both,
      destinations: [
        {
          ...world().destination!,
          status: {
            lastAttemptTime: '2026-09-28T02:00:00.000Z',
            services: [
              {
                name: 'orders',
                type: 'postgres',
                lastAttemptTime: '2026-09-28T02:00:00.000Z',
                lastReason: 'Completed',
              },
            ],
          },
        },
        { ...pvc, annotations: now, status: {} },
      ],
    });
    const pvcJob = after.find((action) => action.type === 'create-job');
    expect(JSON.stringify(pvcJob)).toContain('"claimName":"di-backup-pvc"');
    const backup = after.find((action) => action.type === 'create-backup');
    expect(JSON.stringify(backup)).toContain('"destinationName":"pvc"');
    expect(reconcileAll(world({ destination: undefined }))).toEqual([]);
  });

  test('merges extraEgress once and attributes Jobs and restores from before #233', () => {
    const rule = { cidr: '10.8.0.10/32', port: 9000, protocol: 'TCP' as const };
    const s3 = {
      ...world().destination!,
      spec: { ...world().destination!.spec, extraEgress: [rule] },
    };
    const backup = (name: string, destinationName: string) => ({
      name,
      serviceName: 'orders',
      destinationName,
      phase: 'Succeeded' as const,
      objectKey: `k/${name}/data.dump`,
      uid: orders.uid,
      type: 'postgres',
      className: orders.className,
      storage: '1Gi',
      createdAt: '2026-09-28T02:00:00.000Z',
    });
    const actions = reconcileAll(
      world({
        services: [orders],
        destination: undefined,
        destinations: [s3, { ...pvc, spec: { ...pvc.spec, extraEgress: [rule, rule] } }],
        backups: [backup('on-s3', 'default'), backup('on-pvc', 'pvc'), backup('legacy', '')],
        restores: [
          { name: 'r-pvc', sourceBackupName: 'on-pvc', targetServiceName: 'fresh' },
          { name: 'r-gone', sourceBackupName: 'missing', targetServiceName: 'fresh' },
        ],
        jobs: [
          { name: 'old-dump', backupKind: 'dump', serviceName: 'orders', phase: 'Succeeded' },
          {
            name: 'old-dump-2',
            backupKind: 'dump',
            serviceName: 'orders',
            phase: 'Succeeded',
            backupName: 'on-pvc',
          },
          {
            name: 'old-gc',
            backupKind: 'gc',
            serviceName: '',
            phase: 'Succeeded',
            gcBackups: ['on-pvc'],
          },
          {
            name: 'old-probe',
            backupKind: 'probe',
            serviceName: 'fresh',
            phase: 'Failed',
            backupName: 'r-pvc',
          },
          {
            name: 'old-restore',
            backupKind: 'restore',
            serviceName: 'fresh',
            phase: 'Failed',
            backupName: 'nobody',
          },
        ],
      }),
    );
    const egress = actions.filter((action) => action.type === 'sync-egress');
    expect(egress).toEqual([{ type: 'sync-egress', extraEgress: [rule] }]);
    expect(actions).toContainEqual({ type: 'delete-backup', name: 'on-pvc' });
    expect(JSON.stringify(actions)).toContain('"name":"r-pvc"');
    expect(JSON.stringify(actions)).toContain('BackupNotFound');
  });
});

describe('console and client with several destinations', () => {
  test('renders each destination and starts a backup on the one posted', () => {
    const pvc = {
      name: 'pvc',
      generation: 1,
      annotations: {},
      spec: { type: 'pvc' as const, existingClaimName: 'mine' },
      status: {},
    };
    const both = world({ destinations: [world().destination!, pvc] });
    const html = render(both);
    expect(html).toContain('Destination default (s3)');
    expect(html).toContain('Destination pvc (pvc)');
    expect(handle('POST', '/backups', 'destination=pvc', both).actions).toEqual([
      {
        type: 'annotate',
        name: 'pvc',
        key: 'platform.di-framework.dev/backup-now',
        value: both.now,
      },
    ]);
    expect(handle('POST', '/backups', 'destination=nope', both).status).toBe(400);
    expect(render(world({ destination: undefined }))).toContain('Destination none.');
  });

  test('loads every destination, defaults a missing type to S3, and patches status by name', async () => {
    const patched: string[] = [];
    const client: KubeClient = {
      async get(path) {
        if (path.endsWith('/backupdestinations')) {
          return {
            items: [
              { metadata: { name: 'legacy' }, spec: { bucket: 'b' } },
              { metadata: {} },
              {
                metadata: { name: 'pvc', generation: 4 },
                spec: { type: 'pvc', existingClaimName: 'c' },
              },
            ],
          };
        }
        if (path.endsWith('/backups')) {
          return {
            items: [{ metadata: { name: 'b1' }, spec: { destinationName: 'pvc' } }],
          };
        }
        if (path.endsWith('/jobs')) {
          return {
            items: [
              {
                metadata: {
                  name: 'j',
                  labels: {
                    'platform.di-framework.dev/backup-kind': 'dump',
                    'platform.di-framework.dev/destination': 'pvc',
                  },
                },
              },
            ],
          };
        }
        if (path.endsWith('/secrets/di-backup-destination')) throw new Error('missing');
        return { items: [] };
      },
      async post() {
        return {};
      },
      async patch(path) {
        patched.push(path);
        return {};
      },
      async remove() {},
    };
    const loaded = await loadWorld(client, 'di-tenant-alpha', 'image:dev', 'now');
    expect(loaded.destinations?.map((item) => [item.name, item.spec.type])).toEqual([
      ['legacy', 's3'],
      ['pvc', 'pvc'],
    ]);
    expect(loaded.destination?.name).toBe('legacy');
    expect(loaded.backups[0]?.destinationName).toBe('pvc');
    expect(loaded.jobs[0]?.destinationName).toBe('pvc');
    await applyActions(client, loaded, [
      { type: 'destination-status', name: 'pvc', status: {} },
      { type: 'destination-status', status: {} },
    ]);
    expect(patched).toEqual([
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backupdestinations/pvc/status',
      '/apis/platform.di-framework.dev/v1alpha1/namespaces/di-tenant-alpha/backupdestinations/legacy/status',
    ]);
  });
});
