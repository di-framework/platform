import { describe, expect, test } from 'bun:test';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {
  type BackupDestinationInstall,
  backupReleaseArgs,
  installBackupDestination,
} from '../src/install.ts';

describe('backup helm release', () => {
  test('targets the wasmCloud tenant namespace and does not create it', () => {
    const release = backupReleaseArgs({
      tenant: 'alpha',
      chart: '/charts/backup-destination',
      bucket: 'tenant-alpha-backups',
      schedule: '0 2 * * *',
    });
    expect(release).toEqual({
      name: 'backups',
      namespace: 'di-tenant-alpha',
      createNamespace: false,
      chart: '/charts/backup-destination',
      values: { bucket: 'tenant-alpha-backups', schedule: '0 2 * * *' },
    });
  });

  test('passes destination, image, and egress values through', () => {
    const release = backupReleaseArgs({
      tenant: 'warehouse',
      chart: '/chart',
      bucket: 'warehouse',
      endpoint: 'http://rustfs.wasmcloud.svc.cluster.local:9000',
      region: 'us-east-1',
      prefix: 'di-framework/warehouse',
      schedule: '0 2 * * *',
      retentionSuccessful: 14,
      existingSecret: 'di-backup-s3',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      extraEgress: [{ cidr: '10.43.0.0/16', port: 9000, protocol: 'TCP' }],
      agentImage: 'di-framework/backup-agent:dev',
      imageRepository: 'di-framework/backup-destination',
      imageTag: 'dev',
      imagePullPolicy: 'Never',
    });
    expect(release.namespace).toBe('di-tenant-warehouse');
    expect(release.createNamespace).toBe(false);
    expect(release.values).toMatchObject({
      endpoint: 'http://rustfs.wasmcloud.svc.cluster.local:9000',
      existingSecret: 'di-backup-s3',
      agentImage: 'di-framework/backup-agent:dev',
      image: {
        repository: 'di-framework/backup-destination',
        tag: 'dev',
        pullPolicy: 'Never',
      },
    });
  });

  test('passes a PVC destination through without a bucket', () => {
    const release = backupReleaseArgs({
      tenant: 'alpha',
      chart: '/chart',
      type: 'both',
      bucket: 'b',
      existingClaimName: 'claim',
      volumeClaimTemplate: { storageClassName: 'local-path', size: '20Gi' },
      schedule: 'none',
    });
    expect(release.values).toEqual({
      schedule: 'none',
      type: 'both',
      bucket: 'b',
      existingClaimName: 'claim',
      volumeClaimTemplate: { storageClassName: 'local-path', size: '20Gi' },
    });
    expect(
      backupReleaseArgs({ tenant: 'alpha', chart: '/chart', type: 'pvc', schedule: '0 3 * * 0' })
        .values,
    ).toEqual({ type: 'pvc', schedule: '0 3 * * 0' });
  });

  test('requires an explicit schedule: a cron or none, never a default (#250)', () => {
    // @ts-expect-error schedule is a required option since #250
    const missing: BackupDestinationInstall = { tenant: 'alpha', chart: '/chart', bucket: 'b' };
    expect(missing.schedule).toBeUndefined();
    const typed: BackupDestinationInstall = { tenant: 'alpha', chart: '/chart', schedule: 'none' };
    expect(backupReleaseArgs(typed).values).toEqual({ schedule: 'none' });
    expect(backupReleaseArgs({ ...typed, schedule: ' */15 1-5 * * 1,3 ' }).values).toEqual({
      schedule: ' */15 1-5 * * 1,3 ',
    });
    for (const schedule of ['', '  ', 'nightly', '0 2 * *', '0 2 * * * *', 'manual']) {
      expect(() => backupReleaseArgs({ ...typed, schedule })).toThrow(
        'schedule must be a five-field UTC cron (such as "0 2 * * *") or "none"',
      );
    }
    // An Output is passed through; the chart validates it when it renders.
    const output = pulumi.output('0 2 * * *');
    expect(backupReleaseArgs({ ...typed, schedule: output }).values).toEqual({ schedule: output });
  });

  test('passes workload-volume sources and the storage root through', () => {
    const sources = [
      { workloadName: 'identity', schedule: '30 3 * * *', retention: { keepLast: 7 } },
    ];
    expect(
      backupReleaseArgs({
        tenant: 'alpha',
        chart: '/chart',
        type: 'pvc',
        existingClaimName: 'c',
        storageRoot: '/var/lib/k0s',
        sources,
      }).values,
    ).toEqual({ type: 'pvc', existingClaimName: 'c', storageRoot: '/var/lib/k0s', sources });
  });

  test('rejects a namespace that is not a tenant name', () => {
    expect(() =>
      backupReleaseArgs({ tenant: 'Wasm', chart: '/chart', bucket: 'b', schedule: 'none' }),
    ).toThrow(/wasmCloud tenant name/);
    expect(() =>
      backupReleaseArgs({ tenant: 'a'.repeat(41), chart: '/chart', bucket: 'b', schedule: 'none' }),
    ).toThrow(/wasmCloud tenant name/);
  });

  test('registers a helm release that depends on the tenant', async () => {
    const resources: { type: string; name: string; inputs: Record<string, unknown> }[] = [];
    pulumi.runtime.setMocks(
      {
        newResource: (args) => {
          resources.push({
            type: args.type,
            name: args.name,
            inputs: args.inputs as Record<string, unknown>,
          });
          return { id: args.name, state: args.inputs };
        },
        call: (args) => args.inputs,
      },
      'project',
      'test',
      false,
    );
    let constructed = false;
    await pulumi.runtime.runInPulumiStack(async () => {
      const provider = new k8s.Provider('test', {});
      constructed =
        installBackupDestination({
          provider,
          dependsOn: [],
          install: {
            tenant: 'alpha',
            chart: '/chart',
            bucket: 'tenant-alpha-backups',
            schedule: '0 2 * * *',
          },
        }) instanceof k8s.helm.v3.Release;
    });
    expect(constructed).toBe(true);
    expect(resources.some((resource) => resource.type === 'kubernetes:core/v1:Namespace')).toBe(
      false,
    );
  });
});
