import { describe, expect, test } from 'bun:test';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { backupReleaseArgs, installBackupDestination } from '../src/install.ts';

describe('backup helm release', () => {
  test('targets the wasmCloud tenant namespace and does not create it', () => {
    const release = backupReleaseArgs({
      tenant: 'alpha',
      chart: '/charts/backup-destination',
      bucket: 'tenant-alpha-backups',
    });
    expect(release).toEqual({
      name: 'backups',
      namespace: 'di-tenant-alpha',
      createNamespace: false,
      chart: '/charts/backup-destination',
      values: { bucket: 'tenant-alpha-backups' },
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

  test('rejects a namespace that is not a tenant name', () => {
    expect(() => backupReleaseArgs({ tenant: 'Wasm', chart: '/chart', bucket: 'b' })).toThrow(
      /wasmCloud tenant name/,
    );
    expect(() =>
      backupReleaseArgs({ tenant: 'a'.repeat(41), chart: '/chart', bucket: 'b' }),
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
          install: { tenant: 'alpha', chart: '/chart', bucket: 'tenant-alpha-backups' },
        }) instanceof k8s.helm.v3.Release;
    });
    expect(constructed).toBe(true);
    expect(resources.some((resource) => resource.type === 'kubernetes:core/v1:Namespace')).toBe(
      false,
    );
  });
});
