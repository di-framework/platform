import { schemas } from '../schemas.ts';

interface RuntimeSchema {
  parse(input: unknown): unknown;
  readonly jsonSchema: Record<string, unknown>;
}

/**
 * The generated controllers validate through these. The pilot accepts any shape at runtime;
 * the contract is enforced by the JSON schema in the OpenAPI document and by the generated
 * client's types. Runtime validation arrives with the controller implementation.
 */
function accept(input: unknown) {
  return input;
}

function runtime(jsonSchema: object): RuntimeSchema {
  return { parse: accept, jsonSchema: jsonSchema as Record<string, unknown> };
}

export const Empty = runtime(schemas.Empty);
export const AuthInfo = runtime(schemas.AuthInfo);
export const Principal = runtime(schemas.Principal);
export const DeployBundle = runtime(schemas.DeployBundle);
export const DeployPlan = runtime(schemas.DeployPlan);
export const Deployment = runtime(schemas.Deployment);
export const DeploymentList = runtime(schemas.DeploymentList);
export const DeploymentStats = runtime(schemas.DeploymentStats);
export const RollbackRequest = runtime(schemas.RollbackRequest);
export const CreateServiceRequest = runtime(schemas.CreateServiceRequest);
export const Service = runtime(schemas.Service);
export const LogEvent = runtime(schemas.LogEvent);
export const ConfigList = runtime(schemas.ConfigList);
export const ConfigValue = runtime(schemas.ConfigValue);
export const ProxyRequest = runtime(schemas.ProxyRequest);
export const ProxySession = runtime(schemas.ProxySession);

export type Empty = unknown;
export type AuthInfo = unknown;
export type Principal = unknown;
export type DeployBundle = unknown;
export type DeployPlan = unknown;
export type Deployment = unknown;
export type DeploymentList = unknown;
export type DeploymentStats = unknown;
export type RollbackRequest = unknown;
export type CreateServiceRequest = unknown;
export type Service = unknown;
export type LogEvent = unknown;
export type ConfigList = unknown;
export type ConfigValue = unknown;
export type ProxyRequest = unknown;
export type ProxySession = unknown;
