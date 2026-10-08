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

## Transaction semantics

`wasmcloud:postgres@0.2.0` has `query` and `queryBatch`, and no transaction handle. Each call goes
to whichever pooled connection is free. A named import (`user-database-query`) is served from a
per-credential pool with no connection affinity, so a `BEGIN` in one call does not cover the next
statement. A `COMMIT` can land on a connection that never saw the `BEGIN`, and that connection
stays `idle in transaction`.

Guests that use `@di-framework/repo` open the binding with `openPostgresDatabase` from
`@di-framework/bindings/postgres`. The handle is an `AutocommitDatabase`. Every statement is its
own transaction, and `transaction(fn)` runs `fn` on that same handle. The adapter never sends
`BEGIN`, `COMMIT`, or `ROLLBACK`. `FOR UPDATE` and advisory locks last only for the statement
that carries them.

Keep an invariant in one statement:

- a conditional `UPDATE … RETURNING`
- a data-modifying CTE
- `INSERT … SELECT … WHERE NOT EXISTS`

`run` sets `changes` from the rows returned. The provider does not report a command tag, so a
count is a `RETURNING` list.

`exec` sends its script as one `queryBatch`. The host runs that string on one pooled client, and
Postgres treats a multi-statement simple query as one implicit transaction.

`atomicBatch` is for a write-only sequence that must commit or roll back together and that does
not read between statements. It renders each parameter as a literal (quotes doubled, a negative
number parenthesized so it cannot form a `--` comment) and submits one `BEGIN; …; COMMIT`
string. wasmCloud v2.8.0 runs that string on one pooled client:
`crates/wash-runtime/src/plugin/wasmcloud_postgres/async_p3.rs` checks out a single client in
`query_batch` and calls `client.batch_execute` (`batch_with_client`, line 191).

```ts
import { openPostgresDatabase } from '@di-framework/bindings/postgres';

const db = openPostgresDatabase(database);
await db.atomicBatch([
  { sql: 'INSERT INTO t (name, n) VALUES (?, ?)', params: ["o'brien", -1] },
]);
```

`@di-framework/repo` is an optional peer of this package. The main `@di-framework/bindings` entry
leaves it unloaded. Import `@di-framework/bindings/postgres` from a guest that depends on
`@di-framework/repo`.

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
