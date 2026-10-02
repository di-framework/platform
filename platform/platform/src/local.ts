/**
 * Isolated local wasmCloud platform. Application WorkloadDeployments and
 * Services are deliberately owned by the DI Framework CLI, not this program.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as command from '@pulumi/command';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import {
  type ContainerScope,
  containerCli,
  deleteOwnedContainer,
  deleteOwnedNetwork,
  deleteOwnedVolume,
  readKubeconfig,
  refuseExistingContainerThenRun,
  refuseExistingNetworkThenCreate,
  refuseExistingVolumeThenCreate,
  shutdownRuntime,
} from './container-cli';
import { createPlatform } from './index';
import { localPathStorageResources } from './local-storage';
import { registryMirrorFiles, registryMirrors } from './registry-mirrors';

const K0S_IMAGE = 'docker.io/k0sproject/k0s:v1.36.3-k0s.2';
const REGISTRY_NODE_PORT = 30500;
const HTTP_NODE_PORT = 30180;
const namespaceName = 'wasmcloud';
const ownershipLabel = 'di-framework.dev.platform-scope';

const config = new pulumi.Config();
const cli = containerCli(config.get('containerCli'));
const apiPort = hostPort(config, 'apiPort', 26443);
const registryPort = hostPort(config, 'registryPort', 25000);
const httpPort = hostPort(config, 'httpPort', 28180);
const mirrorFiles = registryMirrorFiles(registryMirrors(config.getObject('registryMirrors')));
if (new Set([apiPort, registryPort, httpPort]).size !== 3) {
  throw new Error('apiPort, registryPort, and httpPort must be distinct');
}

const stack = sanitize(pulumi.getStack());
const projectHash = createHash('sha256').update(pulumi.getProject()).digest('hex').slice(0, 10);
const scope = `di-framework-${stack}-${projectHash}`;
const networkName = `${scope}-network`;
const k0sName = `${scope}-k0s`;
const k0sDataName = `${scope}-k0s-data`;
const k0sPodLogsName = `${scope}-k0s-pod-logs`;
const kubeconfigFile = path.resolve(`.kubeconfig-${stack}`);
const owned: ContainerScope = { cli, ownershipLabel, scope };

const runtimeNetwork = new command.local.Command('runtime-network', {
  create: refuseExistingNetworkThenCreate(owned, networkName),
  delete: deleteOwnedNetwork(owned, networkName),
});

const k0sData = new command.local.Command('k0s-data', {
  create: refuseExistingVolumeThenCreate(owned, k0sDataName),
  delete: deleteOwnedVolume(owned, k0sDataName),
});

const k0sPodLogs = new command.local.Command('k0s-pod-logs', {
  create: refuseExistingVolumeThenCreate(owned, k0sPodLogsName),
  delete: deleteOwnedVolume(owned, k0sPodLogsName),
});

const k0s = new command.local.Command(
  'k0s',
  {
    create: refuseExistingContainerThenRun(owned, {
      name: k0sName,
      image: K0S_IMAGE,
      network: networkName,
      dataVolume: k0sDataName,
      podLogsVolume: k0sPodLogsName,
      publish: [
        { host: apiPort, container: 6443 },
        { host: registryPort, container: REGISTRY_NODE_PORT },
        { host: httpPort, container: HTTP_NODE_PORT },
      ],
      startupFiles: mirrorFiles,
    }),
    delete: deleteOwnedContainer(owned, k0sName),
    ...(mirrorFiles.length > 0 && {
      environment: Object.fromEntries(mirrorFiles.map((file) => [file.variable, file.content])),
    }),
  },
  {
    dependsOn: [runtimeNetwork, k0sData, k0sPodLogs],
    deleteBeforeReplace: true,
  },
);

const kubeconfigCommand = new command.local.Command(
  'kubeconfig',
  {
    create: readKubeconfig(cli, k0sName, apiPort),
    logging: command.types.enums.local.Logging.None,
  },
  { dependsOn: [k0s], additionalSecretOutputs: ['stdout'] },
);

const kubeconfigContents = pulumi.secret(kubeconfigCommand.stdout);
const kubeconfigFileCommand = new command.local.Command(
  'kubeconfig-file',
  {
    create: 'umask 077; printf "%s\\n" "$KUBECONFIG_CONTENT" > "$KUBECONFIG_FILE"',
    update: 'umask 077; printf "%s\\n" "$KUBECONFIG_CONTENT" > "$KUBECONFIG_FILE"',
    delete: 'if [ -n "$KUBECONFIG_FILE" ]; then rm -f -- "$KUBECONFIG_FILE"; fi',
    environment: {
      KUBECONFIG_CONTENT: kubeconfigContents,
      KUBECONFIG_FILE: kubeconfigFile,
    },
    logging: command.types.enums.local.Logging.None,
  },
  { dependsOn: [kubeconfigCommand] },
);

const provider = new k8s.Provider(
  'k0s',
  { kubeconfig: kubeconfigContents, enableServerSideApply: true },
  { dependsOn: [kubeconfigCommand] },
);

new k8s.yaml.ConfigGroup('local-path-storage', { objs: localPathStorageResources }, { provider });

const platform = createPlatform({
  provider,
  installation: scope,
  config,
  registry: true,
  insecureRegistry: true,
  apiServer: `https://127.0.0.1:${apiPort}`,
  beforeTenancy: (wasmcloud) => {
    const runtimeShutdown = new command.local.Command(
      'runtime-shutdown',
      {
        create: 'true',
        delete: shutdownRuntime(cli),
        environment: { K0S_NAME: k0sName, NAMESPACE: namespaceName },
      },
      { dependsOn: [wasmcloud, kubeconfigFileCommand] },
    );

    return runtimeShutdown;
  },
});
export const tenants = platform.tenants;
export const users = platform.users;
/** `{ [tenant]: { [user]: kubeconfig } }` (secret): one ServiceAccount-token kubeconfig per membership. */
export const kubeconfigs = platform.kubeconfigs;

export const schemaVersion = 2;
export const kubeconfig = kubeconfigFileCommand.id.apply(() => kubeconfigFile);
export const namespace = platform.namespace;
export const registry = {
  push: `http://127.0.0.1:${registryPort}`,
  pull: `di-framework-registry.${namespaceName}.svc.cluster.local:5000`,
  insecure: true,
};
export const endpoints = {
  http: `http://127.0.0.1:${httpPort}`,
  kubernetes: `https://127.0.0.1:${apiPort}`,
  registry: `http://127.0.0.1:${registryPort}`,
};

function hostPort(configuration: pulumi.Config, name: string, fallback: number): number {
  const value = configuration.getNumber(name) ?? fallback;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer from 1024 through 65535; received ${value}`);
  }
  return value;
}

function sanitize(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'stack';
}
