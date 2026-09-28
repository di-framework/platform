# @di-framework/bindings

Native [wasmCloud](https://wasmcloud.com) WIT service bindings for DI Framework applications.

Each concrete class is a DI token, a named `hostInterfaces` entry, and a build-time WIT
requirement. The package maps to wasmCloud/WASI interfaces rather than inventing a second
capability vocabulary.

This package **consumes** host-interface bindings. It does not provision PostgreSQL, Redis, NATS,
or object stores, and it never embeds secret values. ConfigMaps and Secrets stay with Pulumi,
Terraform, Crossplane, Helm, or another infrastructure layer.

## Bindings

```ts
import { Component, Container } from '@di-framework/core/decorators';
import { KeyValue, Postgres, WasmCloudBinding } from '@di-framework/bindings';

@WasmCloudBinding('user-database')
@Container()
export class UserDatabase extends Postgres {}

@WasmCloudBinding('sessions', { interfaces: ['store', 'atomics'] })
@Container()
export class Sessions extends KeyValue {}

@WasmCloudBinding('cache')
@Container()
export class Cache extends KeyValue {}
```

Put those classes in `src/bindings.ts`. The wasmCloud CLI extension discovers the file, contributes
each class to the shared WIT requirement graph, generates real WIT guest imports, and renders
matching `hostInterfaces` entries. PostgreSQL entries omit `hostInterfaces[].name` to match the
unlabeled import; the binding name still identifies the DI guest and its configuration overlays.
The compiled guest world is unlabeled (`import wasmcloud:postgres/query@0.2.0`) because the qjs componentizer cannot
emit `cm-implements` labeled imports yet. Imported `async func`s (postgres, key-value, blobstore,
messaging, secrets, outgoing HTTP) componentize with `@di-framework/componentize-qjs`
(wasmtime 48). Set `DI_FRAMEWORK_COMPONENTIZE_QJS` to override that CLI.
`wasi:config@0.2.0-rc.1` is sync and also componentizes with stock jco.

For PostgreSQL, configure the host connection with `WASH_POSTGRES_URL` (or
`WASMCLOUD_POSTGRES_URL` with the CLI's `platform dev` command), and set
`config: { database: 'orders' }` on the binding. The unnamed import uses the host's
connection and the selected database; multiple independently credentialed PostgreSQL
bindings are not supported by this QuickJS path yet. Guests initialize before the
application, including bindings constructed at module startup.

Secret material is referenced, never inlined:

```ts
@WasmCloudBinding('user-database', { secretFrom: 'orders-user-database' })
@Container()
export class UserDatabase extends Postgres {}
```

When `secretFrom` is omitted, the default Kubernetes Secret name is `<application>-<binding>`.

## Supported capabilities

| Class | WIT package | Version |
| --- | --- | --- |
| `Postgres` | `wasmcloud:postgres` | 0.2.0 |
| `KeyValue` | `wasmcloud:keyvalue` | 0.2.0 |
| `Blobstore` | `wasmcloud:blobstore` | 0.1.0 |
| `Messaging` | `wasmcloud:messaging` | 0.3.0 |
| `Config` | `wasi:config` | 0.2.0-rc.1 |
| `Secrets` | `wasmcloud:secrets` | 2.1.0 |
| `OutgoingHttp` | `wasi:http` `client` | 0.3.0 |

Package versions are independent of the WASI 0.3 component-model preview.

## Unit tests

Replace a binding through the container:

```ts
class FakeUserDatabase extends UserDatabase {
  override query() {
    return Promise.resolve([]);
  }
}

testContainer.registerValue(UserDatabase, new FakeUserDatabase());
```

## Managed PostgreSQL (upcoming release)

```ts
@WasmCloudBinding('orders-db', { serviceName: 'orders' })
export class OrdersDatabase extends Postgres {}
```

Create the service with `di-framework platform service create postgres --name orders --wait`.
Deploying creates workload-owned ServiceBindings and waits for the controller's
connection Secrets. Multiple bindings can share a service; separate services use
independent credentials and PVCs. `serviceName` currently supports PostgreSQL only
and cannot be combined with manual connection configuration.

See [platform PostgreSQL lifecycle and recovery](../di-framework-platform/README.md#dedicated-postgresql-upcoming-release)
for storage prerequisites, retention, and deletion.
