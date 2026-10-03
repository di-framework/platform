import { lookup } from 'node:dns/promises';
import type { BackingService, Resource, ServiceBinding } from './resources';
import type { WorkloadDeployment } from './workload-storage';

/**
 * Platform-approved outbound network access for tenant workloads (#13).
 *
 * A BackingServiceClass of type `egress` lists `host:port` / `*.suffix:port` policy entries.
 * A tenant BackingService of type `egress` asks for destinations; the controller approves
 * the ones the class covers. A Ready egress ServiceBinding grants the approved entries to
 * one WorkloadDeployment, which the controller patches under its own field manager.
 *
 * What wash 2.8 checks with `--socket-egress=enforce`:
 * - `wasi:sockets` ip-name-lookup: the name must match `allowedIpNameLookups`.
 * - `wasi:sockets` TCP connect: the destination is an address, so only `*` or a literal
 *   `ip:port` entry in `allowedHosts` permits it. Name and `*.suffix` entries never do.
 * - `wasi:http`: the request URI is matched against `allowedHosts`. `host:443` matches only
 *   a URI that spells the port; `https://host` matches the usual portless URI.
 * So each approved name gets its `host:port` entry, a scheme entry for 80/443, and the
 * public IPv4 addresses the controller resolved for it.
 */

export const EGRESS_FIELD_MANAGER = 'di-platform-egress';
export const EGRESS_NETWORK_POLICY = 'di-tenant-egress';
/** Never reachable through tenant egress, matching the public 443 rule. */
export const PRIVATE_IPV4_RANGES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '127.0.0.0/8',
] as const;

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const NAME = `(\\*\\.)?${LABEL}(\\.${LABEL})*`;
const PORT =
  '([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';
/** Class policy entry: `host:port` or `*.suffix:port`. The port is required. */
export const EGRESS_POLICY_PATTERN = `^${NAME}:${PORT}$`;
/** Requested destination: `host`, `*.suffix`, `host:port` or `*.suffix:port`. */
export const EGRESS_DESTINATION_PATTERN = `^${NAME}(:${PORT})?$`;
/** Longest DNS name plus `:65535`. */
export const EGRESS_ENTRY_MAX_LENGTH = 259;

interface Entry {
  name: string;
  port?: number;
}

function parseEntry(value: unknown, pattern: string): Entry | undefined {
  if (typeof value !== 'string' || value.length > EGRESS_ENTRY_MAX_LENGTH) return undefined;
  if (!new RegExp(pattern).test(value)) return undefined;
  const [name, port] = value.split(':') as [string, string | undefined];
  return port === undefined ? { name } : { name, port: Number(port) };
}

export function validEgressPolicyEntry(value: unknown): boolean {
  return parseEntry(value, EGRESS_POLICY_PATTERN) !== undefined;
}

export function validEgressDestination(value: unknown): boolean {
  return parseEntry(value, EGRESS_DESTINATION_PATTERN) !== undefined;
}

/** Whether a policy name (`host` or `*.suffix`) covers a requested name. */
export function egressNameCovers(policy: string, name: string): boolean {
  if (!policy.startsWith('*.')) return policy === name;
  const suffix = policy.slice(1);
  const requested = name.startsWith('*.') ? name.slice(1) : name;
  if (name.startsWith('*.')) return requested === suffix || requested.endsWith(suffix);
  return requested.length > suffix.length && requested.endsWith(suffix);
}

/**
 * Resolve requested destinations against a class policy. A destination without a port is
 * approved for every policy port that covers its name. `denied` keeps the request order.
 */
export function approveEgress(
  destinations: string[],
  allowedDestinations: string[],
): { approved: string[]; denied: string[] } {
  const policy = allowedDestinations
    .map((value) => parseEntry(value, EGRESS_POLICY_PATTERN))
    .filter((entry): entry is Entry => entry !== undefined);
  const approved = new Set<string>();
  const denied: string[] = [];
  for (const destination of destinations) {
    const requested = parseEntry(destination, EGRESS_DESTINATION_PATTERN);
    const ports = requested
      ? policy
          .filter(
            (entry) =>
              egressNameCovers(entry.name, requested.name) &&
              (requested.port === undefined || requested.port === entry.port),
          )
          .map((entry) => entry.port)
      : [];
    if (!requested || ports.length === 0) denied.push(destination);
    else for (const port of ports) approved.add(`${requested.name}:${port}`);
  }
  return { approved: [...approved].sort(), denied };
}

function splitApproved(entry: string): { name: string; port: number } {
  const [name, port] = entry.split(':') as [string, string];
  return { name, port: Number(port) };
}

export function egressPorts(approved: string[]): number[] {
  return [...new Set(approved.map((entry) => splitApproved(entry).port))].sort((a, b) => a - b);
}

/** Names the guest may resolve: every approved name, wildcards included. */
export function egressLookups(approved: string[]): string[] {
  return [...new Set(approved.map((entry) => splitApproved(entry).name))].sort();
}

/** Exact names whose addresses the controller resolves for socket connects. */
export function egressResolvableNames(approved: string[]): string[] {
  return egressLookups(approved).filter((name) => !name.startsWith('*.'));
}

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part)))
    return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return undefined;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

