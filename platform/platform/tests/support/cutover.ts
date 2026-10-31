import {
  COMPONENT,
  INSTALLATION,
  names,
  OWNER,
  type Resource,
  TENANT,
  TENANT_HOST_SECRET,
} from '../../src/tenancy/resources';
import { SCHEDULER_IDENTITY_COMPONENT } from '../../src/tenancy/scheduler-identities';
import {
  operatorNamespace,
  TENANT_OPERATOR_COMPONENT,
  TENANT_OPERATOR_NAME,
} from '../../src/tenancy/tenant-operator-names';

/** The certificate PEM of {@link cutoverSeeds}' host Secret, whose digest the hosts carry. */
export const HOST_CERT = '-----BEGIN CERTIFICATE-----\nhost\n-----END CERTIFICATE-----\n';

/** The `kubernetes` EndpointSlice the tenant operator's egress policy is rendered from. */
export const API_SERVER_SLICE: Resource = {
  apiVersion: 'discovery.k8s.io/v1',
  kind: 'EndpointSlice',
  metadata: {
    name: 'kubernetes',
    namespace: 'default',
    labels: { 'kubernetes.io/service-name': 'kubernetes' },
  },
  endpoints: [{ addresses: ['10.0.0.1'] }],
  ports: [{ port: 6443 }],
};

/**
 * What a tenant that has gone through the scheduler cut-over (#541 m6e) has besides its own
 * objects, so the controller renders its host group: the API server's EndpointSlice, the hosts'
 * identity Secret the controller issued, and the tenant operator's Deployment, which then exists
 * and is applied (and, in the in-memory APIs, reported Ready) on every pass.
 */
export function cutoverSeeds(
  tenant: { metadata: { name: string; uid?: string } },
  installation: string,
): Resource[] {
  const t = tenant.metadata.name;
  const owned = (component: string) => ({
    [INSTALLATION]: installation,
    [OWNER]: tenant.metadata.uid ?? '',
    [TENANT]: t,
    [COMPONENT]: component,
  });
  return [
    API_SERVER_SLICE,
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: TENANT_HOST_SECRET,
        namespace: names(t).runtimeNamespace,
        labels: owned(SCHEDULER_IDENTITY_COMPONENT),
      },
      type: 'kubernetes.io/tls',
      data: { 'tls.crt': Buffer.from(HOST_CERT).toString('base64') },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: TENANT_OPERATOR_NAME,
        namespace: operatorNamespace(t),
        labels: owned(TENANT_OPERATOR_COMPONENT),
      },
      spec: { replicas: 1 },
    },
  ];
}
