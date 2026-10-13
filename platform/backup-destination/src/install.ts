import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
import { validCron } from './schedule.ts';

const TENANT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface BackupDestinationInstall {
  tenant: string;
  chart: string;
  /** `s3` (the default), `pvc`, or `both`. */
  type?: 's3' | 'pvc' | 'both';
  /** Required for `s3` and `both`. */
  bucket?: pulumi.Input<string>;
  /** PVC destination: a claim that already exists in `di-runtime-<tenant>`. */
  existingClaimName?: pulumi.Input<string>;
  /** PVC destination: the chart creates claim `di-backup-pvc` with this size and class. */
  volumeClaimTemplate?: pulumi.Input<{ storageClassName?: string; size: string }>;
  endpoint?: pulumi.Input<string>;
  region?: pulumi.Input<string>;
  prefix?: pulumi.Input<string>;
  /**
   * Required, no default (#250): a five-field UTC cron such as `0 2 * * *`, or `'none'` for
   * on-demand backups only. The chart refuses to render without it.
   */
  schedule: pulumi.Input<string>;
  retentionSuccessful?: pulumi.Input<number>;
  existingSecret?: pulumi.Input<string>;
  accessKeyId?: pulumi.Input<string>;
  secretAccessKey?: pulumi.Input<string>;
  extraEgress?: pulumi.Input<pulumi.Input<{ cidr: string; port: number; protocol?: string }>[]>;
  /**
   * The platform's storageRoot. Leave it unset and the operator takes it from the path the
   * tenant host pods mount, so it cannot disagree with the platform. When set, that path must
   * match it; pass the same value the platform installation uses.
   */
  storageRoot?: pulumi.Input<string>;
  /**
   * Workload volumes to copy cold (#232). No schedule means on-demand only; no retention means
   * every backup is kept. `destination` picks `s3` or `pvc` when `type` is `both`.
   */
  sources?: pulumi.Input<
    {
      workloadName: string;
      schedule?: string;
      retention?: {
        keepLast?: number;
        daily?: number;
        weekly?: number;
        monthly?: number;
        failed?: number;
      };
      scaleDownTimeoutSeconds?: number;
      copyTimeoutSeconds?: number;
      /** Placement probe and copy Job start deadline (default 120). */
      startTimeoutSeconds?: number;
      /** Copy Job resources; the default is requests 50m/64Mi, limits 100m/128Mi. */
      resources?: {
        requests?: { cpu?: string; memory?: string };
        limits?: { cpu?: string; memory?: string };
      };
      suspend?: boolean;
      destination?: 's3' | 'pvc';
    }[]
  >;
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
  // A missing schedule throws here too (a JS caller can omit it); an Output is checked by the
  // chart when it renders.
  if (install.schedule === undefined || install.schedule === null) {
    throw new Error('schedule is required: a five-field UTC cron (such as "0 2 * * *") or "none"');
  }
  if (
    typeof install.schedule === 'string' &&
    install.schedule.trim() !== 'none' &&
    !validCron(install.schedule)
  ) {
    throw new Error('schedule must be a five-field UTC cron (such as "0 2 * * *") or "none"');
  }
  const values: Record<string, pulumi.Input<unknown>> = {};
  if (install.type !== undefined) values.type = install.type;
  if (install.bucket !== undefined) values.bucket = install.bucket;
  if (install.existingClaimName !== undefined) values.existingClaimName = install.existingClaimName;
  if (install.volumeClaimTemplate !== undefined)
    values.volumeClaimTemplate = install.volumeClaimTemplate;
  if (install.endpoint !== undefined) values.endpoint = install.endpoint;
  if (install.region !== undefined) values.region = install.region;
  if (install.prefix !== undefined) values.prefix = install.prefix;
  values.schedule = install.schedule;
  if (install.retentionSuccessful !== undefined)
    values.retentionSuccessful = install.retentionSuccessful;
  if (install.existingSecret !== undefined) values.existingSecret = install.existingSecret;
  if (install.accessKeyId !== undefined) values.accessKeyId = install.accessKeyId;
  if (install.secretAccessKey !== undefined) values.secretAccessKey = install.secretAccessKey;
  if (install.extraEgress !== undefined) values.extraEgress = install.extraEgress;
  if (install.storageRoot !== undefined) values.storageRoot = install.storageRoot;
  if (install.sources !== undefined) values.sources = install.sources;
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
