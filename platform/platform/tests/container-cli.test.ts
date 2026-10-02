import { describe, expect, it } from 'bun:test';
import {
  type ContainerScope,
  containerCli,
  DEFAULT_CONTAINER_CLI,
  deleteOwnedContainer,
  deleteOwnedNetwork,
  deleteOwnedVolume,
  readKubeconfig,
  refuseExistingContainerThenRun,
  refuseExistingNetworkThenCreate,
  refuseExistingVolumeThenCreate,
  shutdownRuntime,
} from '../src/container-cli';

const LABEL = 'di-framework.dev.platform-scope';
const owned = (cli: string): ContainerScope => ({ cli, ownershipLabel: LABEL, scope: 'di-test' });
const k0s = {
  name: 'di-test-k0s',
  image: 'docker.io/k0sproject/k0s:test',
  network: 'di-test-network',
  dataVolume: 'di-test-k0s-data',
  podLogsVolume: 'di-test-k0s-pod-logs',
  publish: [
    { host: 26443, container: 6443 },
    { host: 25000, container: 30500 },
  ],
};

describe('containerCli', () => {
  it('defaults to docker and accepts plain command names and paths', () => {
    expect(containerCli(undefined)).toBe(DEFAULT_CONTAINER_CLI);
    expect(DEFAULT_CONTAINER_CLI).toBe('docker');
    for (const cli of ['podman', '/opt/homebrew/bin/podman', './bin/nerdctl', 'docker-1.0_x+y']) {
      expect(containerCli(cli)).toBe(cli);
    }
  });

  it('rejects shell metacharacters, whitespace, options, and empty values', () => {
    for (const cli of [
      '',
      'podman --remote',
      'podman;rm -rf /',
      'docker|tee',
      '$(id)',
      '`id`',
      'po"dman',
      "po'dman",
      'docker&',
      'a>b',
      'po\ndman',
      '-docker',
      '~/bin/podman',
    ]) {
      expect(() => containerCli(cli)).toThrow('containerCli must be a plain command name or path');
    }
  });
});

describe('container command builders', () => {
  it('uses only the configured CLI', () => {
    const commands = [
      refuseExistingNetworkThenCreate(owned('podman'), 'n'),
      refuseExistingVolumeThenCreate(owned('podman'), 'v'),
      refuseExistingContainerThenRun(owned('podman'), k0s),
      readKubeconfig('podman', k0s.name, 26443),
      shutdownRuntime('podman'),
      deleteOwnedContainer(owned('podman'), 'c'),
      deleteOwnedNetwork(owned('podman'), 'n'),
      deleteOwnedVolume(owned('podman'), 'v'),
    ];
    for (const command of commands) {
      expect(command).toContain('podman ');
      expect(command).not.toMatch(/\bdocker (run|exec|logs|network|volume|container)\b/);
    }
  });

  it('refuses to adopt existing networks and volumes before creating labelled ones', () => {
    expect(refuseExistingNetworkThenCreate(owned('podman'), 'di-test-network')).toBe(
      'set -eu; if podman network inspect di-test-network >/dev/null 2>&1; then ' +
        'echo "Refusing to replace existing network di-test-network" >&2; exit 1; fi; ' +
        `podman network create --label ${LABEL}=di-test di-test-network`,
    );
    expect(refuseExistingVolumeThenCreate(owned('docker'), 'di-test-k0s-data')).toBe(
      'set -eu; if docker volume inspect di-test-k0s-data >/dev/null 2>&1; then ' +
        'echo "Refusing to replace existing volume di-test-k0s-data" >&2; exit 1; fi; ' +
        `docker volume create --label ${LABEL}=di-test di-test-k0s-data`,
    );
  });

  it('runs a labelled k0s container publishing only loopback ports', () => {
    const run = refuseExistingContainerThenRun(owned('podman'), k0s);
    expect(run).toStartWith(
      'set -eu; if podman container inspect di-test-k0s >/dev/null 2>&1; then ' +
        'echo "Refusing to replace existing container di-test-k0s" >&2; exit 1; fi; podman run -d ',
    );
    expect(run).toContain(`--label ${LABEL}=di-test --network di-test-network --privileged`);
    expect(run).toContain('--mount type=volume,source=di-test-k0s-data,target=/var/lib/k0s');
    expect(run).toContain('--mount type=volume,source=di-test-k0s-pod-logs,target=/var/log/pods');
    expect(run).toContain(
      '--publish 127.0.0.1:26443:6443 --publish 127.0.0.1:25000:30500 docker.io/k0sproject/k0s:test',
    );
    expect(run).toEndWith('k0s controller --enable-worker --no-taints');
  });

  it('reads the kubeconfig and stops the runtime through the container', () => {
    const kubeconfig = readKubeconfig('podman', 'di-test-k0s', 36443);
    expect(kubeconfig).toContain('until podman exec di-test-k0s k0s kubectl get --raw=/readyz');
    expect(kubeconfig).toContain('podman logs --tail 200 di-test-k0s >&2; exit 1;');
    expect(kubeconfig).toContain(
      "podman exec di-test-k0s k0s kubeconfig admin | sed -E 's#server: https://[^:]+:6443#server: https://127.0.0.1:36443#'",
    );
    const shutdown = shutdownRuntime('podman');
    expect(shutdown.match(/podman exec "\$K0S_NAME" k0s kubectl/g)).toHaveLength(2);
    expect(shutdown).toContain('delete deployment/hostgroup-default');
  });

  it('deletes only resources labelled with this scope, using templates docker and podman share', () => {
    expect(deleteOwnedContainer(owned('podman'), 'di-test-k0s')).toBe(
      `owner="$(podman container inspect --format '{{ index .Config.Labels "${LABEL}" }}' di-test-k0s 2>/dev/null || true)"; ` +
        '[ "$owner" != "di-test" ] || podman container rm --force di-test-k0s',
    );
    expect(deleteOwnedNetwork(owned('podman'), 'di-test-network')).toBe(
      `owner="$(podman network inspect --format '{{ index .Labels "${LABEL}" }}' di-test-network 2>/dev/null || true)"; ` +
        '[ "$owner" != "di-test" ] || podman network rm di-test-network',
    );
    expect(deleteOwnedVolume(owned('docker'), 'di-test-k0s-data')).toBe(
      `owner="$(docker volume inspect --format '{{ index .Labels "${LABEL}" }}' di-test-k0s-data 2>/dev/null || true)"; ` +
        '[ "$owner" != "di-test" ] || docker volume rm di-test-k0s-data',
    );
  });
});
