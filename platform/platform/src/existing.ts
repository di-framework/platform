/** Pulumi entrypoint for a cluster whose lifecycle is owned by the caller. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { createPlatform } from './index';

const config = new pulumi.Config();
export const kubeconfig = config.require('kubeconfig');
const provider = new k8s.Provider('cluster', {
  kubeconfig: pulumi.secret(readFileSync(kubeconfig, 'utf8')),
  context: config.get('context'),
  enableServerSideApply: true,
});
const installation = `di-framework-${createHash('sha256').update(`${pulumi.getProject()}/${pulumi.getStack()}`).digest('hex').slice(0, 20)}`;
const networkPolicyEngine = config.get('networkPolicyEngine') ?? 'existing';
if (networkPolicyEngine !== 'existing' && networkPolicyEngine !== 'kube-router')
  throw new Error('networkPolicyEngine must be existing or kube-router');
const platform = createPlatform({
  networkPolicyEngine,
  provider,
  installation,
  config,
  namespace: config.get('namespace'),
  release: config.get('release'),
  chart: config.get('chart'),
  chartVersion: config.get('chartVersion'),
  timeoutSeconds: config.getNumber('timeoutSeconds'),
  httpNodePort: config.getNumber('httpNodePort') ?? 0,
  insecureRegistry: config.getBoolean('insecureRegistry') ?? false,
  storageRoot: config.get('storageRoot') ?? '/var/lib/kubesolo',
  values: config.getObject<Record<string, unknown>>('values'),
});
export const schemaVersion = 2;
export const namespace = platform.namespace;
export const tenants = platform.tenants;
export const users = platform.users;
export const endpoints = {
  http: config.get('httpEndpoint'),
  kubernetes: config.get('kubernetesEndpoint'),
};
