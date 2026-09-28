/**
 * Repeatable backup install for one wasmCloud tenant.
 *
 * The cluster comes from di-framework-kube. createPlatform declares the tenant;
 * the controller creates di-tenant-<name> and di-runtime-<name>. This program
 * installs RustFS and the backup chart with kubernetes.helm.v3.Release and does
 * not create those namespaces.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { createPlatform } from '../../platform/dist/index.js';
import { installBackupDestination } from '../src/install';

const config = new pulumi.Config();
const kubeconfig = config.require('kubeconfig');
const provider = new k8s.Provider('cluster', {
  kubeconfig: pulumi.secret(readFileSync(kubeconfig, 'utf8')),
  context: config.get('context'),
  enableServerSideApply: true,
  // di-framework-kube already created the wasmcloud namespace and Helm release.
  upsertExistingObjects: true,
});
const installation = `di-framework-${createHash('sha256').update(`${pulumi.getProject()}/${pulumi.getStack()}`).digest('hex').slice(0, 20)}`;
const networkPolicyEngine = config.get('networkPolicyEngine') ?? 'kube-router';
if (networkPolicyEngine !== 'existing' && networkPolicyEngine !== 'kube-router') {
  throw new Error('networkPolicyEngine must be existing or kube-router');
}

const tenants = config.requireObject<{ name: string }[]>('tenants');
const platform = createPlatform({
  networkPolicyEngine,
  provider,
  installation,
  config,
  namespace: config.get('namespace'),
  release: config.get('release'),
  chart: config.get('chart'),
  chartVersion: config.get('chartVersion'),
  timeoutSeconds: config.getNumber('timeoutSeconds') ?? 1200,
  httpNodePort: config.getNumber('httpNodePort') ?? 0,
  insecureRegistry: config.getBoolean('insecureRegistry') ?? false,
  storageRoot: config.get('storageRoot') ?? '/var/lib/kubesolo',
  values: config.getObject<Record<string, unknown>>('values'),
});

const accessKeyId = config.get('accessKeyId') ?? 'backupdemo';
const secretAccessKey = config.getSecret('secretAccessKey') ?? pulumi.secret('backupdemo-secret');
const bucket = config.get('bucket') ?? 'tenant-alpha-backups';
const endpoint = config.get('endpoint') ?? 'http://rustfs-svc.wasmcloud.svc.cluster.local:9000';
const chart = config.get('chartPath') ?? resolve(__dirname, '../chart');

const rustfs = new k8s.helm.v3.Release(
  'rustfs',
  {
    name: 'rustfs',
    namespace: config.get('namespace') ?? 'wasmcloud',
    createNamespace: false,
    chart: 'rustfs',
    version: '1.0.0-beta.11-preview.1',
    repositoryOpts: { repo: 'https://charts.rustfs.com' },
    timeout: 1200,
    values: {
      fullnameOverride: 'rustfs',
      replicaCount: 1,
      mode: {
        standalone: { enabled: true },
        distributed: { enabled: false },
      },
      ingress: { enabled: false },
      affinity: { podAntiAffinity: { enabled: false } },
      storageclass: {
        name: config.get('storageClass') ?? 'local-path',
        dataStorageSize: '1Gi',
        logStorageSize: '256Mi',
      },
      secret: {
        rustfs: { access_key: accessKeyId, secret_key: secretAccessKey },
      },
      config: { rustfs: { region: 'us-east-1' } },
    },
  },
  { provider, dependsOn: [platform.release] },
);

const backups = tenants.map((tenant, index) => {
  const tenantResource = platform.tenantResources[index];
  if (!tenantResource) throw new Error(`platform did not declare tenant ${tenant.name}`);
  const service = new k8s.apiextensions.CustomResource(
    `orders-${tenant.name}`,
    {
      apiVersion: 'platform.di-framework.dev/v1alpha1',
      kind: 'BackingService',
      metadata: {
        name: 'orders',
        namespace: `di-tenant-${tenant.name}`,
        annotations: { 'pulumi.com/waitFor': 'condition=Ready' },
      },
      spec: { type: 'postgres', className: 'postgres-dedicated' },
    },
    { provider, dependsOn: [tenantResource] },
  );
  return installBackupDestination({
    provider,
    dependsOn: [tenantResource, service, rustfs],
    install: {
      tenant: tenant.name,
      chart,
      bucket,
      endpoint,
      region: 'us-east-1',
      accessKeyId,
      secretAccessKey,
      // kube-router evaluates egress after kube-proxy DNAT, so the Service CIDR
      // does not match the RustFS pod. Kubesolo's pod CIDR is 10.42.0.0/16.
      extraEgress: [
        { cidr: '10.43.0.0/16', port: 9000, protocol: 'TCP' },
        { cidr: '10.42.0.0/16', port: 9000, protocol: 'TCP' },
      ],
      agentImage: 'di-framework/backup-agent:dev',
      imageRepository: 'di-framework/backup-destination',
      imageTag: 'dev',
      imagePullPolicy: 'Never',
    },
  });
});

export const schemaVersion = 2;
export const namespace = platform.namespace;
export const tenantNames = platform.tenants;
export const backupReleases = backups.map((release) => release.status);
