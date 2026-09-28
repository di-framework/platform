import { createHash, randomBytes } from 'node:crypto';
import {
  backingLabels,
  backingServiceResourceName,
  parseMemory,
} from './backing-service-reconcile';
import {
  type BackingService,
  type BackingServiceClass,
  type ControllerConfig,
  GROUP,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  type SizingParameters,
  type Tenant,
} from './resources';

export const POSTGRES_IMAGE = 'postgres:18.3-bookworm';
/** Persistent identities never recycle data when a BackingService name is reused. */
export function postgresNames(service: BackingService) {
  if (!service.metadata.uid) throw new Error('PostgreSQL requires a BackingService UID');
  const id = createHash('sha256').update(service.metadata.uid).digest('hex').slice(0, 16);
  const persistent = `di-pg-${service.metadata.name.slice(0, 30)}-${id}`;
  return {
    pvc: persistent,
    credentials: `${persistent}-auth`,
    connection: `${persistent}-conn`,
    bootstrap: `${backingServiceResourceName(service.metadata.name)}-init`,
    instance: backingServiceResourceName(service.metadata.name),
  };
}
export function secretData(secret: Resource): Record<string, string> {
  if (secret.stringData) return secret.stringData as Record<string, string>;
  return Object.fromEntries(
    Object.entries((secret.data ?? {}) as Record<string, string>).map(([k, v]) => [
      k,
      Buffer.from(v, 'base64').toString('utf8'),
    ]),
  );
}
export function assertPostgresOwner(
  resource: Resource,
  service: BackingService,
  cfg: ControllerConfig,
) {
  if (
    resource.metadata.labels?.[OWNER] !== service.metadata.uid ||
    resource.metadata.labels?.[INSTALLATION] !== cfg.installation
  )
    throw new Error(`Refusing to adopt ${resource.kind} ${resource.metadata.name}`);
}

// The official entrypoint initializes PGDATA once. Our bootstrap also runs after
// restarts so interrupted role/database creation can finish without resetting passwords.
export const POSTGRES_BOOTSTRAP = `#!/bin/bash
set -Eeuo pipefail
rm -f /tmp/di-postgres-ready
docker-entrypoint.sh postgres &
server_pid=$!
trap 'kill -INT "$server_pid" 2>/dev/null || true; wait "$server_pid" || true' TERM INT
export PGPASSWORD="$POSTGRES_PASSWORD"
ready=false
for attempt in {1..120}; do
  kill -0 "$server_pid" 2>/dev/null || { wait "$server_pid"; exit 1; }
  if psql -h 127.0.0.1 -U postgres -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { echo 'PostgreSQL initialization timed out; inspect the instance logs and recovery credentials' >&2; kill -INT "$server_pid"; wait "$server_pid"; exit 1; }
psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
\\getenv app_password APP_PASSWORD
SELECT format('CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_password') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app') \\gexec
SELECT 'CREATE DATABASE app OWNER app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'app') \\gexec
ALTER DATABASE app OWNER TO app;
REVOKE ALL ON DATABASE app FROM PUBLIC;
SQL
PGPASSWORD="$APP_PASSWORD" psql -h 127.0.0.1 -U app -d app -Atqc 'SELECT 1' >/dev/null
touch /tmp/di-postgres-ready
wait "$server_pid"
`;

export interface PostgresApi {
  get(
    apiVersion: string,
    kind: string,
    namespace: string | undefined,
    name: string,
  ): Promise<Resource | undefined>;
  ensure(value: Resource): Promise<Resource>;
  create(value: Resource): Promise<Resource>;
}
export function postgresResource(
  service: BackingService,
  tenant: Tenant,
  cfg: ControllerConfig,
  kind: string,
  name: string,
  body: Record<string, unknown>,
): Resource {
  return {
    apiVersion: kind === 'Deployment' ? 'apps/v1' : 'v1',
    kind,
    metadata: {
      name,
      namespace: names(tenant.metadata.name).runtimeNamespace,
      labels: backingLabels(service, tenant, cfg.installation),
    },
    ...body,
  };
}

