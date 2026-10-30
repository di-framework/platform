/**
 * The platform-owned scheduler NATS server (#541 m6b, design-541 §4.1-4.4).
 *
 * {@link schedulerNatsServerResources} renders the manifests that replace the runtime-operator
 * chart's `nats` server; `createPlatform` installs them before the Helm release (m6e):
 *
 * - ConfigMap {@link SCHEDULER_NATS_CONFIG}: the static `nats-server.conf`, which includes
 *   `accounts.conf` from the ConfigMap `di-scheduler-nats-accounts` (m2, written by the platform
 *   controller only), serves TLS from the server Secret `di-scheduler-nats-tls` (m1) with
 *   `verify_and_map`, and enables JetStream at server level, which only the `DATA` account uses
 *   (O5). No debug or trace logging (#550).
 * - Deployment `di-scheduler-nats`: the chart's workload (one replica, port 4222, probes, security contexts,
 *   resources, JetStream `emptyDir`) plus the upstream config reloader in a shared process
 *   namespace, which signals the server when the config, the accounts file or the certificate
 *   changes. Both images are pinned by digest.
 * - Service `nats`: name, labels, selector and port identical to the chart's, so the clients'
 *   `nats://nats.<ns>.svc.cluster.local:4222` and the NetworkPolicies selecting
 *   `wasmcloud.com/name: nats` keep working after the handover.
 * - A ServiceAccount without a token.
 */
import { ACCOUNTS_KEY, SCHEDULER_NATS_ACCOUNTS } from './tenancy/scheduler-nats';
import { PLATFORM_SECRETS } from './tenancy/scheduler-pki';
import { WASMCLOUD_OPERATOR_VERSION } from './tenancy/tenant-operator';

/** nats-server 2.12.8, the version chart 2.8.0 ships (`docker.io/nats:2.12.8-alpine`), by index digest. */
export const SCHEDULER_NATS_IMAGE =
  'docker.io/library/nats:2.12.8-alpine@sha256:6b2156f7491cdeddfa8b7ca15cd6fd59b9cabadec5019e933c65c01cf82b1c5f';
/** The upstream `nats-server-config-reloader` (nats-io/nack v0.24.0), by index digest. */
export const SCHEDULER_NATS_RELOADER_IMAGE =
  'docker.io/natsio/nats-server-config-reloader:0.24.0@sha256:d758a82a9c20337e46c2f7356a413faa52cf4d6b02497c3ad81f72f1ba106464';

/** The name of the chart's server Service, and its pod label value. */
export const SCHEDULER_NATS_NAME = 'nats';
/**
 * The platform's server Deployment. Not the chart's `nats`, so it never collides with the chart's
 * Deployment while an upgrade hands the server over (m6e).
 */
export const SCHEDULER_NATS_DEPLOYMENT = 'di-scheduler-nats';
/** The ConfigMap holding the static `nats-server.conf`. */
export const SCHEDULER_NATS_CONFIG = 'di-scheduler-nats';
export const SCHEDULER_NATS_SERVICE_ACCOUNT = 'di-scheduler-nats';
export const SCHEDULER_NATS_CONFIG_KEY = 'nats-server.conf';
export const SCHEDULER_NATS_PORT = 4222;
const PORT_NAME = 'tcp-nats';

const CONFIG_DIR = '/nats-config';
const CERT_DIR = '/nats-cert';
const PID_DIR = '/var/run/nats';
const PID_FILE = `${PID_DIR}/nats.pid`;
const JETSTREAM_DIR = '/data/jetstream';
/** Relative to the config file's directory, where the accounts ConfigMap is projected. */
const ACCOUNTS_PATH = `accounts/${ACCOUNTS_KEY}`;

/**
 * JetStream limits. nats-server sizes its defaults from the node, not the container's cgroup, so
 * without them one `DATA` memory stream could grow past the 128Mi limit and OOM-kill the only
 * scheduler NATS, and a file stream could fill the node's disk through the emptyDir. The memory
 * store stays at a quarter of the container limit; the file store matches the emptyDir's
 * `sizeLimit`. To be tuned against Layer 3. The `DATA` account's own limits are m2's file (m6d).
 */
export const JETSTREAM_MAX_MEMORY_STORE = '32M';
export const JETSTREAM_MAX_FILE_STORE = '1G';
export const JETSTREAM_VOLUME_SIZE_LIMIT = '1Gi';

/** The static server configuration. Only a `pulumi up` changes it. */
export function schedulerNatsServerConfig(): string {
  return `port: ${SCHEDULER_NATS_PORT}
pid_file: "${PID_FILE}"
tls {
  cert_file: "${CERT_DIR}/tls.crt"
  key_file: "${CERT_DIR}/tls.key"
  ca_file: "${CERT_DIR}/ca.crt"
  verify_and_map: true
}
jetstream {
  store_dir: "${JETSTREAM_DIR}"
  max_memory_store: ${JETSTREAM_MAX_MEMORY_STORE}
  max_file_store: ${JETSTREAM_MAX_FILE_STORE}
}
include "${ACCOUNTS_PATH}"
`;
}

export interface SchedulerNatsServerConfig {
  /** The platform namespace. */
  namespace: string;
  /** The runtime-operator Helm release name, for the chart's `app.kubernetes.io/instance` label. */
  release?: string;
}

/**
 * The pod label every selector and policy keys on: the chart's Service and Deployment selectors,
 * `tenancy.ts`, `platform-ingress.ts`, the tenant operator egress and the vCluster target's
 * `allow-platform-nats`. The pod template carries only this, so a runtime-operator bump does not
 * roll the server.
 */
