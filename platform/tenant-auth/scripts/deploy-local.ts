#!/usr/bin/env bun
/**
 * Deploy the tenant controller and console into a tenant's runtime namespace of a local
 * di-framework-kube cluster. This stands in for what the platform controller's tenant reconcile
 * would create. Code ships as a ConfigMap bundle, like `di-platform-controller` does.
 *
 *   bun scripts/deploy-local.ts --tenant acme --kubeconfig <admin kubeconfig> \
 *     --issuer http://<host-ip>:4180 --client-secret <secret> [--image oven/bun:1-alpine]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import {
  APPLY_ARGS,
  assertBundleSize,
  assertDigestsMatch,
  sha256,
  splitManifests,
} from './apply-helpers.ts';

const root = join(import.meta.dir, '..');
const dist = join(root, 'dist');

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) out[arg.slice(2)] = 'true';
      else {
        out[arg.slice(2)] = value;
        i++;
      }
    }
  }
  return out;
}
const args = flags(process.argv.slice(2));
const required = (name: string) => {
  const value = args[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const tenant = required('tenant');
const kubeconfig = required('kubeconfig');
const issuer = required('issuer');
const clientSecret = required('client-secret');
const clientId = args['client-id'] ?? 'tenant-auth';
const image = args.image ?? 'oven/bun:1-alpine';
const platformNamespace = args['platform-namespace'] ?? 'wasmcloud';
const consolePublicUrl = args['console-public-url'] ?? 'http://127.0.0.1:8787';
const controllerPublicUrl = args['controller-public-url'] ?? 'https://127.0.0.1:8788';
const namespace = `di-runtime-${tenant}`;
const component = 'tenant-auth';
const labels = {
  'platform.di-framework.dev/component': component,
  'platform.di-framework.dev/tenant': tenant,
};

async function run(cmd: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    stdin: input === undefined ? 'ignore' : new Response(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} failed: ${err || out}`);
  return out;
}
const kubectl = (...rest: string[]) => run(['kubectl', '--kubeconfig', kubeconfig, ...rest]);

// 1. Bundle both entrypoints for Bun.
mkdirSync(dist, { recursive: true });
const build = await Bun.build({
  entrypoints: [join(root, 'src/controller.ts'), join(root, 'src/console.ts')],
  outdir: dist,
  target: 'bun',
  minify: false,
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = (name: string) => readFileSync(join(dist, `${name}.js`), 'utf8');
// A ConfigMap change alone does not restart pods, so the pod template carries the bundle digest.
const bundleDigest = createHash('sha256')
  .update(bundle('controller'))
  .update(bundle('console'))
  .digest('hex')
  .slice(0, 16);
console.error(
  `bundled controller.js (${bundle('controller').length} bytes) and console.js (${bundle('console').length} bytes)`,
);

// 2. A private certificate for the controller: kubectl and the console pin it.
const tlsDir = join(dist, 'tls');
mkdirSync(tlsDir, { recursive: true });
const crt = join(tlsDir, 'tls.crt');
const key = join(tlsDir, 'tls.key');
if (!existsSync(crt)) {
  await run([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    key,
    '-out',
    crt,
    '-days',
    '30',
    '-subj',
    `/CN=tenant-controller.${namespace}.svc`,
    '-addext',
    `subjectAltName=DNS:tenant-controller,DNS:tenant-controller.${namespace}.svc,DNS:localhost,IP:127.0.0.1`,
  ]);
}

// 3. Facts from the cluster: which members get TokenRequest, where the API server is.
interface User {
  metadata: { name: string };
  spec: { memberships: { tenant: string }[] };
}
const users = JSON.parse(await kubectl('get', 'users.platform.di-framework.dev', '-o', 'json')) as {
  items: User[];
};
const members = users.items
  .filter((u) => u.spec.memberships.some((m) => m.tenant === tenant))
  .map((u) => u.metadata.name);
const slices = JSON.parse(
  await kubectl(
    'get',
    'endpointslices',
    '-n',
    'default',
    '-l',
    'kubernetes.io/service-name=kubernetes',
    '-o',
    'json',
  ),
) as {
  items: { endpoints: { addresses: string[] }[]; ports: { port: number }[] }[];
};
const apiServer = {
  ip: slices.items[0]?.endpoints[0]?.addresses[0],
  port: slices.items[0]?.ports[0]?.port,
};
if (!apiServer.ip || !apiServer.port) throw new Error('could not find the API server endpoint');
const issuerUrl = new URL(issuer);
const issuerPort = Number(issuerUrl.port || (issuerUrl.protocol === 'https:' ? 443 : 80));
// When the issuer hostname is not resolvable from pods (a local identity-server reached by IP), map it.
const issuerIp = args['issuer-ip'] ?? issuerUrl.hostname;
// A local identity-server on `localhost` (the one name a developer's browser can always reach, and
// one Bun always resolves to loopback) is reached from pods through a loopback sidecar instead.
// Bun's fetch sends every `*.localhost` name to loopback regardless of DNS or /etc/hosts.
const loopbackIssuer =
  ['localhost', '127.0.0.1'].includes(issuerUrl.hostname) ||
  issuerUrl.hostname.endsWith('.localhost');
// --issuer-upstream host:port forwards the loopback issuer port to an in-cluster service instead
// (for example the platform gateway, which routes `identity.<tenant>.localhost` to the identity guest).
const issuerUpstream = args['issuer-upstream'];
const sidecar = (args['issuer-ip'] || issuerUpstream) && loopbackIssuer;
const sidecarTarget = issuerUpstream ?? `${issuerIp}:${issuerPort}`;
const useHostAliases = args['issuer-ip'] && !loopbackIssuer;
console.error(
  `members: ${members.join(', ')}; api server ${apiServer.ip}:${apiServer.port}; issuer ${issuerUrl.hostname}:${issuerPort}`,
);

// 4. Manifests.
const securityContext = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
};
const resources = {
  requests: { cpu: '50m', memory: '96Mi' },
  limits: { cpu: '200m', memory: '192Mi' },
};
const deployment = (
  name: string,
  serviceAccountName: string,
  port: number,
  env: Record<string, string>,
  extraVolumes: unknown[],
  extraMounts: unknown[],
) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name, namespace, labels },
  spec: {
    replicas: 1,
    // Recreate: the tenant runtime quota leaves no headroom for a surge pod.
    strategy: { type: 'Recreate' },
    selector: { matchLabels: { app: name } },
    template: {
      metadata: {
        labels: { ...labels, app: name },
        annotations: { 'platform.di-framework.dev/bundle-digest': bundleDigest },
      },
      spec: {
        serviceAccountName,
        automountServiceAccountToken: true,
        ...(useHostAliases
          ? { hostAliases: [{ ip: issuerIp, hostnames: [issuerUrl.hostname] }] }
          : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name,
            image,
            command: ['bun', `/app/${name === 'tenant-controller' ? 'controller' : 'console'}.js`],
            env: [
              { name: 'TMPDIR', value: '/tmp' },
              ...Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
            ],
            ports: [{ containerPort: port, name: 'http' }],
            readinessProbe: {
              httpGet: {
                path: name === 'tenant-controller' ? '/-/healthz' : '/healthz',
                port,
                scheme: name === 'tenant-controller' ? 'HTTPS' : 'HTTP',
              },
              periodSeconds: 5,
            },
            resources,
            securityContext,
            volumeMounts: [
              { name: 'bundle', mountPath: '/app', readOnly: true },
              { name: 'tmp', mountPath: '/tmp' },
              ...extraMounts,
            ],
          },
          ...(sidecar
            ? [
                {
                  name: 'issuer-proxy',
                  image: 'alpine/socat:1.8.0.0',
                  args: [
                    `TCP-LISTEN:${issuerPort},fork,reuseaddr,bind=127.0.0.1`,
                    `TCP:${sidecarTarget}`,
                  ],
                  resources: {
                    requests: { cpu: '10m', memory: '16Mi' },
                    limits: { cpu: '50m', memory: '32Mi' },
                  },
                  securityContext,
                },
              ]
            : []),
        ],
        volumes: [
          { name: 'bundle', configMap: { name: 'tenant-auth-bundle' } },
          { name: 'tmp', emptyDir: {} },
          ...extraVolumes,
        ],
      },
    },
  },
});
const service = (name: string, port: number) => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name, namespace, labels },
  spec: { selector: { app: name }, ports: [{ port, targetPort: port, name: 'http' }] },
});

const manifests: unknown[] = [
  {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'tenant-controller', namespace, labels },
    automountServiceAccountToken: false,
  },
  {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: { name: 'tenant-console', namespace, labels },
    automountServiceAccountToken: false,
  },
  // Read the tenancy CRs it checks on every request.
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: `di-tenant-controller-${tenant}`, labels },
    rules: [
      {
        apiGroups: ['platform.di-framework.dev'],
        resources: ['tenants'],
        verbs: ['get'],
        resourceNames: [tenant],
      },
      { apiGroups: ['platform.di-framework.dev'], resources: ['users'], verbs: ['get', 'list'] },
    ],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRoleBinding',
    metadata: { name: `di-tenant-controller-${tenant}`, labels },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: `di-tenant-controller-${tenant}`,
    },
    subjects: [{ kind: 'ServiceAccount', name: 'tenant-controller', namespace }],
  },
  // Mint tokens only for this tenant's members (the platform controller would keep this list current).
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: `di-tenant-controller-${tenant}`, namespace: platformNamespace, labels },
    rules: [
      {
        apiGroups: [''],
        resources: ['serviceaccounts/token'],
        verbs: ['create'],
        resourceNames: members.map((m) => `di-user-${m}`),
      },
    ],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: `di-tenant-controller-${tenant}`, namespace: platformNamespace, labels },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: `di-tenant-controller-${tenant}`,
    },
    subjects: [{ kind: 'ServiceAccount', name: 'tenant-controller', namespace }],
  },
  // API-key Secrets in its own namespace.
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: { name: 'tenant-controller-keys', namespace, labels },
    rules: [
      { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'list', 'create', 'delete'] },
    ],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: { name: 'tenant-controller-keys', namespace, labels },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'Role',
      name: 'tenant-controller-keys',
    },
    subjects: [{ kind: 'ServiceAccount', name: 'tenant-controller', namespace }],
  },
  // The tenant egress policy allows only tenant namespaces, DNS, and public :443; add the API server and the issuer.
  {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'tenant-auth-egress', namespace, labels },
    spec: {
      podSelector: { matchLabels: { 'platform.di-framework.dev/component': component } },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{ ipBlock: { cidr: `${apiServer.ip}/32` } }],
          ports: [{ port: apiServer.port, protocol: 'TCP' }],
        },
        ...(issuerUpstream
          ? [
              {
                to: [
                  {
                    namespaceSelector: {
                      matchLabels: {
                        'kubernetes.io/metadata.name':
                          issuerUpstream.split('.')[1] ?? platformNamespace,
                      },
                    },
                  },
                ],
                // NetworkPolicy matches the pod port after DNAT, so allow the gateway's container port too.
                ports: [
                  { port: Number(issuerUpstream.split(':')[1] ?? 80), protocol: 'TCP' },
                  { port: 8080, protocol: 'TCP' },
                ],
              },
            ]
          : [
              {
                to: [{ ipBlock: { cidr: `${issuerIp}/32` } }],
                ports: [{ port: issuerPort, protocol: 'TCP' }],
              },
            ]),
        {
          to: [
            { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } },
          ],
        },
        {
          to: [
            {
              namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            },
          ],
          ports: [
            { port: 53, protocol: 'UDP' },
            { port: 53, protocol: 'TCP' },
          ],
        },
      ],
    },
  },
  {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'tenant-auth-bundle', namespace, labels },
    data: { 'controller.js': bundle('controller'), 'console.js': bundle('console') },
  },
  {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'tenant-controller-ca', namespace, labels },
    data: { 'ca.crt': readFileSync(crt, 'utf8') },
  },
  {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'tenant-controller-tls', namespace, labels },
    type: 'kubernetes.io/tls',
    stringData: { 'tls.crt': readFileSync(crt, 'utf8'), 'tls.key': readFileSync(key, 'utf8') },
  },
  {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'tenant-console-oauth', namespace, labels },
    type: 'Opaque',
    stringData: { clientSecret },
  },
  deployment(
    'tenant-controller',
    'tenant-controller',
    8788,
    {
      TENANT_CONTROLLER_TENANT: tenant,
      TENANT_CONTROLLER_PLATFORM_NAMESPACE: platformNamespace,
      TENANT_CONTROLLER_ISSUER: issuer,
      TENANT_CONTROLLER_HOST: '0.0.0.0',
      TENANT_CONTROLLER_PORT: '8788',
      TENANT_CONTROLLER_TLS_CERT: '/tls/tls.crt',
      TENANT_CONTROLLER_TLS_KEY: '/tls/tls.key',
    },
    [{ name: 'tls', secret: { secretName: 'tenant-controller-tls' } }],
    [{ name: 'tls', mountPath: '/tls', readOnly: true }],
  ),
  {
    ...deployment(
      'tenant-console',
      'tenant-console',
      8787,
      {
        TENANT_CONSOLE_TENANT: tenant,
        TENANT_CONSOLE_ISSUER: issuer,
        TENANT_CONSOLE_CLIENT_ID: clientId,
        TENANT_CONSOLE_HOST: '0.0.0.0',
        TENANT_CONSOLE_PORT: '8787',
        TENANT_CONSOLE_PUBLIC_URL: consolePublicUrl,
        TENANT_CONSOLE_CONTROLLER_URL: 'https://tenant-controller:8788',
        TENANT_CONSOLE_CONTROLLER_PUBLIC_URL: controllerPublicUrl,
        TENANT_CONSOLE_CONTROLLER_CA: '/ca/ca.crt',
      },
      [{ name: 'ca', configMap: { name: 'tenant-controller-ca' } }],
      [{ name: 'ca', mountPath: '/ca', readOnly: true }],
    ),
  },
  service('tenant-controller', 8788),
  service('tenant-console', 8787),
];
// The console's client secret comes from the Secret, not a literal in the Deployment.
const consoleDeployment = manifests.find(
  (m) =>
    (m as { kind: string; metadata: { name: string } }).kind === 'Deployment' &&
    (m as { metadata: { name: string } }).metadata.name === 'tenant-console',
) as {
  spec: { template: { spec: { containers: { env: unknown[] }[] } } };
};
consoleDeployment.spec.template.spec.containers[0]?.env.push({
  name: 'TENANT_CONSOLE_CLIENT_SECRET',
  valueFrom: { secretKeyRef: { name: 'tenant-console-oauth', key: 'clientSecret' } },
});

assertBundleSize({ 'controller.js': bundle('controller'), 'console.js': bundle('console') });
const toYaml = (items: unknown[]) => items.map((m) => dump(m, { lineWidth: -1 })).join('---\n');
writeFileSync(join(dist, 'tenant-auth.yaml'), toYaml(manifests));
// Config objects first: a failed bundle update throws (run() rejects on non-zero exit) before any
// Deployment is applied, so the pods are never recycled onto a stale bundle.
const { config, workloads } = splitManifests(manifests as { kind?: string }[]);
for (const part of [config, workloads]) {
  console.error(
    (await run(['kubectl', '--kubeconfig', kubeconfig, ...APPLY_ARGS], toYaml(part))).trim(),
  );
}
console.error(
  await kubectl(
    '-n',
    namespace,
    'rollout',
    'status',
    'deployment/tenant-controller',
    '--timeout=180s',
  ),
);
console.error(
  await kubectl(
    '-n',
    namespace,
    'rollout',
    'status',
    'deployment/tenant-console',
    '--timeout=180s',
  ),
);
const liveBundle = await kubectl(
  '-n',
  namespace,
  'get',
  'configmap',
  'tenant-auth-bundle',
  '-o',
  'jsonpath={.data.controller\\.js}',
);
const builtDigest = sha256(bundle('controller'));
const liveDigest = sha256(liveBundle);
console.error(`controller.js sha256 built=${builtDigest} in-cluster=${liveDigest}`);
assertDigestsMatch(builtDigest, liveDigest);
console.log(`Deployed. Reach them from this machine with:
  kubectl --kubeconfig '${kubeconfig}' -n ${namespace} port-forward svc/tenant-controller 8788:8788
  kubectl --kubeconfig '${kubeconfig}' -n ${namespace} port-forward svc/tenant-console 8787:8787
Controller CA: ${crt}`);
