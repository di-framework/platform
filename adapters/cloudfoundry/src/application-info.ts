import { CloudFoundryDetector } from './detector';
import type { CloudFoundryApplicationInfo } from './types';

/**
 * Parses VCAP_APPLICATION JSON string, object payload, or process environment
 * into a strongly typed CloudFoundryApplicationInfo model.
 */
export function parseVcapApplication(
  input?: string | Record<string, unknown>,
): CloudFoundryApplicationInfo | null {
  if (input === null) return null;

  let rawObj: Record<string, unknown> | null = null;

  if (input === undefined) {
    const rawEnv = CloudFoundryDetector.getApplicationJson();
    if (!rawEnv) return null;
    try {
      rawObj = JSON.parse(rawEnv);
    } catch {
      return null;
    }
  } else if (typeof input === 'string') {
    try {
      rawObj = JSON.parse(input);
    } catch {
      return null;
    }
  } else if (typeof input === 'object') {
    if ('VCAP_APPLICATION' in input) {
      const vcapVal = input.VCAP_APPLICATION;
      if (typeof vcapVal === 'string' && vcapVal.trim().length > 0) {
        try {
          rawObj = JSON.parse(vcapVal);
        } catch {
          return null;
        }
      } else if (typeof vcapVal === 'object' && vcapVal !== null) {
        rawObj = vcapVal as Record<string, unknown>;
      } else {
        return null;
      }
    } else {
      // Validate that the object actually has VCAP application fields
      const hasAppFields =
        'application_id' in input ||
        'applicationId' in input ||
        'app_id' in input ||
        'application_name' in input ||
        'applicationName' in input ||
        'space_id' in input ||
        'spaceId' in input ||
        'space_name' in input ||
        'spaceName' in input;

      if (!hasAppFields) {
        return null;
      }
      rawObj = input;
    }
  }

  if (!rawObj || typeof rawObj !== 'object') {
    return null;
  }

  const applicationId = String(
    rawObj.application_id ?? rawObj.applicationId ?? rawObj.app_id ?? '',
  );
  const applicationName = String(
    rawObj.application_name ?? rawObj.applicationName ?? rawObj.name ?? '',
  );

  const rawUris = rawObj.application_uris ?? rawObj.applicationUris ?? rawObj.uris ?? [];
  const applicationUris: readonly string[] = Array.isArray(rawUris)
    ? rawUris.map(String)
    : typeof rawUris === 'string'
      ? [rawUris]
      : [];

  const applicationVersion =
    rawObj.application_version ?? rawObj.applicationVersion ?? rawObj.version;
  const spaceId = String(rawObj.space_id ?? rawObj.spaceId ?? '');
  const spaceName = String(rawObj.space_name ?? rawObj.spaceName ?? '');
  const organizationId = rawObj.organization_id ?? rawObj.organizationId ?? rawObj.org_id;
  const organizationName = rawObj.organization_name ?? rawObj.organizationName ?? rawObj.org_name;
  const instanceId = rawObj.instance_id ?? rawObj.instanceId;

  let instanceIndex: number | undefined;
  const rawIdx = rawObj.instance_index ?? rawObj.instanceIndex;
  if (typeof rawIdx === 'number') {
    instanceIndex = rawIdx;
  } else if (typeof rawIdx === 'string' && rawIdx.trim().length > 0) {
    const parsed = parseInt(rawIdx, 10);
    if (!Number.isNaN(parsed)) instanceIndex = parsed;
  }

  const host = typeof rawObj.host === 'string' ? rawObj.host : undefined;
  let port: number | undefined;
  if (typeof rawObj.port === 'number') {
    port = rawObj.port;
  } else if (typeof rawObj.port === 'string' && rawObj.port.trim().length > 0) {
    const parsed = parseInt(rawObj.port, 10);
    if (!Number.isNaN(parsed)) port = parsed;
  }

  let limits: { readonly disk?: number; readonly fds?: number; readonly mem?: number } | undefined;
  if (typeof rawObj.limits === 'object' && rawObj.limits !== null) {
    const rawLimits = rawObj.limits as Record<string, unknown>;
    limits = {
      disk: typeof rawLimits.disk === 'number' ? rawLimits.disk : undefined,
      fds: typeof rawLimits.fds === 'number' ? rawLimits.fds : undefined,
      mem: typeof rawLimits.mem === 'number' ? rawLimits.mem : undefined,
    };
  }

  return {
    applicationId,
    applicationName,
    applicationUris,
    ...(applicationVersion !== undefined ? { applicationVersion: String(applicationVersion) } : {}),
    spaceId,
    spaceName,
    ...(organizationId !== undefined ? { organizationId: String(organizationId) } : {}),
    ...(organizationName !== undefined ? { organizationName: String(organizationName) } : {}),
    ...(instanceId !== undefined ? { instanceId: String(instanceId) } : {}),
    ...(instanceIndex !== undefined ? { instanceIndex } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(limits !== undefined ? { limits } : {}),
    rawConfig: Object.freeze({ ...rawObj }),
  };
}
