import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';

const TENANT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface BackupDestinationInstall {
  tenant: string;
  chart: string;
  bucket: pulumi.Input<string>;
  endpoint?: pulumi.Input<string>;
  region?: pulumi.Input<string>;
  prefix?: pulumi.Input<string>;
  schedule?: pulumi.Input<string>;
  retentionSuccessful?: pulumi.Input<number>;
  existingSecret?: pulumi.Input<string>;
  accessKeyId?: pulumi.Input<string>;
  secretAccessKey?: pulumi.Input<string>;
  extraEgress?: pulumi.Input<pulumi.Input<{ cidr: string; port: number; protocol?: string }>[]>;
  agentImage?: pulumi.Input<string>;
  imageRepository?: pulumi.Input<string>;
  imageTag?: pulumi.Input<string>;
  imagePullPolicy?: pulumi.Input<string>;
}

/** Helm release arguments for one tenant. The namespace is the one wasmCloud created. */
export function backupReleaseArgs(install: BackupDestinationInstall): k8s.helm.v3.ReleaseArgs {
  if (!TENANT.test(install.tenant) || install.tenant.length > 40) {
    throw new Error(
      'tenant must be a wasmCloud tenant name (1–40 lowercase letters, digits, hyphens; starting with a letter)',
    );
  }
  const values: Record<string, pulumi.Input<unknown>> = { bucket: install.bucket };
  if (install.endpoint !== undefined) values.endpoint = install.endpoint;
  if (install.region !== undefined) values.region = install.region;
  if (install.prefix !== undefined) values.prefix = install.prefix;
  if (install.schedule !== undefined) values.schedule = install.schedule;
  if (install.retentionSuccessful !== undefined)
    values.retentionSuccessful = install.retentionSuccessful;
  if (install.existingSecret !== undefined) values.existingSecret = install.existingSecret;
  if (install.accessKeyId !== undefined) values.accessKeyId = install.accessKeyId;
  if (install.secretAccessKey !== undefined) values.secretAccessKey = install.secretAccessKey;
  if (install.extraEgress !== undefined) values.extraEgress = install.extraEgress;
  if (install.agentImage !== undefined) values.agentImage = install.agentImage;
  const image: Record<string, pulumi.Input<string>> = {};
  if (install.imageRepository !== undefined) image.repository = install.imageRepository;
  if (install.imageTag !== undefined) image.tag = install.imageTag;
  if (install.imagePullPolicy !== undefined) image.pullPolicy = install.imagePullPolicy;
  if (Object.keys(image).length > 0) values.image = image;
  return {
    name: 'backups',
    namespace: `di-tenant-${install.tenant}`,
    createNamespace: false,
    chart: install.chart,
    values,
  };
}

/** Install the backup chart with the Helm release provider. Does not create tenant namespaces. */
export function installBackupDestination(args: {
  provider: k8s.Provider;
  dependsOn?: pulumi.Resource[];
  install: BackupDestinationInstall;
}): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `backups-${args.install.tenant}`,
    backupReleaseArgs(args.install),
    {
      provider: args.provider,
      dependsOn: args.dependsOn,
    },
  );
}
