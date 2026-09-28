# di-framework/platform

Operated wasmCloud platform for di-framework. This repository publishes the cluster installer, application guest bindings, the SQLite provider component, and the Cloud Foundry adapter.

User-facing CLI commands live in `di-framework/cli-extensions` (`@di-framework/cli-plugin-platform`).

First publish from this remote is **6.0.0**.

## Packages

| Path | Package | Use it for |
| --- | --- | --- |
| [`platform/platform`](platform/platform/README.md) | `@di-framework/platform` | Cluster install: Pulumi, CRDs, controller, tenancy, backing services |
| [`platform/bindings`](platform/bindings/README.md) | `@di-framework/bindings` | Application guest bindings and workload metadata |
| [`platform/sqlite-component`](platform/sqlite-component/README.md) | `@di-framework/sqlite-component` | `di-framework:sqlite@0.1.0` provider component |
| [`platform/backup-agent`](platform/backup-agent/README.md) | `@di-framework/backup-agent` | Job image that dumps and restores backing services |
| [`platform/backup-destination`](platform/backup-destination/README.md) | `@di-framework/backup-destination` | Tenant-namespace Helm operator and HTML console |
| [`adapters/cloudfoundry`](adapters/cloudfoundry/README.md) | `@di-framework/cloudfoundry` | `VCAP_SERVICES` and `VCAP_APPLICATION` discovery |

## Develop

From this repository:

```sh
bun install
bun run build
bun test
bun run lint
bun run typecheck
```

`bun test` builds `@di-framework/platform`, `@di-framework/bindings`, and `@di-framework/cloudfoundry` before the test run. Build the SQLite provider from its package:

```sh
cd platform/sqlite-component
make tools
make build
make smoke
```

`make tools` installs the pinned wasm-tools, wac, and wasi-sdk. `make smoke` needs `wasmtime` on `PATH`.

## Usage

### Declare application bindings

In an application that already depends on `@di-framework/core`:

```sh
bun add @di-framework/bindings
```

Put binding classes in `src/bindings.ts`. The platform CLI discovers that file, adds the WIT imports, and renders matching `hostInterfaces` entries.

```ts
import { Container } from '@di-framework/core/decorators';
import { KeyValue, Postgres, WasmCloudBinding } from '@di-framework/bindings';

@WasmCloudBinding('user-database', { config: { database: 'orders' } })
@Container()
export class UserDatabase extends Postgres {}

@WasmCloudBinding('sessions', { interfaces: ['store', 'atomics'] })
@Container()
export class Sessions extends KeyValue {}
```

Reference credentials with `secretFrom`. When it is omitted, the default Kubernetes Secret name is `<application>-<binding>`. Binding names are WIT identifiers (`/^[a-z][a-z0-9-]*$/`). Inline `config` rejects password, token, URI, and connection-string values.

| Class | WIT package | Version |
| --- | --- | --- |
| `Postgres` | `wasmcloud:postgres` | 0.2.0 |
| `KeyValue` | `wasmcloud:keyvalue` | 0.2.0 |
| `Blobstore` | `wasmcloud:blobstore` | 0.1.0 |
| `Messaging` | `wasmcloud:messaging` | 0.3.0 |
| `Config` | `wasi:config` | 0.2.0-rc.1 |
| `Secrets` | `wasmcloud:secrets` | 2.1.0 |
| `OutgoingHttp` | `wasi:http` `client` | 0.3.0 |

Host configuration and unit-test doubles are in the [bindings README](platform/bindings/README.md).

### Managed PostgreSQL

Create a dedicated instance, then point a `Postgres` binding at it with `serviceName`:

```sh
di-framework platform service create postgres --name orders --target alpha \
  --storage 1Gi --memory 512Mi --cpu 250m --wait --timeout 180
```

```ts
import { Postgres, WasmCloudBinding } from '@di-framework/bindings';

@WasmCloudBinding('orders-db', { serviceName: 'orders' })
export class OrdersDatabase extends Postgres {}
```

`di-framework platform deploy --target alpha` creates the `ServiceBinding`, waits until it is ready, and applies the workload. `serviceName` applies to PostgreSQL, and it cannot be combined with `secretFrom`, `configFrom`, or `config`. Managed binding names are DNS labels of at most 54 characters; service names are at most 40.

Storage, retention, deletion, and recovery are in [Dedicated PostgreSQL](platform/platform/README.md#dedicated-postgresql-upcoming-release).

### Workload membership

HTTP components and broker services declare the path the CLI uses in the generated manifest:

```ts
import { WorkloadComponent, WorkloadService } from '@di-framework/bindings';

export const take = WorkloadComponent({ path: '/take' })(async () => new Response('take'));

export const sync = WorkloadService({
  path: '/sync',
  subscriptions: ['warehouse.sync'],
})(async () => {});
```

`Workload('warehouse')` records a colocation namespace. Paths start with `/`. Deployment membership comes from `di-framework.config.json`.

### Install a platform

`@di-framework/platform/local` is the Pulumi program generated projects run for an isolated Docker/k0s cluster. Operate it through the CLI, from the workspace root:

```sh
di-framework platform cluster up local --yes
di-framework platform deploy <configured-project-name>
curl -H 'Host: <configured-project-name>' http://127.0.0.1:28180/
di-framework platform destroy <configured-project-name>
di-framework platform cluster destroy local --yes
```

Default loopback ports are Kubernetes `26443`, registry `25000`, and HTTP `28180`. Each must be a distinct integer from 1024 through 65535. Declare tenants and users in `Pulumi.<stack>.yaml`. Ports, outputs, and tenancy are in the [generated project README](platform/platform/assets/platform/README.md).

`@di-framework/platform/existing` installs the same Kubernetes resources on a caller-owned cluster. `kubeconfig` is a required local file path. `di-framework-kube` uses this entrypoint. Call `createPlatform({ provider, installation })` when another program already owns the cluster and the Pulumi stack.

The CLI and kube share one project, backend, and stack for a given installation. Configuration keys, CRDs, admission, and backing-service contracts are in the [platform README](platform/platform/README.md).

### Cloud Foundry

```sh
bun add @di-framework/cloudfoundry
```

`@EnableCloudFoundryConnectors()`, `@CloudFoundryService('service-name')`, and `@VcapApplication()` read `VCAP_SERVICES` and `VCAP_APPLICATION`. Outside Cloud Foundry the connector falls back to `DATABASE_URL`, `REDIS_URL`, `AMQP_URL`, and `S3_BUCKET`. Built-in creators cover relational databases, Redis, AMQP, blob storage, and user-provided services. Register more through `ServiceInfoCreatorRegistry`. Examples are in the [Cloud Foundry README](adapters/cloudfoundry/README.md).

### SQLite provider

The CLI composes application components with `di-framework-sqlite.wasm`. Guests import `di-framework:sqlite/database@0.1.0` and open a path inside the host preopen:

```ts
import { open } from 'di-framework:sqlite/database@0.1.0';

const db = open('/data/actors/orders.sqlite', undefined);
db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
```

Build, compose, and persistence rules are in the [SQLite component README](platform/sqlite-component/README.md).

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
