import type { CloudFoundryServiceInfoCreator } from '../spi/creator';
import type { RawVcapServiceData, RedisServiceInfo } from '../types';

const REDIS_PATTERNS = ['redis', 'rediscloud', 'redislabs'];

function matchesAny(str: string, patterns: readonly string[]): boolean {
  const lower = str.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

export class RedisServiceInfoCreator implements CloudFoundryServiceInfoCreator<RedisServiceInfo> {
  accept(serviceData: RawVcapServiceData): boolean {
    const label = serviceData.label || '';
    const tags = (serviceData.tags || []).map((t) => String(t).toLowerCase());
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;

    if (matchesAny(label, REDIS_PATTERNS)) {
      return true;
    }

    if (tags.some((t) => matchesAny(t, REDIS_PATTERNS) || t === 'cache')) {
      return true;
    }

    const uriCandidate = String(creds.uri ?? creds.url ?? '');
    if (uriCandidate.startsWith('redis://') || uriCandidate.startsWith('rediss://')) {
      return true;
    }

    return false;
  }

  createServiceInfo(serviceData: RawVcapServiceData): RedisServiceInfo {
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;
    const tags = (serviceData.tags || []).map(String);

    let rawUri = String(creds.uri ?? creds.url ?? '');
    let host = String(creds.host ?? creds.hostname ?? 'localhost');
    let port = typeof creds.port === 'number' ? creds.port : 6379;
    if (typeof creds.port === 'string' && creds.port.trim().length > 0) {
      const p = parseInt(creds.port, 10);
      if (!Number.isNaN(p)) port = p;
    }

    let password = creds.password ? String(creds.password) : undefined;
    let database: number | undefined;
    if (typeof creds.database === 'number') {
      database = creds.database;
    } else if (typeof creds.db === 'number') {
      database = creds.db;
    }

    let tls =
      typeof creds.tls === 'boolean'
        ? creds.tls
        : typeof creds.ssl === 'boolean'
          ? creds.ssl
          : undefined;

    const cluster = typeof creds.cluster === 'boolean' ? creds.cluster : undefined;

    if (rawUri.length > 0) {
      try {
        const parsed = new URL(rawUri);
        if (parsed.protocol === 'rediss:') {
          tls = true;
        } else if (parsed.protocol === 'redis:' && tls === undefined) {
          tls = false;
        }

        if (parsed.hostname) host = parsed.hostname;
        if (parsed.port) port = parseInt(parsed.port, 10);
        if (parsed.password) password = decodeURIComponent(parsed.password);
        if (parsed.pathname && parsed.pathname.length > 1) {
          const dbIndex = parseInt(parsed.pathname.slice(1), 10);
          if (!Number.isNaN(dbIndex)) database = dbIndex;
        }
      } catch {
        // ignore url parse error
      }
    }

    if (!rawUri) {
      const scheme = tls ? 'rediss' : 'redis';
      const auth = password ? `:${encodeURIComponent(password)}@` : '';
      const dbPath = database !== undefined ? `/${database}` : '';
      rawUri = `${scheme}://${auth}${host}:${port}${dbPath}`;
    }

    return {
      id: serviceData.name,
      name: serviceData.name,
      label: serviceData.label,
      ...(serviceData.plan ? { plan: serviceData.plan } : {}),
      tags,
      credentials: Object.freeze({ ...creds }),
      host,
      port,
      ...(password !== undefined ? { password } : {}),
      ...(database !== undefined ? { database } : {}),
      uri: rawUri,
      ...(tls !== undefined ? { tls } : {}),
      ...(cluster !== undefined ? { cluster } : {}),
    };
  }
}
