import type { CloudFoundryServiceInfoCreator } from '../spi/creator';
import type { AmqpServiceInfo, RawVcapServiceData } from '../types';

const AMQP_PATTERNS = ['rabbitmq', 'amqp', 'cloudamqp'];

function matchesAny(str: string, patterns: readonly string[]): boolean {
  const lower = str.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

export class AmqpServiceInfoCreator implements CloudFoundryServiceInfoCreator<AmqpServiceInfo> {
  accept(serviceData: RawVcapServiceData): boolean {
    const label = serviceData.label || '';
    const tags = (serviceData.tags || []).map((t) => String(t).toLowerCase());
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;

    if (matchesAny(label, AMQP_PATTERNS)) {
      return true;
    }

    if (
      tags.some((t) => matchesAny(t, AMQP_PATTERNS) || t === 'messaging' || t === 'message-queue')
    ) {
      return true;
    }

    const uriCandidate = String(creds.uri ?? creds.url ?? '');
    if (uriCandidate.startsWith('amqp://') || uriCandidate.startsWith('amqps://')) {
      return true;
    }

    const urisArray = creds.uris;
    if (
      Array.isArray(urisArray) &&
      urisArray.some(
        (u) => typeof u === 'string' && (u.startsWith('amqp://') || u.startsWith('amqps://')),
      )
    ) {
      return true;
    }

    return false;
  }

  createServiceInfo(serviceData: RawVcapServiceData): AmqpServiceInfo {
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;
    const tags = (serviceData.tags || []).map(String);

    const rawUris = Array.isArray(creds.uris)
      ? creds.uris.map(String)
      : typeof creds.uri === 'string'
        ? [creds.uri]
        : typeof creds.url === 'string'
          ? [creds.url]
          : [];

    let primaryUri = rawUris[0] ?? '';
    let host = String(creds.hostname ?? creds.host ?? 'localhost');
    let port = typeof creds.port === 'number' ? creds.port : 5672;
    if (typeof creds.port === 'string' && creds.port.trim().length > 0) {
      const p = parseInt(creds.port, 10);
      if (!Number.isNaN(p)) port = p;
    }

    let username =
      (creds.username ?? creds.user) ? String(creds.username ?? creds.user) : undefined;
    let password =
      (creds.password ?? creds.pass) ? String(creds.password ?? creds.pass) : undefined;
    let virtualHost =
      (creds.vhost ?? creds.virtual_host ?? creds.virtualHost)
        ? String(creds.vhost ?? creds.virtual_host ?? creds.virtualHost)
        : undefined;

    let ssl =
      typeof creds.ssl === 'boolean'
        ? creds.ssl
        : typeof creds.tls === 'boolean'
          ? creds.tls
          : undefined;

    const httpManagementUri =
      (creds.http_api_uri ?? creds.http_management_uri ?? creds.httpManagementUri)
        ? String(creds.http_api_uri ?? creds.http_management_uri ?? creds.httpManagementUri)
        : undefined;

    if (primaryUri.length > 0) {
      try {
        const parsed = new URL(primaryUri);
        if (parsed.protocol === 'amqps:') {
          ssl = true;
        } else if (parsed.protocol === 'amqp:' && ssl === undefined) {
          ssl = false;
        }

        if (parsed.hostname) host = parsed.hostname;
        if (parsed.port) port = parseInt(parsed.port, 10);
        if (parsed.username) username = decodeURIComponent(parsed.username);
        if (parsed.password) password = decodeURIComponent(parsed.password);
        if (parsed.pathname && parsed.pathname.length > 1) {
          virtualHost = decodeURIComponent(parsed.pathname.slice(1));
        }
      } catch {
        // ignore parse error
      }
    }

    if (!primaryUri) {
      const scheme = ssl ? 'amqps' : 'amqp';
      const auth = username ? (password ? `${username}:${password}@` : `${username}@`) : '';
      const vhostPart = virtualHost ? `/${encodeURIComponent(virtualHost)}` : '';
      primaryUri = `${scheme}://${auth}${host}:${port}${vhostPart}`;
    }

    const urisList = rawUris.length > 0 ? rawUris : [primaryUri];

    return {
      id: serviceData.name,
      name: serviceData.name,
      label: serviceData.label,
      ...(serviceData.plan ? { plan: serviceData.plan } : {}),
      tags,
      credentials: Object.freeze({ ...creds }),
      host,
      port,
      ...(virtualHost !== undefined ? { virtualHost } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      uri: primaryUri,
      uris: urisList,
      ...(ssl !== undefined ? { ssl } : {}),
      ...(httpManagementUri !== undefined ? { httpManagementUri } : {}),
    };
  }
}
