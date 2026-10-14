import * as k8s from '@pulumi/kubernetes';
import type * as pulumi from '@pulumi/pulumi';
// Extensionless: the prototype Pulumi program compiles this file with ts-node, which emits JS
// and so cannot enable allowImportingTsExtensions ('.ts' specifiers fail with TS5097).
import { validCron } from './schedule';

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
   * on-demand backups only. The chart refuses to render without it. It is written trimmed, and
   * may have at most 128 characters, as the CRD allows (#254).
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
   * Workload volumes to copy cold (#232). `schedule` is required with no default (#250): a
   * five-field UTC cron, or `'none'` for on-demand backups only. No retention means every backup
   * is kept. `destination` picks `s3` or `pvc` when `type` is `both`.
   */
  sources?: pulumi.Input<
    {
      workloadName: string;
      schedule: string;
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

/** The CRD's `maxLength` on `schedule`, for the destination and every source (#254 S2). */
export const SCHEDULE_MAX_LENGTH = 128;
/**
 * The chart's cron pattern (#263 S5): five fields one space apart; numbers of at most two digits
 * within each field's range, `*`, ranges, steps from 1 with no leading zero, and lists. Keep it
 * in step with `chart/templates/destination.yaml`.
 */
const FIELDS = [
  '[0-5]?[0-9]',
  '([01]?[0-9]|2[0-3])',
  '(0?[1-9]|[12][0-9]|3[01])',
  '(0?[1-9]|1[0-2])',
  '[0-7]',
];
const CHART_CRON = new RegExp(
  `^${FIELDS.map((value) => {
    const element = String.raw`(\*|(${value})(-(${value}))?)(/[1-9][0-9]*)?`;
    return `${element}(,${element})*`;
  }).join(' ')}$`,
);

/**
 * Whether a trimmed schedule has a shape the CRD accepts: "none", or a cron the operator can
 * fire that the chart also renders. The operator's parser rejects backward ranges such as `5-1`,
 * as the chart does; the chart's pattern rejects three-digit numbers (`005`) and zero-led steps
 * (`/01`), as this does.
 */
function acceptedSchedule(schedule: string): boolean {
  return schedule === 'none' || (CHART_CRON.test(schedule) && validCron(schedule));
}

const TOO_LONG = `schedule must be at most ${SCHEDULE_MAX_LENGTH} characters`;

/**
 * A plain source must name a cron or "none". The trimmed value is the one passed on (#254 S1),
 * as the chart writes it: the CRD pattern refuses surrounding spaces. A source or schedule that
 * is an Output (an object) is passed through and checked by the chart when it renders.
 */
function checkedSource(source: unknown): unknown {
  if (!source || typeof source !== 'object') return source;
  const { workloadName, schedule } = source as { workloadName?: unknown; schedule?: unknown };
  if (typeof schedule === 'object' && schedule !== null) return source;
  const name = typeof workloadName === 'string' ? workloadName : '?';
  const trimmed = typeof schedule === 'string' ? schedule.trim() : '';
  if (trimmed === '') {
    throw new Error(
      `source ${name}: schedule is required: a five-field UTC cron (such as "30 3 * * *") or "none"`,
    );
  }
  if (trimmed.length > SCHEDULE_MAX_LENGTH) throw new Error(`source ${name}: ${TOO_LONG}`);
  if (!acceptedSchedule(trimmed)) {
    throw new Error(
      `source ${name}: schedule must be a five-field UTC cron (such as "30 3 * * *") or "none"`,
    );
  }
  return { ...source, schedule: trimmed };
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
  const schedule =
    typeof install.schedule === 'string' ? install.schedule.trim() : install.schedule;
  if (typeof schedule === 'string') {
    if (schedule.length > SCHEDULE_MAX_LENGTH) throw new Error(TOO_LONG);
    if (!acceptedSchedule(schedule)) {
      throw new Error('schedule must be a five-field UTC cron (such as "0 2 * * *") or "none"');
    }
  }
  const sources = Array.isArray(install.sources)
    ? (install.sources as unknown[]).map(checkedSource)
    : install.sources;
  const values: Record<string, pulumi.Input<unknown>> = {};
  if (install.type !== undefined) values.type = install.type;
  if (install.bucket !== undefined) values.bucket = install.bucket;
  if (install.existingClaimName !== undefined) values.existingClaimName = install.existingClaimName;
  if (install.volumeClaimTemplate !== undefined)
    values.volumeClaimTemplate = install.volumeClaimTemplate;
  if (install.endpoint !== undefined) values.endpoint = install.endpoint;
  if (install.region !== undefined) values.region = install.region;
  if (install.prefix !== undefined) values.prefix = install.prefix;
  values.schedule = schedule;
  if (install.retentionSuccessful !== undefined)
    values.retentionSuccessful = install.retentionSuccessful;
  if (install.existingSecret !== undefined) values.existingSecret = install.existingSecret;
  if (install.accessKeyId !== undefined) values.accessKeyId = install.accessKeyId;
  if (install.secretAccessKey !== undefined) values.secretAccessKey = install.secretAccessKey;
  if (install.extraEgress !== undefined) values.extraEgress = install.extraEgress;
  if (install.storageRoot !== undefined) values.storageRoot = install.storageRoot;
  if (sources !== undefined) values.sources = sources;
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