export const SCHEDULER_NATS_POD_LABELS = { 'wasmcloud.com/name': SCHEDULER_NATS_NAME };

/** The labels the chart puts on its `nats` objects, kept on the objects' own metadata. */
export function schedulerNatsLabels(release = 'wasmcloud'): Record<string, string> {
  return {
    'wasmcloud.com/name': SCHEDULER_NATS_NAME,
    'helm.sh/chart': `runtime-operator-${WASMCLOUD_OPERATOR_VERSION}`,
    'app.kubernetes.io/name': 'runtime-operator',
    'app.kubernetes.io/instance': release,
    'app.kubernetes.io/version': WASMCLOUD_OPERATOR_VERSION,
    'app.kubernetes.io/managed-by': 'Helm',
  };
}

type Manifest = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  [key: string]: unknown;
};

const containerSecurityContext = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
};

/** The ConfigMap, ServiceAccount, Deployment and Service of the platform-owned `nats` server. */
export function schedulerNatsServerResources(cfg: SchedulerNatsServerConfig): Manifest[] {
  const labels = schedulerNatsLabels(cfg.release);
  const metadata = (name: string) => ({ name, namespace: cfg.namespace, labels });
  const selector = SCHEDULER_NATS_POD_LABELS;
  const watched = [
    `${CONFIG_DIR}/${SCHEDULER_NATS_CONFIG_KEY}`,
    `${CONFIG_DIR}/${ACCOUNTS_PATH}`,
    `${CERT_DIR}/tls.crt`,
    `${CERT_DIR}/tls.key`,
    `${CERT_DIR}/ca.crt`,
  ];
  const certMounts = [
    { name: 'nats-config', mountPath: CONFIG_DIR, readOnly: true },
    { name: 'nats-cert', mountPath: CERT_DIR, readOnly: true },
    { name: 'pid', mountPath: PID_DIR },
  ];
  return [
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: metadata(SCHEDULER_NATS_CONFIG),
      data: { [SCHEDULER_NATS_CONFIG_KEY]: schedulerNatsServerConfig() },
    },
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: metadata(SCHEDULER_NATS_SERVICE_ACCOUNT),
      automountServiceAccountToken: false,
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(SCHEDULER_NATS_DEPLOYMENT),
      spec: {
        replicas: 1,
        selector: { matchLabels: selector },
        template: {
          metadata: { labels: SCHEDULER_NATS_POD_LABELS },
          spec: {
            automountServiceAccountToken: false,
            serviceAccountName: SCHEDULER_NATS_SERVICE_ACCOUNT,
            // The reloader signals the server through its pid file.
            shareProcessNamespace: true,
            securityContext: {
              fsGroup: 65532,
              runAsGroup: 65532,
              runAsNonRoot: true,
              runAsUser: 65532,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            volumes: [
              {
                name: 'nats-config',
                projected: {
                  sources: [
                    {
                      configMap: {
                        name: SCHEDULER_NATS_CONFIG,
                        items: [
                          { key: SCHEDULER_NATS_CONFIG_KEY, path: SCHEDULER_NATS_CONFIG_KEY },
                        ],
                      },
                    },
                    {
                      // Required: the bootstrap Job creates it, the platform controller writes it.
                      configMap: {
                        name: SCHEDULER_NATS_ACCOUNTS,
                        items: [{ key: ACCOUNTS_KEY, path: ACCOUNTS_PATH }],
                      },
                    },
                  ],
                },
              },
              { name: 'nats-cert', secret: { secretName: PLATFORM_SECRETS.server } },
              { name: 'pid', emptyDir: {} },
              { name: 'tmp', emptyDir: {} },
              { name: 'jetstream', emptyDir: { sizeLimit: JETSTREAM_VOLUME_SIZE_LIMIT } },
            ],
            containers: [
              {
                name: 'nats',
                image: SCHEDULER_NATS_IMAGE,
                args: ['-c', `${CONFIG_DIR}/${SCHEDULER_NATS_CONFIG_KEY}`],
                imagePullPolicy: 'IfNotPresent',
                volumeMounts: [
                  ...certMounts,
                  { name: 'tmp', mountPath: '/tmp' },
                  { name: 'jetstream', mountPath: JETSTREAM_DIR },
                ],
                ports: [{ name: PORT_NAME, containerPort: SCHEDULER_NATS_PORT }],
                livenessProbe: {
                  tcpSocket: { port: PORT_NAME },
                  initialDelaySeconds: 10,
                  periodSeconds: 20,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  tcpSocket: { port: PORT_NAME },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  limits: { memory: '128Mi' },
                  requests: { cpu: '100m', memory: '64Mi' },
                },
                securityContext: containerSecurityContext,
              },
              {
                name: 'reloader',
                image: SCHEDULER_NATS_RELOADER_IMAGE,
                args: ['-pid', PID_FILE, ...watched.flatMap((file) => ['-config', file])],
                imagePullPolicy: 'IfNotPresent',
                volumeMounts: certMounts,
                resources: {
                  limits: { memory: '32Mi' },
                  requests: { cpu: '10m', memory: '16Mi' },
                },
                securityContext: containerSecurityContext,
              },
            ],
            dnsPolicy: 'ClusterFirst',
            restartPolicy: 'Always',
            terminationGracePeriodSeconds: 0,
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(SCHEDULER_NATS_NAME),
      spec: {
        selector,
        type: 'ClusterIP',
        ports: [
          {
            port: SCHEDULER_NATS_PORT,
            targetPort: PORT_NAME,
            protocol: 'TCP',
            name: PORT_NAME,
          },
        ],
      },
    },
  ];
}
