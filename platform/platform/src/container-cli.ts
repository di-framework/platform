/**
 * Shell command builders for the local entrypoint's container engine. Every
 * command takes the configured CLI (`docker` by default, or a compatible one
 * such as `podman`), so the inspect templates below stick to fields that both
 * engines expose: `.Config.Labels` for containers and `.Labels` for networks
 * and volumes.
 */

export const DEFAULT_CONTAINER_CLI = 'docker';

/** Identifies one local platform's container resources. */
export interface ContainerScope {
  cli: string;
  ownershipLabel: string;
  scope: string;
}

export interface K0sContainer {
  name: string;
  image: string;
  network: string;
  dataVolume: string;
  podLogsVolume: string;
  publish: { host: number; container: number }[];
}

/** A plain command name or path: no whitespace, quoting, or shell metacharacters. */
export function containerCli(value: string | undefined): string {
  const cli = value ?? DEFAULT_CONTAINER_CLI;
  if (!/^[A-Za-z0-9_./+-]+$/.test(cli) || cli.startsWith('-')) {
    throw new Error(
      `containerCli must be a plain command name or path such as docker or podman; received ${JSON.stringify(cli)}`,
    );
  }
  return cli;
}

export function refuseExistingNetworkThenCreate(target: ContainerScope, name: string): string {
  const { cli, ownershipLabel, scope } = target;
  return [
    'set -eu;',
    `if ${cli} network inspect ${name} >/dev/null 2>&1; then`,
    `echo "Refusing to replace existing network ${name}" >&2; exit 1; fi;`,
    `${cli} network create --label ${ownershipLabel}=${scope} ${name}`,
  ].join(' ');
}

export function refuseExistingVolumeThenCreate(target: ContainerScope, name: string): string {
  const { cli, ownershipLabel, scope } = target;
  return [
    'set -eu;',
    `if ${cli} volume inspect ${name} >/dev/null 2>&1; then`,
    `echo "Refusing to replace existing volume ${name}" >&2; exit 1; fi;`,
    `${cli} volume create --label ${ownershipLabel}=${scope} ${name}`,
  ].join(' ');
}

export function refuseExistingContainerThenRun(target: ContainerScope, k0s: K0sContainer): string {
  const { cli, ownershipLabel, scope } = target;
  return [
    'set -eu;',
    `if ${cli} container inspect ${k0s.name} >/dev/null 2>&1; then`,
    `echo "Refusing to replace existing container ${k0s.name}" >&2; exit 1; fi;`,
    `${cli} run -d`,
    `--name ${k0s.name}`,
    `--hostname ${k0s.name}`,
    `--label ${ownershipLabel}=${scope}`,
    `--network ${k0s.network}`,
    '--privileged',
    '--tmpfs /run:rw,nosuid,nodev,exec,mode=755',
    `--mount type=volume,source=${k0s.dataVolume},target=/var/lib/k0s`,
    `--mount type=volume,source=${k0s.podLogsVolume},target=/var/log/pods`,
    ...k0s.publish.map((port) => `--publish 127.0.0.1:${port.host}:${port.container}`),
    k0s.image,
    'k0s controller --enable-worker --no-taints',
  ].join(' ');
}

/** Waits for the k0s API and node, then prints an admin kubeconfig for the host port. */
export function readKubeconfig(cli: string, name: string, apiPort: number): string {
  return [
    'set -eu;',
    'attempt=0;',
    `until ${cli} exec ${name} k0s kubectl get --raw=/readyz >/dev/null 2>&1 &&`,
    `${cli} exec ${name} k0s kubectl wait node --all --for=condition=Ready --timeout=5s >/dev/null 2>&1; do`,
    'attempt=$((attempt + 1));',
    `if [ "$attempt" -ge 90 ]; then ${cli} logs --tail 200 ${name} >&2; exit 1; fi;`,
    'sleep 2;',
    'done;',
    `${cli} exec ${name} k0s kubeconfig admin |`,
    `sed -E 's#server: https://[^:]+:6443#server: https://127.0.0.1:${apiPort}#'`,
  ].join(' ');
}

/** Stops runtime hosts through the k0s-bundled kubectl; reads `$K0S_NAME` and `$NAMESPACE`. */
export function shutdownRuntime(cli: string): string {
  return [
    'set -eu;',
    `${cli} exec "$K0S_NAME" k0s kubectl --namespace "$NAMESPACE"`,
    'delete deployment/hostgroup-default',
    '--ignore-not-found=true --wait=true --timeout=180s;',
    `${cli} exec "$K0S_NAME" k0s kubectl --namespace "$NAMESPACE"`,
    'delete hosts.runtime.wasmcloud.dev --all',
    '--ignore-not-found=true --wait=true --timeout=180s',
  ].join(' ');
}

export function deleteOwnedContainer(target: ContainerScope, name: string): string {
  return deleteOwned(target, 'container', '.Config.Labels', `container rm --force ${name}`, name);
}

export function deleteOwnedNetwork(target: ContainerScope, name: string): string {
  return deleteOwned(target, 'network', '.Labels', `network rm ${name}`, name);
}

export function deleteOwnedVolume(target: ContainerScope, name: string): string {
  return deleteOwned(target, 'volume', '.Labels', `volume rm ${name}`, name);
}

function deleteOwned(
  { cli, ownershipLabel, scope }: ContainerScope,
  kind: string,
  labels: string,
  remove: string,
  name: string,
): string {
  return [
    `owner="$(${cli} ${kind} inspect --format '{{ index ${labels} "${ownershipLabel}" }}' ${name} 2>/dev/null || true)";`,
    `[ "$owner" != "${scope}" ] || ${cli} ${remove}`,
  ].join(' ');
}