export async function ensurePostgresCredentials(
  api: PostgresApi,
  service: BackingService,
  tenant: Tenant,
  cfg: ControllerConfig,
): Promise<Resource> {
  const n = postgresNames(service);
  const ns = names(tenant.metadata.name).runtimeNamespace;
  let credentials = await api.get('v1', 'Secret', ns, n.credentials);
  if (!credentials) {
    if (await api.get('v1', 'PersistentVolumeClaim', ns, n.pvc))
      throw new Error(
        `CredentialsMissing: restore runtime Secret ${n.credentials} from recovery credentials before restarting PVC ${n.pvc}; passwords will not be regenerated`,
      );
    credentials = await api.create(
      postgresResource(service, tenant, cfg, 'Secret', n.credentials, {
        type: 'Opaque',
        stringData: {
          POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
          APP_PASSWORD: randomBytes(32).toString('hex'),
        },
      }),
    );
  }
  assertPostgresOwner(credentials, service, cfg);
  const data = secretData(credentials);
  if (!data.POSTGRES_PASSWORD || !data.APP_PASSWORD)
    throw new Error(
      `CredentialsMissing: restore both passwords in runtime Secret ${n.credentials}`,
    );
  return credentials;
}

export async function ensurePostgresStorage(
  api: PostgresApi,
  service: BackingService,
  tenant: Tenant,
  cls: BackingServiceClass,
  cfg: ControllerConfig,
  sizing: SizingParameters,
): Promise<Resource> {
  const n = postgresNames(service);
  const existing = await api.get(
    'v1',
    'PersistentVolumeClaim',
    names(tenant.metadata.name).runtimeNamespace,
    n.pvc,
  );
  const storage = sizing.storage ?? '1Gi';
  if (parseMemory(storage) <= 0) throw new Error('PostgreSQL storage must be positive');
  if (existing) {
    assertPostgresOwner(existing, service, cfg);
    const spec = existing.spec as {
      storageClassName?: string;
      resources: { requests: { storage: string } };
    };
    const previous = spec.resources.requests.storage;
    if (parseMemory(storage) < parseMemory(previous))
      throw new Error(
        `StorageShrinkForbidden: requested ${storage}, existing PVC requests ${previous}`,
      );
    if (parseMemory(storage) === parseMemory(previous)) return existing;
    const storageClass = spec.storageClassName
      ? await api.get('storage.k8s.io/v1', 'StorageClass', undefined, spec.storageClassName)
      : undefined;
    if (storageClass?.allowVolumeExpansion !== true)
      throw new Error(
        `StorageExpansionUnsupported: StorageClass ${spec.storageClassName ?? '(none)'} does not allow expansion`,
      );
    return api.ensure(
      postgresResource(service, tenant, cfg, 'PersistentVolumeClaim', n.pvc, {
        spec: { ...spec, resources: { requests: { storage } } },
      }),
    );
  }
  return api.ensure(
    postgresResource(service, tenant, cfg, 'PersistentVolumeClaim', n.pvc, {
      spec: {
        accessModes: ['ReadWriteOnce'],
        ...(cls.spec.storageClassName === undefined
          ? {}
          : { storageClassName: cls.spec.storageClassName }),
        resources: { requests: { storage } },
      },
    }),
  );
}

