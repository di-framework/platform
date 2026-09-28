export const BINDING_KINDS = [
  'Postgres',
  'KeyValue',
  'Blobstore',
  'Messaging',
  'Config',
  'Secrets',
  'OutgoingHttp',
] as const;

export type BindingKind = (typeof BINDING_KINDS)[number];

export type CatalogEntry = {
  kind: BindingKind;
  package: string;
  version: string;
  interfaces: string[];
  /** First interface carries the labeled import / hostInterfaces name. */
  primaryInterface: string;
  namedInstance: boolean;
  sharedResources: string[];
  witDep: string;
  usesSecret: boolean;
  configKeys: string[];
};

export const BINDING_CATALOG: Record<BindingKind, CatalogEntry> = {
  Postgres: {
    kind: 'Postgres',
    package: 'wasmcloud:postgres',
    version: '0.2.0',
    interfaces: ['query', 'prepared', 'types'],
    primaryInterface: 'query',
    namedInstance: true,
    sharedResources: ['types.pg-value', 'types.error'],
    witDep: 'wasmcloud-postgres',
    usesSecret: true,
    configKeys: [],
  },
  KeyValue: {
    kind: 'KeyValue',
    package: 'wasmcloud:keyvalue',
    version: '0.2.0',
    interfaces: ['store', 'atomics', 'cas', 'batch', 'types'],
    primaryInterface: 'store',
    namedInstance: true,
    sharedResources: ['types.bucket', 'types.error'],
    witDep: 'wasmcloud-keyvalue',
    usesSecret: false,
    configKeys: ['backend', 'url', 'prefix', 'root'],
  },
  Blobstore: {
    kind: 'Blobstore',
    package: 'wasmcloud:blobstore',
    version: '0.1.0',
    interfaces: ['blobstore', 'container', 'types'],
    primaryInterface: 'blobstore',
    namedInstance: true,
    sharedResources: ['types.container', 'types.error'],
    witDep: 'wasmcloud-blobstore',
    usesSecret: false,
    configKeys: ['backend', 'url', 'root', 'buckets'],
  },
  Messaging: {
    kind: 'Messaging',
    package: 'wasmcloud:messaging',
    version: '0.3.0',
    interfaces: ['consumer', 'types'],
    primaryInterface: 'consumer',
    namedInstance: true,
    sharedResources: ['types.broker-message', 'types.error'],
    witDep: 'wasmcloud-messaging',
    usesSecret: false,
    configKeys: ['backend', 'url', 'subscriptions', 'consumer_group'],
  },
  Config: {
    kind: 'Config',
    package: 'wasi:config',
    version: '0.2.0-rc.1',
    interfaces: ['store'],
    primaryInterface: 'store',
    namedInstance: false,
    sharedResources: [],
    witDep: 'wasi-config',
    usesSecret: false,
    configKeys: [],
  },
  Secrets: {
    kind: 'Secrets',
    package: 'wasmcloud:secrets',
    version: '2.1.0',
    interfaces: ['store', 'reveal'],
    primaryInterface: 'store',
    namedInstance: true,
    sharedResources: [],
    witDep: 'wasmcloud-secrets',
    usesSecret: true,
    configKeys: [],
  },
  OutgoingHttp: {
    kind: 'OutgoingHttp',
    package: 'wasi:http',
    version: '0.3.0',
    interfaces: ['client'],
    primaryInterface: 'client',
    namedInstance: false,
    sharedResources: [],
    witDep: 'wasi-http',
    usesSecret: false,
    configKeys: ['allowedHosts'],
  },
};

export function isBindingKind(value: string): value is BindingKind {
  return (BINDING_KINDS as readonly string[]).includes(value);
}
