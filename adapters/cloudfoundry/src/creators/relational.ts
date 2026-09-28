import type { CloudFoundryServiceInfoCreator } from '../spi/creator';
import type { RawVcapServiceData, RelationalDialect, RelationalServiceInfo } from '../types';

const POSTGRES_PATTERNS = ['postgres', 'postgresql', 'elephantsql', 'crunchy'];
const MYSQL_PATTERNS = ['mysql', 'cleardb', 'mariadb'];
const SQLITE_PATTERNS = ['sqlite', 'sqlite3'];

function matchesAny(str: string, patterns: readonly string[]): boolean {
  const lower = str.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function detectDialectFromScheme(scheme: string): RelationalDialect | null {
  const s = scheme.toLowerCase().replace(':', '');
  if (s === 'postgres' || s === 'postgresql') return 'postgres';
  if (s === 'mysql') return 'mysql';
  if (s === 'mariadb') return 'mariadb';
  if (s === 'sqlite' || s === 'sqlite3') return 'sqlite';
  return null;
}

export class RelationalServiceInfoCreator
  implements CloudFoundryServiceInfoCreator<RelationalServiceInfo>
{
  accept(serviceData: RawVcapServiceData): boolean {
    const label = serviceData.label || '';
    const tags = (serviceData.tags || []).map((t) => String(t).toLowerCase());
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;

    // 1. Label match
    if (
      matchesAny(label, POSTGRES_PATTERNS) ||
      matchesAny(label, MYSQL_PATTERNS) ||
      matchesAny(label, SQLITE_PATTERNS)
    ) {
      return true;
    }

    // 2. Tag match
    if (
      tags.some(
        (t) =>
          POSTGRES_PATTERNS.some((p) => t.includes(p)) ||
          MYSQL_PATTERNS.some((p) => t.includes(p)) ||
          SQLITE_PATTERNS.some((p) => t.includes(p)) ||
          t === 'relational' ||
          t === 'rdbms',
      )
    ) {
      return true;
    }

    // 3. Credentials URI / JDBC / scheme inspection
    const uriCandidate = String(creds.uri ?? creds.url ?? creds.jdbcUrl ?? '');
    if (uriCandidate.startsWith('postgres://') || uriCandidate.startsWith('postgresql://')) {
      return true;
    }
    if (uriCandidate.startsWith('mysql://') || uriCandidate.startsWith('mariadb://')) {
      return true;
    }
    if (uriCandidate.startsWith('sqlite://') || uriCandidate.startsWith('sqlite:')) {
      return true;
    }
    if (uriCandidate.startsWith('jdbc:postgresql:') || uriCandidate.startsWith('jdbc:mysql:')) {
      return true;
    }

    return false;
  }

  createServiceInfo(serviceData: RawVcapServiceData): RelationalServiceInfo {
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;
    const tags = (serviceData.tags || []).map(String);
    const label = serviceData.label || '';

    let rawUri = String(creds.uri ?? creds.url ?? '');
    const jdbcUrlCandidate = creds.jdbcUrl ? String(creds.jdbcUrl) : undefined;

    let dialect: RelationalDialect = 'postgres';
    if (matchesAny(label, SQLITE_PATTERNS) || tags.some((t) => matchesAny(t, SQLITE_PATTERNS))) {
      dialect = 'sqlite';
    } else if (
      matchesAny(label, MYSQL_PATTERNS) ||
      tags.some((t) => matchesAny(t, MYSQL_PATTERNS))
    ) {
      dialect = matchesAny(label, ['mariadb']) || tags.includes('mariadb') ? 'mariadb' : 'mysql';
    }

    let host = String(creds.host ?? creds.hostname ?? 'localhost');
    let port = typeof creds.port === 'number' ? creds.port : 5432;
    if (typeof creds.port === 'string' && creds.port.trim().length > 0) {
      const p = parseInt(creds.port, 10);
      if (!Number.isNaN(p)) port = p;
    }

    let database = String(creationalDbName(creds));
    let username =
      (creds.username ?? creds.user) ? String(creds.username ?? creds.user) : undefined;
    let password =
      (creds.password ?? creds.pass) ? String(creds.password ?? creds.pass) : undefined;
    let ssl = typeof creds.ssl === 'boolean' ? creds.ssl : undefined;

    if (rawUri.startsWith('jdbc:')) {
      // e.g. jdbc:postgresql://host:port/database
      const normalized = rawUri.replace(/^jdbc:/, '');
      try {
        const parsed = new URL(normalized);
        const schemeDialect = detectDialectFromScheme(parsed.protocol);
        if (schemeDialect) dialect = schemeDialect;
        if (parsed.hostname) host = parsed.hostname;
        if (parsed.port) port = parseInt(parsed.port, 10);
        if (parsed.pathname && parsed.pathname.length > 1) {
          database = decodeURIComponent(parsed.pathname.slice(1));
        }
        if (parsed.username) username = decodeURIComponent(parsed.username);
        if (parsed.password) password = decodeURIComponent(parsed.password);
        if (parsed.searchParams.has('ssl') || parsed.searchParams.has('sslmode')) {
          ssl =
            parsed.searchParams.get('ssl') === 'true' ||
            parsed.searchParams.get('sslmode') === 'require';
        }
      } catch {
        // preserve original
      }
    } else if (rawUri.length > 0) {
      try {
        const parsed = new URL(rawUri);
        const schemeDialect = detectDialectFromScheme(parsed.protocol);
        if (schemeDialect) dialect = schemeDialect;
        if (parsed.hostname) host = parsed.hostname;
        if (parsed.port) port = parseInt(parsed.port, 10);
        if (parsed.pathname && parsed.pathname.length > 1) {
          database = decodeURIComponent(parsed.pathname.slice(1));
        }
        if (parsed.username) username = decodeURIComponent(parsed.username);
        if (parsed.password) password = decodeURIComponent(parsed.password);
        if (parsed.searchParams.has('ssl') || parsed.searchParams.has('sslmode')) {
          ssl =
            parsed.searchParams.get('ssl') === 'true' ||
            parsed.searchParams.get('sslmode') === 'require';
        }
      } catch {
        // ignore url parse error
      }
    }

    if (!rawUri || rawUri.startsWith('jdbc:')) {
      const scheme = dialect === 'postgres' ? 'postgres' : dialect;
      const auth = username ? (password ? `${username}:${password}@` : `${username}@`) : '';
      rawUri = `${scheme}://${auth}${host}:${port}/${database}`;
    }

    const defaultPorts: Record<RelationalDialect, number> = {
      postgres: 5432,
      mysql: 3306,
      mariadb: 3306,
      sqlite: 0,
    };
    if (!port || (port === 5432 && dialect === 'mysql')) {
      port = defaultPorts[dialect];
    }

    const jdbcUrl =
      jdbcUrlCandidate ??
      `jdbc:${dialect === 'postgres' ? 'postgresql' : dialect}://${host}:${port}/${database}`;

    return {
      id: serviceData.name,
      name: serviceData.name,
      label: serviceData.label,
      ...(serviceData.plan ? { plan: serviceData.plan } : {}),
      tags,
      credentials: Object.freeze({ ...creds }),
      dialect,
      host,
      port,
      database,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      uri: rawUri,
      jdbcUrl,
      ...(ssl !== undefined ? { ssl } : {}),
    };
  }
}

function creationalDbName(creds: Record<string, unknown>): string {
  if (creds.database) return String(creds.database);
  if (creds.name) return String(creds.name);
  if (creds.db) return String(creds.db);
  return 'defaultdb';
}
