import { PLATFORM_SECRETS } from './tenancy/scheduler-pki';

type Values = Record<string, unknown>;

const object = (value: unknown): Values =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Values) : {};

/**
 * The flags the chart renders from the enforced settings, by name or name prefix. The chart
 * appends `extraArgs` after them, and the last value wins (Go's `flag`) or the duplicate aborts
 * (clap), so an `extraArgs` entry naming one is refused.
 * - Operator (runtime-operator v2.8.0 `cmd/main.go`): every `-nats-*` (URL, CA, client cert and
 *   key, creds, TLS-first), `-watch-namespaces`, `-host-namespaces`, `-allow-shared-hosts`.
 * - Host (chart 2.8.0 `runtime/deployment.yaml`): every `--scheduler-nats-*` and `--data-nats-*`
 *   (URL, TLS CA, cert and key).
 */
const OPERATOR_FLAGS = [
  /^nats-/,
  /^watch-namespaces$/,
  /^host-namespaces$/,
  /^allow-shared-hosts$/,
];
const HOST_FLAGS = [/^scheduler-nats-/, /^data-nats-/];
/**
 * The environment the enforced settings depend on: the operator's own namespace, its Host store
 * (`OPERATOR_NAMESPACE`, rendered before `operator.env`, whose later entry wins), and the
 * `WASH_*` fallbacks of the host's NATS flags.
 */
const OPERATOR_ENV = [/^OPERATOR_NAMESPACE$/];
const HOST_ENV = [/^WASH_SCHEDULER_NATS_/, /^WASH_DATA_NATS_/];

/** A command-line argument's flag name: `-name`, `--name`, `-name=value` or `--name=value`. */
const flagName = (arg: unknown): string | undefined => {
  const match = /^--?([^=]+)/.exec(String(arg));
  return match?.[1];
};

function refuseEnforced(where: string, args: unknown, enforced: RegExp[]): void {
  for (const arg of Array.isArray(args) ? args : []) {
    const name = flagName(arg);
    if (name && enforced.some((pattern) => pattern.test(name)))
      throw new Error(
        `${where}: ${String(arg)} sets a flag the platform enforces (design-541 §4.1); remove it`,
      );
  }
}

function refuseEnforcedEnv(where: string, env: unknown, enforced: RegExp[]): void {
  for (const entry of Array.isArray(env) ? env : []) {
    const name = String(object(entry).name);
    if (enforced.some((pattern) => pattern.test(name)))
      throw new Error(`${where}: ${name} is set by the platform (design-541 §4.1); remove it`);
  }
}

/**
 * Merge administrator overrides, then enforce platform-owned security settings (design-541 §4.1):
 * - the chart renders no scheduler NATS (`nats.enabled=false`), generates no CA or certificate,
 *   and mounts the platform-issued Secrets, always over TLS;
 * - its operator watches and hosts only the platform namespace, so it never sees a tenant;
 * - every client uses the chart's default `nats.<namespace>` URL, the platform-owned server.
 *
 * Throws when an override moves a host group out of the platform namespace or points it at
 * another NATS, which the platform cannot secure, or when an `extraArgs` or `env` entry would
 * override one of these settings.
 */
export function platformValues(overrides: Values, defaults: Values, namespace: string): Values {
  const result = merge(defaults, overrides);
  const operator = object(result.operator);
  result.operator = operator;
  operator.allowSharedHosts = false;
  operator.watchNamespaces = [namespace];
  operator.hostNamespaces = [namespace];
  // The chart's policies admit their ports from any source; the platform renders its own (#462).
  result.networkPolicy = { enabled: false };
  // The platform installs the scheduler NATS itself (m6b), before the release.
  result.nats = { ...object(result.nats), enabled: false };
  const global = object(result.global);
  result.global = global;
  global.tls = { ...object(global.tls), enabled: true };
  global.nats = { ...object(global.nats), schedulerUrl: '', dataUrl: '' };
  global.certificates = {
    ...object(global.certificates),
    generate: false,
    operatorCertSecretName: PLATFORM_SECRETS.operator,
    runtimeCertSecretName: PLATFORM_SECRETS.host,
    dataCertSecretName: PLATFORM_SECRETS.data,
  };
  refuseEnforced('values.operator.extraArgs', operator.extraArgs, OPERATOR_FLAGS);
  refuseEnforcedEnv('values.operator.env', operator.env, OPERATOR_ENV);
  const runtime = object(result.runtime);
  refuseEnforced('values.runtime.extraArgs', runtime.extraArgs, HOST_FLAGS);
  refuseEnforcedEnv('values.runtime.env', runtime.env, HOST_ENV);
  const groups = Array.isArray(runtime.hostGroups) ? runtime.hostGroups : [];
  for (const group of groups) {
    const { name, namespace: groupNamespace, schedulerNatsUrl, dataNatsUrl } = object(group);
    refuseEnforced(
      `values.runtime.hostGroups ${String(name)}: extraArgs`,
      object(group).extraArgs,
      HOST_FLAGS,
    );
    refuseEnforcedEnv(
      `values.runtime.hostGroups ${String(name)}: env`,
      object(group).env,
      HOST_ENV,
    );
    if (groupNamespace && groupNamespace !== namespace)
      throw new Error(
        `values.runtime.hostGroups ${String(name)}: namespace ${String(groupNamespace)} is not the platform namespace ${namespace}`,
      );
    if (schedulerNatsUrl || dataNatsUrl)
      throw new Error(
        `values.runtime.hostGroups ${String(name)}: schedulerNatsUrl and dataNatsUrl cannot be set; the platform's scheduler NATS serves every host group`,
      );
  }
  return result;
}
/**
 * The runtime-operator chart values `createPlatform` installs: the platform's defaults, then
 * `overrides` (`args.values`), then {@link platformValues}' enforced settings.
 */
export function platformHelmValues(
  namespace: string,
  overrides: Values = {},
  insecureRegistry = false,
): Values {
  return platformValues(
    overrides,
    {
      gateway: { enabled: false },
      runtime: {
        extraArgs: insecureRegistry ? ['--allow-insecure-registries'] : [],
        resources: {
          requests: { cpu: '250m', memory: '256Mi' },
          limits: { memory: '2Gi' },
          defaultHeapMemory: '512MiB',
          coreInstances: '100',
        },
        hostGroups: [
          {
            name: 'default',
            replicas: 1,
            service: { type: 'ClusterIP' },
            webgpu: { enabled: false },
            http: { enabled: true, port: 9191 },
          },
        ],
      },
    },
    namespace,
  );
}
function merge(base: Values, override: Values): Values {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error(`Invalid values key: ${key}`);
    const original = result[key];
    result[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      original &&
      typeof original === 'object' &&
      !Array.isArray(original)
        ? merge(original as Values, value as Values)
        : value;
  }
  return result;
}
