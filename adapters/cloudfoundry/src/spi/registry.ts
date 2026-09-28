import { AmqpServiceInfoCreator } from '../creators/amqp';
import { BlobStorageServiceInfoCreator } from '../creators/blob-storage';
import { RedisServiceInfoCreator } from '../creators/redis';
import { RelationalServiceInfoCreator } from '../creators/relational';
import { UserProvidedServiceInfoCreator } from '../creators/user-provided';
import { CloudFoundryDetector } from '../detector';
import type { CloudFoundryServiceInfo, RawVcapServiceData } from '../types';
import type { CloudFoundryServiceInfoCreator } from './creator';

export class ServiceInfoCreatorRegistry {
  private creators: CloudFoundryServiceInfoCreator[] = [];

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.registerDefaultCreators();
    }
  }

  private registerDefaultCreators(): void {
    this.creators.push(new RelationalServiceInfoCreator());
    this.creators.push(new RedisServiceInfoCreator());
    this.creators.push(new AmqpServiceInfoCreator());
    this.creators.push(new BlobStorageServiceInfoCreator());
    this.creators.push(new UserProvidedServiceInfoCreator());
  }

  /**
   * Registers a custom service info creator.
   * By default, custom creators are inserted with higher priority than built-ins.
   */
  registerCreator(
    creator: CloudFoundryServiceInfoCreator,
    options: { priority?: 'high' | 'low' } = { priority: 'high' },
  ): this {
    if (options.priority === 'low') {
      this.creators.push(creator);
    } else {
      this.creators.unshift(creator);
    }
    return this;
  }

  /**
   * Finds the first matching creator for the given raw service entry.
   */
  findCreator(serviceData: RawVcapServiceData): CloudFoundryServiceInfoCreator | undefined {
    return this.creators.find((c) => {
      try {
        return c.accept(serviceData);
      } catch {
        return false;
      }
    });
  }

  /**
   * Converts a single raw service data object into a typed ServiceInfo model.
   */
  createServiceInfo(serviceData: RawVcapServiceData): CloudFoundryServiceInfo {
    const creator = this.findCreator(serviceData);
    if (creator) {
      return creator.createServiceInfo(serviceData);
    }

    // Default fallback if no creator accepts
    return {
      id: serviceData.name,
      name: serviceData.name,
      label: serviceData.label || 'unknown',
      ...(serviceData.plan ? { plan: serviceData.plan } : {}),
      tags: (serviceData.tags || []).map(String),
      credentials: Object.freeze({ ...(serviceData.credentials || {}) }),
    };
  }

  /**
   * Parses raw VCAP_SERVICES payload and produces typed service models.
   */
  parseVcapServices(
    input?: string | Record<string, unknown> | readonly RawVcapServiceData[],
  ): readonly CloudFoundryServiceInfo[] {
    const rawServices = extractRawServices(input);
    return rawServices.map((entry) => this.createServiceInfo(entry));
  }
}

function extractRawServices(
  input?: string | Record<string, unknown> | readonly RawVcapServiceData[],
): RawVcapServiceData[] {
  if (input === null) {
    return [];
  }

  let parsed: unknown = null;

  if (input === undefined) {
    const rawJson = CloudFoundryDetector.getServicesJson();
    if (!rawJson) return [];
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      return [];
    }
  } else if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return [];
    }
  } else if (Array.isArray(input)) {
    return [...input];
  } else if (typeof input === 'object') {
    if ('VCAP_SERVICES' in input) {
      const vcapVal = input.VCAP_SERVICES;
      if (typeof vcapVal === 'string' && vcapVal.trim().length > 0) {
        try {
          parsed = JSON.parse(vcapVal);
        } catch {
          return [];
        }
      } else if (typeof vcapVal === 'object' && vcapVal !== null) {
        parsed = vcapVal;
      } else {
        return [];
      }
    } else {
      parsed = input;
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const results: RawVcapServiceData[] = [];

  // VCAP_SERVICES format is { "label-name": [ { name, label, credentials, ... } ] }
  for (const [groupKey, serviceList] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(serviceList)) {
      for (const item of serviceList) {
        if (typeof item === 'object' && item !== null) {
          const rawItem = item as Record<string, unknown>;
          const name = String(rawItem.name ?? groupKey);
          const label = String(rawItem.label ?? groupKey);
          results.push({
            name,
            label,
            tags: Array.isArray(rawItem.tags) ? rawItem.tags.map(String) : [],
            plan: typeof rawItem.plan === 'string' ? rawItem.plan : undefined,
            credentials: (rawItem.credentials || {}) as Record<string, unknown>,
            volume_mounts: Array.isArray(rawItem.volume_mounts) ? rawItem.volume_mounts : undefined,
            syslog_drain_url:
              typeof rawItem.syslog_drain_url === 'string' ? rawItem.syslog_drain_url : undefined,
            provider: typeof rawItem.provider === 'string' ? rawItem.provider : undefined,
            binding_name:
              typeof rawItem.binding_name === 'string' ? rawItem.binding_name : undefined,
            instance_name:
              typeof rawItem.instance_name === 'string' ? rawItem.instance_name : undefined,
          });
        }
      }
    }
  }

  return results;
}

let defaultRegistry: ServiceInfoCreatorRegistry | null = null;

export function getDefaultRegistry(): ServiceInfoCreatorRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new ServiceInfoCreatorRegistry();
  }
  return defaultRegistry;
}

export function parseVcapServices(
  input?: string | Record<string, unknown> | readonly RawVcapServiceData[],
  registry = getDefaultRegistry(),
): readonly CloudFoundryServiceInfo[] {
  return registry.parseVcapServices(input);
}
