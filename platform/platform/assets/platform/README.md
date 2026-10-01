# Local wasmCloud platform

This generated Pulumi project provisions platform resources only:

- a pinned k0s controller/worker in a stack- and workspace-scoped container network;
- stack-scoped container volumes for k0s state and pod logs;
- an in-cluster, pinned OCI registry exposed to the host only through loopback;
- wasmCloud runtime operator 2.8.0 and its default HTTP host group;
- a generic loopback HTTP entrypoint.

Application components, Services, and WorkloadDeployments remain owned by
`di-framework platform deploy`. No application name is stored here.

`di-framework platform cluster up local --yes` runs `pulumi install`
before selecting the stack, so this directory does not need a manual package
manager install and does not need to belong to a root workspace.

## Ports

The safe high defaults bind only to `127.0.0.1`:

| Pulumi setting | Default | Purpose |
| --- | ---: | --- |
| `apiPort` | `26443` | Kubernetes API |
| `registryPort` | `25000` | host-side ORAS push endpoint |
| `httpPort` | `28180` | wasmCloud HTTP entrypoint |

Each must be a distinct integer from 1024 through 65535. Override one before
deployment from this directory, for example:

```sh
pulumi config set httpPort 28181
```

Internal NodePorts are fixed inside the isolated k0s container. The registry
push address (`http://127.0.0.1:25000` by default) and cluster pull address
(`di-framework-registry.wasmcloud.svc.cluster.local:5000`) reach the same
registry content.

## Container engine

Docker is the default. To run the k0s container with Podman (or another
Docker-compatible CLI on `PATH`), set `containerCli` before the first deployment:

```sh
pulumi config set containerCli podman
```

The value must be a plain command name or path. Resources stay owned by the
engine that created them, so to switch engines destroy the platform first and
deploy again; that removes cluster state.

## Registry mirrors

To pull images through a mirror (for example when Docker Hub is rate limited or
unreachable from the container engine), set `registryMirrors` before the first
deployment. It maps a registry host to an ordered list of mirror URLs; containerd
tries each mirror and then the registry itself:

```sh
pulumi config set --path 'registryMirrors["docker.io"][0]' https://mirror.gcr.io
```

Unset means no mirrors. The `@di-framework/platform` README lists the accepted
values. Changing mirrors later requires destroying and redeploying the platform.

## Output contract

| Output | Meaning |
| --- | --- |
| `schemaVersion` | output contract version (`2`) |
| `kubeconfig` | absolute path to a generated mode-0600 kubeconfig |
| `namespace` | Kubernetes namespace (`wasmcloud`) |
| `registry.push` | host-side registry URL used by ORAS |
| `registry.pull` | cluster-side registry address used by workloads |
| `registry.insecure` | whether ORAS must use plain HTTP |
| `endpoints.kubernetes` | loopback API server URL |
| `endpoints.registry` | loopback registry URL |
| `endpoints.http` | loopback HTTP URL |
| `kubeconfigs` | secret: `{ [tenant]: { [user]: kubeconfig } }`, one per user membership |

## Lifecycle

From the workspace root:

```sh
di-framework platform cluster up local --yes
di-framework platform deploy <configured-project-name>
di-framework platform destroy <configured-project-name>
di-framework platform cluster destroy local --yes
```

Send the configured project name as the HTTP `Host` header, for example:

```sh
curl -H 'Host: greeter' http://127.0.0.1:28180/
```

Platform destroy removes only container-engine and Kubernetes resources bearing this
project/stack scope, along with the generated kubeconfig. It refuses to adopt
or replace an already-existing container, network, or volume with the same name. Teardown
uses the `kubectl` bundled in the scoped k0s container, so no host-side
`kubectl` installation is needed for platform lifecycle commands.


## Users and tenants

Declare tenants and users in the stack's `Pulumi.<stack>.yaml`. Replace the
`<project>` prefix with the name in `Pulumi.yaml`:

```yaml
config:
  <project>:tenants:
    - name: warehouse
      deletionPolicy: Retain
  <project>:users:
    - name: alice
      memberships:
        - tenant: warehouse
          role: developer
    - name: reviewer
      memberships:
        - tenant: warehouse
          role: viewer
```

Run the existing `di-framework platform cluster up local --yes` command.
Pulumi installs the cluster-scoped `Tenant` and `User` CRDs in
`platform.di-framework.dev/v1alpha1`, admission policies, a TypeScript controller,
and the declared custom resources. It waits for their `Ready` conditions. There
are no additional platform CLI subcommands. Controller TypeScript is compiled to
JavaScript when Pulumi builds its ConfigMap; no custom container build is needed.
Run `bun run check` in this directory to check all generated TypeScript.

Each tenant gets `di-tenant-<name>` for workloads and `di-runtime-<name>` for its
host pool, Redis, and NATS. Host environments match the workload namespace, and
`allowSharedHosts` is false. Runtime certificates remain in the runtime namespace.
Pulumi seeds these namespaces before Helm so the wasmCloud operator can watch
host pods there; the controller then manages their resources and lifecycle.
Add tenants through stack configuration so Helm's `hostNamespaces` stays current.
A tenant defaults to one runtime, a 2-CPU/4-GiB runtime-namespace quota, 20
WorkloadDeployments, 10 `BackingService` objects, and 40 `ServiceBinding`
objects. Increase `resources.cpu` and `resources.memory` when increasing
`runtime.replicas`; these quotas cover runtime pods and aggregate
`requests.storage` (50Gi hard) for stock and future `di-bs-*` backends, not
individual Wasm invocations. Override concurrent service/binding counts with
`resources.backingServices` / `resources.serviceBindings`.

