/**
 * Isolated local wasmCloud platform. Application WorkloadDeployments and
 * Services are deliberately owned by the DI Framework CLI, not this program.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as command from '@pulumi/command';
import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';
import { createPlatform } from './index';
import { localPathStorageResources } from './local-storage';

const K0S_IMAGE = 'docker.io/k0sproject/k0s:v1.36.3-k0s.2';
const REGISTRY_NODE_PORT = 30500;
const HTTP_NODE_PORT = 30180;
const namespaceName = 'wasmcloud';
const ownershipLabel = 'di-framework.dev.platform-scope';

const config = new pulumi.Config();
const apiPort = hostPort(config, 'apiPort', 26443);
const registryPort = hostPort(config, 'registryPort', 25000);
const httpPort = hostPort(config, 'httpPort', 28180);
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

const runtimeNetwork = new command.local.Command('runtime-network', {
  create: refuseExistingNetworkThenCreate(networkName),
  delete: deleteOwnedNetwork(networkName),
});

const k0sData = new command.local.Command('k0s-data', {
  create: refuseExistingVolumeThenCreate(k0sDataName),
  delete: deleteOwnedVolume(k0sDataName),
});

const k0sPodLogs = new command.local.Command('k0s-pod-logs', {
  create: refuseExistingVolumeThenCreate(k0sPodLogsName),
  delete: deleteOwnedVolume(k0sPodLogsName),
});

const k0s = new command.local.Command(
  'k0s',
  {
    create: [
      'set -eu;',
      `if docker container inspect ${k0sName} >/dev/null 2>&1; then`,
      `echo "Refusing to replace existing container ${k0sName}" >&2; exit 1; fi;`,
      'docker run -d',
      `--name ${k0sName}`,
      `--hostname ${k0sName}`,
      `--label ${ownershipLabel}=${scope}`,
      `--network ${networkName}`,
      '--privileged',
      '--tmpfs /run:rw,nosuid,nodev,exec,mode=755',
      `--mount type=volume,source=${k0sDataName},target=/var/lib/k0s`,
      `--mount type=volume,source=${k0sPodLogsName},target=/var/log/pods`,
      `--publish 127.0.0.1:${apiPort}:6443`,
      `--publish 127.0.0.1:${registryPort}:${REGISTRY_NODE_PORT}`,
      `--publish 127.0.0.1:${httpPort}:${HTTP_NODE_PORT}`,
      K0S_IMAGE,
      'k0s controller --enable-worker --no-taints',
    ].join(' '),
    delete: deleteOwnedContainer(k0sName),
  },
  {
    dependsOn: [runtimeNetwork, k0sData, k0sPodLogs],
    deleteBeforeReplace: true,
  },
);

const kubeconfigCommand = new command.local.Command(
  'kubeconfig',
  {
    create: [
      'set -eu;',
      'attempt=0;',
      `until docker exec ${k0sName} k0s kubectl get --raw=/readyz >/dev/null 2>&1 &&`,
      `docker exec ${k0sName} k0s kubectl wait node --all --for=condition=Ready --timeout=5s >/dev/null 2>&1; do`,
      'attempt=$((attempt + 1));',
      `if [ "$attempt" -ge 90 ]; then docker logs --tail 200 ${k0sName} >&2; exit 1; fi;`,
      'sleep 2;',
      'done;',
      `docker exec ${k0sName} k0s kubeconfig admin |`,
      `sed -E 's#server: https://[^:]+:6443#server: https://127.0.0.1:${apiPort}#'`,
    ].join(' '),
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
  beforeTenancy: (wasmcloud) => {
    const runtimeShutdown = new command.local.Command(
      'runtime-shutdown',
      {
        create: 'true',
        delete: [
          'set -eu;',
          'docker exec "$K0S_NAME" k0s kubectl --namespace "$NAMESPACE"',
          'delete deployment/hostgroup-default',
          '--ignore-not-found=true --wait=true --timeout=180s;',
          'docker exec "$K0S_NAME" k0s kubectl --namespace "$NAMESPACE"',
          'delete hosts.runtime.wasmcloud.dev --all',
          '--ignore-not-found=true --wait=true --timeout=180s',
        ].join(' '),
        environment: { K0S_NAME: k0sName, NAMESPACE: namespaceName },
      },
      { dependsOn: [wasmcloud, kubeconfigFileCommand] },
    );

    return runtimeShutdown;
  },
});
export const tenants = platform.tenants;
export const users = platform.users;

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

function refuseExistingNetworkThenCreate(name: string): string {
  return [
    'set -eu;',
    `if docker network inspect ${name} >/dev/null 2>&1; then`,
    `echo "Refusing to replace existing network ${name}" >&2; exit 1; fi;`,
    `docker network create --label ${ownershipLabel}=${scope} ${name}`,
  ].join(' ');
}

function refuseExistingVolumeThenCreate(name: string): string {
  return [
    'set -eu;',
    `if docker volume inspect ${name} >/dev/null 2>&1; then`,
    `echo "Refusing to replace existing volume ${name}" >&2; exit 1; fi;`,
    `docker volume create --label ${ownershipLabel}=${scope} ${name}`,
  ].join(' ');
}

function deleteOwnedContainer(name: string): string {
  return [
    `owner="$(docker container inspect --format '{{ index .Config.Labels "${ownershipLabel}" }}' ${name} 2>/dev/null || true)";`,
    `[ "$owner" != "${scope}" ] || docker container rm --force ${name}`,
  ].join(' ');
}

function deleteOwnedNetwork(name: string): string {
  return [
    `owner="$(docker network inspect --format '{{ index .Labels "${ownershipLabel}" }}' ${name} 2>/dev/null || true)";`,
    `[ "$owner" != "${scope}" ] || docker network rm ${name}`,
  ].join(' ');
}

function deleteOwnedVolume(name: string): string {
  return [
    `owner="$(docker volume inspect --format '{{ index .Labels "${ownershipLabel}" }}' ${name} 2>/dev/null || true)";`,
    `[ "$owner" != "${scope}" ] || docker volume rm ${name}`,
  ].join(' ');
}