export function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === undefined) return false;
  return PRIVATE_IPV4_RANGES.every((range) => {
    const [base, bits] = range.split('/') as [string, string];
    const size = 2 ** (32 - Number(bits));
    const start = ipv4ToNumber(base) as number;
    return value < start || value >= start + size;
  });
}

/**
 * `allowedHosts` for approved `host:port` entries. `addresses` maps an exact name to the
 * IPv4 addresses the controller resolved; only public ones are granted.
 */
export function egressAllowedHosts(
  approved: string[],
  addresses: ReadonlyMap<string, string[]>,
): string[] {
  const hosts = new Set<string>();
  for (const entry of approved) {
    const { name, port } = splitApproved(entry);
    hosts.add(entry);
    if (port === 443) hosts.add(`https://${name}`);
    if (port === 80) hosts.add(`http://${name}`);
    for (const address of addresses.get(name) ?? [])
      if (isPublicIpv4(address)) hosts.add(`${address}:${port}`);
  }
  return [...hosts].sort();
}

/** Public IPv4 addresses for a name, sorted so an unchanged answer patches nothing. */
export async function resolveIpv4(name: string): Promise<string[]> {
  const found = await lookup(name, { all: true, family: 4 });
  return [...new Set(found.map((entry) => entry.address))].filter(isPublicIpv4).sort();
}

function ready(conditions: { type: string; status: string }[] | undefined): boolean {
  return !!conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
}

/** Approved entries per WorkloadDeployment name, from Ready egress bindings only. */
export function egressGrants(
  namespace: string,
  bindings: ServiceBinding[],
  services: ReadonlyMap<string, BackingService>,
): Map<string, string[]> {
  const grants = new Map<string, Set<string>>();
  for (const binding of bindings) {
    const workload = binding.spec.workloadName;
    if (
      binding.metadata.namespace !== namespace ||
      binding.spec.capability !== 'egress' ||
      binding.metadata.deletionTimestamp ||
      !workload ||
      !ready(binding.status?.conditions)
    )
      continue;
    const service = services.get(`${namespace}/${binding.spec.serviceName}`);
    if (service?.spec.type !== 'egress' || !ready(service.status?.conditions)) continue;
    const entries = grants.get(workload) ?? new Set<string>();
    for (const entry of service.status?.approved ?? []) entries.add(entry);
    grants.set(workload, entries);
  }
  return new Map([...grants].map(([name, entries]) => [name, [...entries].sort()]));
}

function same(current: unknown, desired: string[]): boolean {
  return JSON.stringify(current ?? []) === JSON.stringify(desired);
}

/**
 * The egress fields the controller owns on a WorkloadDeployment, or undefined when the
 * workload already carries exactly those. Empty grants remove the fields.
 */
export function egressPatch(
  workload: WorkloadDeployment,
  allowedHosts: string[],
  allowedIpNameLookups: string[],
): Resource | undefined {
  const template = workload.spec?.template?.spec;
  if (!template) return undefined;
  const current = (local: Record<string, unknown> | undefined) =>
    same(local?.allowedHosts, allowedHosts) &&
    same(local?.allowedIpNameLookups, allowedIpNameLookups);
  const components = template.components ?? [];
  const componentsChanged = components.some((component) => !current(component.localResources));
  const service = template.service;
  const serviceChanged = !!service && !current(service.localResources);
  if (!componentsChanged && !serviceChanged) return undefined;
  const spec: Record<string, unknown> = {};
  if (componentsChanged)
    spec.components = components.map((component) => {
      const {
        allowedHosts: _hosts,
        allowedIpNameLookups: _lookups,
        ...rest
      } = component.localResources ?? {};
      return {
        ...component,
        localResources: {
          ...rest,
          ...(allowedHosts.length ? { allowedHosts } : {}),
          ...(allowedIpNameLookups.length ? { allowedIpNameLookups } : {}),
        },
      };
    });
  // A merge patch removes an object field only through an explicit null.
  if (serviceChanged)
    spec.service = {
      localResources: {
        allowedHosts: allowedHosts.length ? allowedHosts : null,
        allowedIpNameLookups: allowedIpNameLookups.length ? allowedIpNameLookups : null,
      },
    };
  return {
    apiVersion: 'runtime.wasmcloud.dev/v1alpha1',
    kind: 'WorkloadDeployment',
    metadata: {
      name: workload.metadata.name,
      namespace: workload.metadata.namespace,
      resourceVersion: workload.metadata.resourceVersion,
    },
    spec: { template: { spec } },
  };
}

/** Tenant hosts may reach public addresses on the approved ports. */
export function egressNetworkPolicySpec(hostgroup: string, ports: number[]) {
  return {
    podSelector: {
      matchLabels: { 'wasmcloud.com/hostgroup': hostgroup, 'wasmcloud.com/name': 'hostgroup' },
    },
    policyTypes: ['Egress'],
    egress: [
      {
        to: [{ ipBlock: { cidr: '0.0.0.0/0', except: [...PRIVATE_IPV4_RANGES] } }],
        ports: ports.map((port) => ({ protocol: 'TCP', port })),
      },
    ],
  };
}