Users get a ServiceAccount in `wasmcloud` and tenant RoleBindings. Developers
can manage WorkloadDeployments, `BackingService`, `ServiceBinding`, ConfigMaps,
Secrets, and ClusterIP Services, read runtime logs, and port-forward runtime pods.
Viewers can read workloads, `BackingService` / `ServiceBinding` status, and
runtime logs. Neither role can manage Kubernetes pods, RBAC, tenant declarations,
`BackingServiceClass`, or read runtime Secrets. Missing or suspended tenants
receive no grants.

**Authorization boundary (v1):** tenant-level only — not per-user or per-workload.
Developers in a tenant can read Secrets and port-forward runtime pods in that
tenant; the platform does **not** claim finer credential isolation. Admission
still blocks CLI/API bypass for forged hostInterfaces and mutation of
controller-managed config (see `@di-framework/platform` README).

Each membership gets a kubeconfig built from a controller-managed ServiceAccount
token Secret (`di-user-<user>-<tenant>-token` in `wasmcloud`), with the loopback API
server, the cluster CA, and the tenant workload namespace selected. Pulumi reads it
once the User is Ready and exports it in the secret `kubeconfigs` output:

```sh
pulumi stack output kubeconfigs --show-secrets | jq -r '.warehouse.alice' > alice.kubeconfig
chmod 600 alice.kubeconfig
```

The token is the kubeconfig's **only** credential; do not distribute the admin
kubeconfig or its client certificate/key. `viewer` users get read-only access.
The token does not expire: removing the membership or suspending the user deletes
its Secret and invalidates it. Tokens are never stored in User status. The `users`
output identifies the ServiceAccount; `tenants` identifies the namespaces and host
group.

Configure a deployment target with the user's kubeconfig,
`namespace = "di-tenant-warehouse"` and `hostgroup = "tenant-warehouse"`.
Port-forward `service/di-http` in `di-runtime-warehouse` to reach its HTTP routes.
The default platform HTTP entrypoint continues to target the default host group.
For shared tenant keyvalue storage, reference the controller-managed ConfigMap
`di-tenant-stock` in the native keyvalue host interface (transitional). Independent
services use ConfigMaps named `di-bs-*` and binding-projected Secrets/ConfigMaps
named `di-binding-*` (#450/#451). The warehouse's HTTP, Redis, and NATS sync flow
has been verified on the stock `ghcr.io/wasmcloud/wash:2.8.0` image; native
keyvalue needs no custom image. The warehouse uses this same ConfigMap reference
in its external-cluster setup. Messaging uses the tenant's dedicated NATS backend.
Tenant admission restricts native interfaces, forbids host volumes and guest
network capabilities, and reserves `di-tenant-stock`, `di-bs-*`, and
`di-binding-*` ConfigMaps/Secrets against tenant-user create/update/delete.
Workloads needing additional capabilities require administrator review and a
corresponding policy change.

Set `suspended: true` on a User to revoke bindings and delete its ServiceAccount;
previous tokens remain invalid after unsuspension creates a new account. Membership
changes remove obsolete bindings, including when downgrading developer to viewer.
Set `suspended: true` on a Tenant to revoke access and stop its runtimes/backends.
Changes converge through the controller; existing connections are not forcibly
terminated by RBAC revocation.

Tenant deletion defaults to `Retain`: access is revoked, deployments stop, and
namespaces/data stay labelled with the original UID. The controller refuses to
adopt those resources if the name is reused. `deletionPolicy: Delete` removes both
namespaces. Backend data uses tenant-UID-specific directories on the local k0s
volume; deleting namespaces does not erase those directories. Destroying the
entire platform removes that volume and **all** retained data. Back up data before
platform destruction. This storage layout targets the generated single-node
local platform, not a multi-node production cluster.

This is a local development platform. Its registry is shared and unauthenticated,
and its published ports bind to loopback. Remote access, authenticated tenant
registries, production storage, and stronger resource accounting are separate
work. Namespace NetworkPolicies require an enforcing CNI (the generated k0s
cluster uses kube-router). `tenantHostImage` and `tenantHostImagePullPolicy` can
select a compatible custom wasmCloud runtime image when needed.

## Shared implementation

This generated project imports an exact version of `@di-framework/platform/local`.
The same package provides the Kubernetes platform used by `di-framework-kube`.
Configure this project through Pulumi configuration; infrastructure implementation
changes belong in the shared package rather than copied tenancy files.

Backing-service CRD contracts (`BackingServiceClass`, `BackingService`,
`ServiceBinding`), authorization boundaries, and runtime feasibility notes live in
the `@di-framework/platform` package README. Platform install seeds the approved
default classes (`keyvalue-redis`, `messaging-nats`, `blobstore-nats`, `postgres-dedicated`, `egress-public`), retains CRDs on stack destroy,
ships compiled controller scripts including `backing-services.js`, and enforces
tenant RBAC / admission / quotas / backend NetworkPolicy isolation (#452).

For projects generated before this extraction, preserve the existing project name,
backend, stack, and configuration when updating the import/dependency. Review
`pulumi preview` before applying. The shared local entrypoint preserves existing
logical resource names. Any old `tenancy.ts` and `tenancy/` copies are unused by the
new entrypoint; migrate customizations before removing them. Publishing the shared
package is required before installing its pinned version from npm.