export function postgresServingResources(
  service: BackingService,
  tenant: Tenant,
  cfg: ControllerConfig,
  sizing: SizingParameters,
  credentials: Resource,
): Resource[] {
  const n = postgresNames(service);
  const host = `${n.instance}.${names(tenant.metadata.name).runtimeNamespace}.svc.cluster.local`;
  const password = secretData(credentials).APP_PASSWORD!;
  const make = (kind: string, name: string, body: Record<string, unknown>) =>
    postgresResource(service, tenant, cfg, kind, name, body);
  const labels = {
    ...backingLabels(service, tenant, cfg.installation),
    app: n.instance,
    [`${GROUP}/component`]: 'backing-service',
  };
  return [
    make('Secret', n.connection, {
      type: 'Opaque',
      stringData: {
        url: `postgresql://app:${encodeURIComponent(password)}@${host}:5432/app`,
        username: 'app',
        password,
      },
    }),
    make('ConfigMap', n.bootstrap, { data: { 'start.sh': POSTGRES_BOOTSTRAP } }),
    make('Service', n.instance, {
      spec: { selector: { app: n.instance }, ports: [{ port: 5432, targetPort: 5432 }] },
    }),
    make('Deployment', n.instance, {
      spec: {
        replicas: tenant.spec.suspended || tenant.metadata.deletionTimestamp ? 0 : 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { app: n.instance } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: 60,
            containers: [
              {
                name: 'postgres',
                image: POSTGRES_IMAGE,
                command: ['bash', '/bootstrap/start.sh'],
                envFrom: [{ secretRef: { name: n.credentials } }],
                env: [
                  { name: 'PGDATA', value: '/var/lib/postgresql/18/docker' },
                  { name: 'POSTGRES_INITDB_ARGS', value: '--auth-host=scram-sha-256' },
                ],
                ports: [{ containerPort: 5432 }],
                resources: {
                  requests: { cpu: sizing.cpu ?? '250m', memory: sizing.memory ?? '512Mi' },
                  limits: { cpu: sizing.cpu ?? '250m', memory: sizing.memory ?? '512Mi' },
                },
                readinessProbe: {
                  exec: {
                    command: [
                      'bash',
                      '-ec',
                      'test -f /tmp/di-postgres-ready && PGPASSWORD="$APP_PASSWORD" psql -h 127.0.0.1 -U app -d app -Atqc "SELECT 1"',
                    ],
                  },
                  periodSeconds: 5,
                  timeoutSeconds: 5,
                },
                volumeMounts: [
                  { name: 'data', mountPath: '/var/lib/postgresql' },
                  { name: 'bootstrap', mountPath: '/bootstrap', readOnly: true },
                ],
              },
            ],
            volumes: [
              { name: 'data', persistentVolumeClaim: { claimName: n.pvc } },
              { name: 'bootstrap', configMap: { name: n.bootstrap } },
            ],
          },
        },
      },
    }),
  ];
}

export function postgresReadiness(
  pvc: Resource,
  deployments: Resource[],
  pods: Resource[],
): { ready: boolean; reason: string; message: string } {
  if ((pvc.status as { phase?: string } | undefined)?.phase !== 'Bound')
    return {
      ready: false,
      reason: 'StoragePending',
      message: `Waiting for PVC ${pvc.metadata.name}; check StorageClass provisioner, capacity and scheduling events`,
    };
  for (const pod of pods) {
    const statuses =
      (
        pod.status as
          | {
              containerStatuses?: {
                state?: { waiting?: { reason?: string }; terminated?: { exitCode?: number } };
              }[];
            }
          | undefined
      )?.containerStatuses ?? [];
    if (
      statuses.some(
        (s) =>
          ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'].includes(
            s.state?.waiting?.reason ?? '',
          ) || (s.state?.terminated?.exitCode ?? 0) !== 0,
      )
    )
      return {
        ready: false,
        reason: 'InitializationFailed',
        message: `PostgreSQL pod ${pod.metadata.name} failed; inspect runtime pod logs and restore credentials if authentication fails`,
      };
  }
  const ready =
    deployments.length > 0 &&
    deployments.every((d) => {
      const status = d.status as
        | { observedGeneration?: number; readyReplicas?: number }
        | undefined;
      return status?.observedGeneration === d.metadata.generation && status?.readyReplicas === 1;
    });
  return {
    ready,
    reason: ready ? 'Ready' : 'Initializing',
    message: ready
      ? 'PostgreSQL application database authenticated and ready'
      : 'Waiting for PostgreSQL bootstrap and authenticated application readiness',
  };
}
