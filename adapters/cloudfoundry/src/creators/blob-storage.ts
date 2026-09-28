import type { CloudFoundryServiceInfoCreator } from '../spi/creator';
import type { BlobStorageServiceInfo, RawVcapServiceData } from '../types';

const S3_PATTERNS = ['s3', 'minio', 'objectstore', 'blobstore', 'blob-storage', 'ecs-s3'];

function matchesAny(str: string, patterns: readonly string[]): boolean {
  const lower = str.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

export class BlobStorageServiceInfoCreator
  implements CloudFoundryServiceInfoCreator<BlobStorageServiceInfo>
{
  accept(serviceData: RawVcapServiceData): boolean {
    const label = serviceData.label || '';
    const tags = (serviceData.tags || []).map((t) => String(t).toLowerCase());
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;

    if (matchesAny(label, S3_PATTERNS)) {
      return true;
    }

    if (tags.some((t) => matchesAny(t, S3_PATTERNS))) {
      return true;
    }

    if (
      (creds.bucket || creds.bucket_name || creds.bucketName) &&
      (creds.access_key_id ||
        creds.accessKeyId ||
        creds.access_key ||
        creds.aws_access_key_id ||
        creds.endpoint)
    ) {
      return true;
    }

    const uriCandidate = String(creds.uri ?? creds.url ?? '');
    if (uriCandidate.startsWith('s3://')) {
      return true;
    }

    return false;
  }

  createServiceInfo(serviceData: RawVcapServiceData): BlobStorageServiceInfo {
    const creds = (serviceData.credentials || {}) as Record<string, unknown>;
    const tags = (serviceData.tags || []).map(String);

    let bucketName = String(
      creds.bucket_name ?? creds.bucketName ?? creds.bucket ?? creds.name ?? serviceData.name,
    );

    const endpoint =
      (creds.endpoint ?? creds.endpoint_url ?? creds.endpointUrl ?? creds.host)
        ? String(creds.endpoint ?? creds.endpoint_url ?? creds.endpointUrl ?? creds.host)
        : undefined;

    const region =
      (creds.region ?? creds.aws_region ?? creds.s3_region)
        ? String(creds.region ?? creds.aws_region ?? creds.s3_region)
        : undefined;

    let accessKeyId =
      (creds.access_key_id ?? creds.accessKeyId ?? creds.access_key ?? creds.aws_access_key_id)
        ? String(
            creds.access_key_id ?? creds.accessKeyId ?? creds.access_key ?? creds.aws_access_key_id,
          )
        : undefined;

    let secretAccessKey =
      (creds.secret_access_key ??
      creds.secretAccessKey ??
      creds.secret_key ??
      creds.aws_secret_access_key)
        ? String(
            creds.secret_access_key ??
              creds.secretAccessKey ??
              creds.secret_key ??
              creds.aws_secret_access_key,
          )
        : undefined;

    const pathStyle =
      typeof creds.path_style === 'boolean'
        ? creds.path_style
        : typeof creds.pathStyle === 'boolean'
          ? creds.pathStyle
          : undefined;

    let rawUri = (creds.uri ?? creds.url) ? String(creds.uri ?? creds.url) : undefined;
    if (rawUri?.startsWith('s3://')) {
      try {
        const parsed = new URL(rawUri);
        if (parsed.hostname) bucketName = parsed.hostname;
        if (parsed.username) accessKeyId = decodeURIComponent(parsed.username);
        if (parsed.password) secretAccessKey = decodeURIComponent(parsed.password);
      } catch {
        // ignore parse error
      }
    }

    if (!rawUri && endpoint) {
      rawUri =
        endpoint.startsWith('http://') || endpoint.startsWith('https://')
          ? `${endpoint}/${bucketName}`
          : `https://${endpoint}/${bucketName}`;
    }

    return {
      id: serviceData.name,
      name: serviceData.name,
      label: serviceData.label,
      ...(serviceData.plan ? { plan: serviceData.plan } : {}),
      tags,
      credentials: Object.freeze({ ...creds }),
      bucketName,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(accessKeyId !== undefined ? { accessKeyId } : {}),
      ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
      ...(rawUri !== undefined ? { uri: rawUri } : {}),
      ...(pathStyle !== undefined ? { pathStyle } : {}),
    };
  }
}
