import { useContainer } from '@di-framework/core/container';
import { CloudFoundryEnvironment } from './environment';
import type {
  AmqpServiceInfo,
  BlobStorageServiceInfo,
  EnableCloudFoundryConnectorsOptions,
  RedisServiceInfo,
  RelationalServiceInfo,
} from './types';

export const CF_ENVIRONMENT_TOKEN = 'cf:environment';
export const CF_APPLICATION_TOKEN = 'cf:application';
export const CF_RELATIONAL_TOKEN = 'cf:relational';
export const CF_REDIS_TOKEN = 'cf:redis';
export const CF_AMQP_TOKEN = 'cf:amqp';
export const CF_BLOB_TOKEN = 'cf:blob';

// biome-ignore lint/suspicious/noExplicitAny: container interface
export function bindCloudFoundryConnectors(
  targetContainer?: any,
  options: EnableCloudFoundryConnectorsOptions = {},
): CloudFoundryEnvironment {
  const container = targetContainer ?? options.container ?? useContainer();
  const cfEnv = new CloudFoundryEnvironment({
    env: options.env,
    localFallback: options.localFallback,
  });

  // 1. Register CloudFoundryEnvironment
  if (typeof container.registerValue === 'function') {
    container.registerValue(CloudFoundryEnvironment, cfEnv);
    container.registerValue(CF_ENVIRONMENT_TOKEN, cfEnv);
  } else if (typeof container.registerInstance === 'function') {
    container.registerInstance(CloudFoundryEnvironment, cfEnv);
    container.registerInstance(CF_ENVIRONMENT_TOKEN, cfEnv);
  }

  // 2. Register Application Info
  const appInfo = cfEnv.getApplicationInfo();
  if (typeof container.registerValue === 'function') {
    container.registerValue(CF_APPLICATION_TOKEN, appInfo);
  }

  // 3. Register Discovered Services
  const allServices = cfEnv.getServiceInfos();
  for (const service of allServices) {
    if (typeof container.registerValue === 'function') {
      // By specific name
      container.registerValue(`cf:service:${service.name}`, service);
      // By label
      container.registerValue(`cf:service:${service.label}`, service);
    }
  }

  // 4. Register primary service singletons for common types
  const relational = cfEnv.getRelationalServiceInfo();
  if (relational && typeof container.registerValue === 'function') {
    container.registerValue(CF_RELATIONAL_TOKEN, relational);
    container.registerValue(`cf:${relational.dialect}`, relational);
  }

  const redis = cfEnv.getRedisServiceInfo();
  if (redis && typeof container.registerValue === 'function') {
    container.registerValue(CF_REDIS_TOKEN, redis);
  }

  const amqp = cfEnv.getAmqpServiceInfo();
  if (amqp && typeof container.registerValue === 'function') {
    container.registerValue(CF_AMQP_TOKEN, amqp);
    container.registerValue('cf:rabbitmq', amqp);
  }

  const blob = cfEnv.getBlobStorageServiceInfo();
  if (blob && typeof container.registerValue === 'function') {
    container.registerValue(CF_BLOB_TOKEN, blob);
    container.registerValue('cf:s3', blob);
  }

  return cfEnv;
}
