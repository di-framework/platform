import type { CloudFoundryServiceInfoCreator } from '../spi/creator';
import type { RawVcapServiceData, UserProvidedServiceInfo } from '../types';

export class UserProvidedServiceInfoCreator
  implements CloudFoundryServiceInfoCreator<UserProvidedServiceInfo>
{
  accept(serviceData: RawVcapServiceData): boolean {
    const label = (serviceData.label || '').toLowerCase();
    return label === 'user-provided' || label.length === 0 || !label;
  }

  createServiceInfo(serviceData: RawVcapServiceData): UserProvidedServiceInfo {
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;
    const tags = (serviceData.tags || []).map(String);

    const uri = (creds.uri ?? creds.url) ? String(creds.uri ?? creds.url) : undefined;
    const host = (creds.host ?? creds.hostname) ? String(creds.host ?? creds.hostname) : undefined;

    let port: number | undefined;
    if (typeof creds.port === 'number') {
      port = creds.port;
    } else if (typeof creds.port === 'string' && creds.port.trim().length > 0) {
      const p = parseInt(creds.port, 10);
      if (!Number.isNaN(p)) port = p;
    }

    const username =
      (creds.username ?? creds.user) ? String(creds.username ?? creds.user) : undefined;
    const password =
      (creds.password ?? creds.pass) ? String(creds.password ?? creds.pass) : undefined;

    return {
      id: serviceData.name,
      name: serviceData.name,
      label: serviceData.label || 'user-provided',
      ...(serviceData.plan ? { plan: serviceData.plan } : {}),
      tags,
      credentials: Object.freeze({ ...creds }),
      ...(uri !== undefined ? { uri } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  }
}
