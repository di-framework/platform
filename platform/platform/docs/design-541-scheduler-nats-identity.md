# Design: per-tenant identity and authorization on the scheduler NATS (#541)

| | |
|---|---|
| Issue | #541 (part of epic #495, E2 Tenant isolation and transport; found during the #535 check) |
| Related | #535, #540, #542 (network policy on the scheduler NATS); #552 (scheduler NATS without debug/trace logging) |
| Status | **Design, revised after review round 1 on PR #558.** No code changes. Implementation waits for this note to merge. |
| Scope | `platform/platform` (scheduler NATS, PKI, tenant host wiring), a new `platform/runtime-operator` fork directory and its workflows, and one vCluster value in `platform/operator` |
| Constraints from the owner | No users yet: no rollout phases, no tenant-by-tenant migration, no compatibility shims, no release notes. The shared certificate is replaced outright. The gap is fixed, not documented away. |

## Conventions

- Paths are relative to the repository root and were read at `origin/main` `300edea`. #552 merged after that commit. It adds `platform/platform/src/nats-log-level.ts` and changes no line cited here.
- `chart:` is a template or values line of the runtime-operator Helm chart 2.8.0 (`oci://ghcr.io/wasmcloud/charts/runtime-operator`, the version `platform/platform/src/index.ts:255` pins).
- `wasmcloud:` is wasmCloud `v2.8.0` at `5c4ec4a3` (the commit `platform/tenant-host/Dockerfile:15-16` pins). Its `runtime-operator/` directory is the operator source.
- `nats-server:` is nats-server `v2.12.8` (the image tag `chart: values.yaml:65` pins). `nats.go:` is nats.go `v1.53.1` (`wasmcloud: runtime-operator/go.mod:20`).
- `vcluster:` is the vCluster chart 0.37.3 bundled at `platform/operator/internal/targets/vcluster/chart/vcluster-0.37.3.tgz`.
- Each claim is marked **V** (verified in source, or in the chart rendered with `helm template`), **P** (verified by the broker probe in section 9, whose exact configuration is Appendix A) or **U** (unverified; the implementation or Layer 4 must confirm it).
- This note states the gap and the target properties. It does not describe how the current state could be abused.

## 1. Summary

Today every tenant host group and the platform's own host group present the same client certificate to the scheduler NATS. The certificate maps to one NATS user with no permission limits in the global account. Subjects carry no tenant, and the runtime-operator takes a host's tenant from the heartbeat payload without checking who sent it. The bus cannot tell tenants apart.

The end state:

- **The scheduler NATS leaves the chart.** The platform deploys it with the same Service name, port and labels, owns its configuration, and reloads it in place. It runs without debug or trace logging.
- **One NATS account per host environment.** Each tenant's hosts get an account with a certificate-mapped user. So does the platform's own host group. The operator has its own account, and the platform data user has its own. Accounts share nothing except two server-side mappings per host account:
  - heartbeats published as `runtime.operator.heartbeat.<host_id>` reach the operator as `runtime.operator.heartbeat.<environment>.<host_id>`;
  - commands sent to `runtime.host.<environment>.<host_id>.<cmd>` reach the host as `runtime.host.<host_id>.<cmd>`, the subject unpatched wash expects.

  The server adds the environment token. A host cannot choose or forge it.
- **Per-tenant certificates from a platform-issued, name-constrained tenant CA.** The platform controller issues them and binds each to a fresh NATS user name per issuance. It records current and previous issuances in controller-owned state and rotates them. Removing a tenant or force-rotating its identity revokes the old user in the next reload. A routine renewal keeps the previous user for a short, fixed overlap.
- **A runtime-operator patch** shipped as a forked image (`ghcr.io/di-framework/runtime-operator`), built and pinned the way the tenant host image is. It binds each host ID, Host name and host pod to exactly one environment. It accepts a heartbeat only when all of these agree: the server-added environment token, the payload, a running host pod whose namespace maps to that environment, and existing bindings. It addresses every workload command with the environment recorded on the Workload at placement. wash stays unpatched.
- **The shared certificate and the chart's CA are gone.** No tenant namespace receives a platform key, and the CA keys live in a namespace that no pod and no workload can reach.

A local broker probe ran the proposed configuration (Appendix A) on nats-server 2.12.8, and all 33 of its checks passed. It covered cross-tenant isolation, explicit permission violations, mapping, rejection of forged certificates, adding a tenant by reload, an atomically refused reload, and revocation on reload (section 9). The reviewer ran an independent probe of the same configuration, and all 40 of its checks passed.

## 2. Current state

### 2.1 Authentication and authorization on the scheduler NATS

- The chart ships its own `nats` Deployment and ConfigMap (`chart: templates/nats/config.yaml`, `templates/nats/deployment.yaml`). TLS is on by default (`chart: values.yaml:24-27`), and the platform does not change it (`platform/platform/src/index.ts:369-404`, `platform/platform/src/values.ts:2-17`). **V**
- Clients authenticate with mTLS and `verify_and_map`. Three users exist, `wasmcloud-operator`, `wasmcloud-runtime` and `wasmcloud-data`. The config has no accounts, no `permissions`, no NKeys or JWTs and no `no_auth_user` (`chart: templates/nats/config.yaml:19-34`). All three users are therefore in the global account with unrestricted publish and subscribe. **V**
- Helm generates the CA and one certificate per role at render time and reuses them through `lookup` (`chart: templates/certificates.yaml:24-61`). **V**
- The chart has no value for the server configuration. Changing authentication means `nats.enabled: false` (`chart: values.yaml:54-56`) and a platform-owned server. **V**
- The chart starts the server with debug and trace logging (`chart: templates/nats/deployment.yaml:50`). #552 post-renders those flags away. Once the server is out of the chart, that post-renderer has nothing left to rewrite and is removed (4.1). **V**

### 2.2 What a tenant host presents

- The platform controller reads `wasmcloud-runtime-tls` from the platform namespace (`platform/platform/src/tenancy/controller.ts:994-996`) and copies its whole `data` into `di-scheduler-tls` in each `di-runtime-<tenant>` (`platform/platform/src/tenancy/resources.ts:1426-1432`). Every tenant holds the same private key as the platform's own host group. **V**
- The host mounts that Secret read-only at `/scheduler` (`resources.ts:1548,1573`) and passes `--scheduler-nats-tls-{ca,cert,key}` (`resources.ts:1495-1505`).
- wash 2.8.0 has no other credential for the scheduler bus. Its only scheduler authentication flags are the TLS ones (`wasmcloud: crates/wash/src/cli/host.rs:21-39`), and `connect_nats` adds only root certificates and a client certificate (`wasmcloud: crates/wash-runtime/src/washlet/mod.rs:294-341`). **V**
- The tenant host patches (`platform/tenant-host/0001-*.patch`, `0002-*`, `0003-*`) do not touch the scheduler connection. **V**
- Tenant hosts run `ghcr.io/di-framework/wash:2.8.0-wasi-tls` by default (`DEFAULT_HOST_IMAGE`, `platform/platform/src/index.ts:124-125`), or `2.8.0-wasi-tls-exclusive` through `tenantHostImage` (`platform/tenant-host/variants`). The design is the same for both. **V**

### 2.3 Subjects and the operator

| Direction | Subject | Source |
|---|---|---|
| host subscribes | `runtime.host.<host_id>.>` (`heartbeat`, `workload.start`, `workload.stop`, `workload.status`) | `wasmcloud: crates/wash-runtime/src/washlet/mod.rs:211-214,344-346,365-400` |
| host publishes | `runtime.operator.heartbeat.<host_id>` (plain publish, no reply) | `washlet/mod.rs:233-238,352-354` |
| host publishes | the reply to each command, to the request's reply subject | `washlet/mod.rs:241-247` |
| operator subscribes | `runtime.operator.heartbeat.>` | `wasmcloud: runtime-operator/internal/controller/runtime/host_controller.go:205` |
| operator requests | `runtime.host.<host_id>.<cmd>`, reply on a `_INBOX.` subject | `runtime-operator/internal/controller/runtime/host_client.go:31-37,84`; `runtime-operator/pkg/wasmbus/nats.go:166-175` |

- **The command subject is fixed.** wash derives the command by skipping three tokens of the subject (`washlet/mod.rs:372`), so the subject a host sees must stay `runtime.host.<host_id>.<cmd>`. **V**
- **Host IDs are random.** Each start gets a fresh UUIDv4 (`wasmcloud: crates/wash-runtime/src/host/mod.rs:1198`), so no static permission can name "tenant A's hosts". Host IDs also appear in Workload status and in logs. They are identifiers, not secrets. **V**
- **The operator trusts the payload.**
  - It decodes only the payload (`host_controller.go:211-213`). It upserts `Host/<friendlyName>` with `HostID`, `Environment` and labels copied from the payload. Its own comment says the heartbeat "is not validated against cluster state" (`host_controller.go:229-251`).
  - Placement matches `Host.Environment` against the workload namespace (`workload_controller.go:126-170`) and records `Workload.Status.HostID` and `Workload.Status.Environment` from the selected Host (`workload_controller.go:117-118`).
  - Later commands and route endpoints resolve the Host by `HostID` alone and take the first match (`workload_controller.go:195-207,383,403,437`; `workload_route_controller.go:109,280-292`). **V**
- **`Host.Hostname` comes from the payload.** It is the host pod's IP, because hosts run with `--host-name=$(WASMCLOUD_HOST_IP)` (`resources.ts:1497`; `chart: templates/runtime/deployment.yaml:192`). It drives the host pod finalizer (`host_pod_controller.go:81-110`) and HTTP route endpoints (`workload_route_controller.go:114-140`). **V**
- **`workload.start` carries the workload's resolved configuration, including Secret values** (`runtime-operator/internal/controller/runtime/utils.go:82-94,158-180`). **V**
- **The scheduler bus carries no tenant data or messaging traffic.** That traffic goes to each tenant's own `di-nats`, which this design does not change (`platform/platform/src/tenancy/registry-nats.ts:12-31,152-170`). **V**

### 2.4 Upstream position

- The chart's values call cross-tenant scheduling "permissive" and offer `allowSharedHosts=false` as the namespace boundary (`chart: values.yaml:165-180`). The heartbeat comment above shows that the operator does not authenticate the environment. **V**
- Three further points come from the owner's reading of upstream and were not re-checked for this note. **U**
  - The wasmCloud v2 documentation defines no tenant boundary on the scheduler bus.
  - wasmCloud v1's multi-tenant guidance was one NATS account per tenant.
  - runtime-operator and wash 2.9 change nothing here.

### 2.5 Conclusion

Tenants have no distinct NATS identity, and the operator ties neither a heartbeat nor a host ID to its sender. Per-tenant certificates mapped to restricted users would still not be enough. A subject permission cannot name a tenant's hosts, and the operator would still accept a misattributed heartbeat and resolve hosts by ID alone. The design therefore changes three things together:
- the broker's accounts;
- the subjects the operator sees, through server-side mapping;
- the operator's acceptance and addressing rules.

## 3. Target properties

- **P1 Broker-level isolation.** Credentials issued to tenant A cannot publish or subscribe to any subject that carries tenant B's scheduler traffic. Either the broker refuses with an explicit permission violation, or A's account has no route to B. The property does not depend on network policy.
- **P2 Heartbeats and host IDs bind to one environment.** A heartbeat is attributed to the environment of the account that sent it, and the server adds that environment. The operator accepts the heartbeat only if all of these hold:
  - the payload's environment and host ID match the subject;
  - the reported hostname is the IP of a running host pod in a namespace that maps to that environment;
  - neither the host ID nor the Host name is already bound to another environment.

  A host ID, a Host and a host pod therefore each belong to exactly one environment for their lifetime.
- **P3 Secrets reach only the target tenant.**
  - Every `workload.start`, `workload.status` and `workload.stop` is addressed with the environment recorded on the Workload at placement, never with an environment derived from a host ID. It is delivered only into that environment's account, so only that tenant's host identity can receive it.
  - Lookups by host ID that match more than one Host are refused.
  - The server does not log message payloads.
- **P4 Least privilege for every identity.** Each user can publish and subscribe only to the subjects its role needs (4.3). No identity other than the operator's reaches another account's traffic.
- **P5 Independent lifecycle and prompt revocation.**
  - Issuing, rotating or removing one tenant's identity reloads the server without disconnecting any other tenant.
  - Removing a tenant, or force-rotating its identity, revokes the old identity in the next reload: its connections are dropped and its certificate is refused, while the certificate is still valid.
  - A routine renewal keeps the previous identity for at most 10 minutes while hosts roll, then revokes it the same way.
  - No identity outlives its record until certificate expiry.
- **P6 No shared secrets in tenant namespaces.** A tenant runtime namespace holds only that tenant's own key and the public CA bundle that verifies the server.
- **P7 Issuance cannot escape its scope.** The CA that signs tenant certificates can sign only names inside the tenant subtree. Neither a bug nor a stolen tenant CA key can produce the operator's or the platform's identity.

## 4. Design

### 4.1 The scheduler NATS leaves the chart

The Helm values below are enforced in `platformValues` (`platform/platform/src/values.ts:2-17`), the same way `hostNamespaces` and `allowSharedHosts` are, so `args.values` cannot undo them. All are **V** against a `helm template` render of chart 2.8.0 with these values. The render shows:
- the image reference `ghcr.io/di-framework/runtime-operator:2.8.0-tenant-bus@sha256:…`;
- no NATS resources, no `wasmcloud-ca` and no generated certificates;
- per-namespace Roles, with only the metrics ClusterRoles remaining.

| Value | Setting | Effect |
|---|---|---|
| `nats.enabled` | `false` | The chart renders no NATS Deployment, Service, ConfigMap or policy (`chart: templates/nats/*.yaml:1`). |
| `global.tls.enabled` | `true` (unchanged) | The operator and hosts still mount client certificates and pass the TLS flags, including `ca.crt` (`chart: templates/operator/deployment.yaml:41-45`, `templates/runtime/deployment.yaml:195-205`). |
| `global.certificates.generate` | `false` | The chart generates no CA and no certificates (`chart: templates/certificates.yaml:2`). |
| `global.certificates.{operator,runtime,data}CertSecretName` | `di-scheduler-operator-tls`, `di-scheduler-platform-host-tls`, `di-scheduler-data-tls` | The chart mounts the platform-issued Secrets (`chart: values.yaml:36-41`). The new names mean nothing can confuse them with the chart's former certificates. |
| `operator.image` | repository `di-framework/runtime-operator`, tag `2.8.0-tenant-bus@sha256:<digest>` | The patched operator (4.6). The chart renders `<registry>/<repository>:<tag>` (`chart: templates/operator/deployment.yaml:39`). |
| `operator.watchNamespaces` | the platform namespace plus every tenant namespace `di-tenant-<t>` | Replaces the chart ClusterRole's cluster-wide Secret read with namespaced Roles (`chart: templates/operator/clusterrole.yaml:1`, `workload-namespace-role.yaml:1-30`). |
| `operator.extraArgs` | `-host-namespace-environments=di-runtime-<t>=di-tenant-<t>,…` | The patched operator's map from host namespace to environment (4.6, item 3). It is passed through the chart's `extraArgs` (`chart: templates/operator/deployment.yaml:57-59`). |

**Operator restarts.** `-watch-namespaces` (`wasmcloud: runtime-operator/cmd/main.go:118,252-255`), `-host-namespaces` (`chart: templates/operator/deployment.yaml:50-51`) and the new mapping flag are all process flags. Adding or removing a tenant therefore changes the operator Deployment and restarts it. This already happens today through `hostNamespaces`, so the design adds no new kind of restart. The mitigation is the existing lifecycle (`platform/platform/src/watched-namespaces.ts:150-200`):
- all three lists are computed from the same Tenant list in the same `up`;
- a Tenant that is being deleted keeps `di-tenant-<t>`, `di-runtime-<t>` and its mapping until the Tenant is gone, so Workload and host pod finalizers can still run;
- the operator runs one leader-elected replica and keeps its state in Host and Workload objects, so a restart costs a few seconds of reconciliation, and hosts re-announce on their next heartbeat.

**What stays the same.** The chart's default `schedulerUrl` already resolves to `nats://nats.<release-namespace>.svc.cluster.local:4222` (`chart: templates/_helpers.tpl:172`), and tenant hosts use the same URL (`platform/platform/src/tenancy.ts:297`). The platform-owned server therefore keeps the Service name `nats`, port 4222 and the pod label `wasmcloud.com/name: nats`. These are what the following policies select:
- the platform's policies (`platform/platform/src/platform-ingress.ts:56-77`, `platform/platform/src/tenancy.ts:213-247`);
- the vCluster target's `allow-platform-nats` policy (`platform/operator/internal/targets/vcluster/networkpolicy.go:193`).

No client changes its URL. The #552 post-renderer (`postrender` on the wasmcloud release) is removed with the chart's NATS.

**Pulumi-managed resources** in the platform namespace, created before the Helm release:
- **Deployment `nats`**:
  - one replica, image `nats:2.12.8-alpine` pinned by digest;
  - arguments `-c /etc/nats/nats-server.conf` only, with no `-D` or `-V`;
  - the chart's hardened pod and container security context (`chart: values.yaml:74-92`) and `automountServiceAccountToken: false`;
  - `shareProcessNamespace: true` for the reloader;
  - it mounts the two ConfigMaps below and Secret `di-scheduler-nats-tls`, and the accounts ConfigMap is mounted as required.
- **Container `reloader`**: the upstream `nats-server-config-reloader` image, pinned by digest. It watches the config, the accounts file and the server certificate, and it signals the server through the shared process namespace and the server's `pid_file`. **U**: its flags come from the upstream NATS Helm chart.
- **ConfigMap `di-scheduler-nats`**: the static `nats-server.conf`. It sets:
  - `port` and `pid_file`;
  - a `tls` block with `verify_and_map: true` and the server certificate;
  - `ca_file`, the bundle of the platform CA and the tenant CA, current and next of each (4.5);
  - `include "accounts/accounts.conf"`.

  Only `pulumi up` changes it.
- **Service `nats`**, port 4222, and a ServiceAccount without a token.
- **Namespace `<platform-ns>-scheduler-pki`** for the CA keys and the identity record (4.5).
- **JetStream** is enabled at server level with the same `emptyDir` store as today (`chart: templates/nats/deployment.yaml:37-38,59-60`), for the `DATA` account only (4.7, O6).

**ConfigMap `di-scheduler-nats-accounts` is not a Pulumi resource.** Pulumi never declares it, so a `pulumi up` cannot reset it and drop tenant accounts. The bootstrap Job creates it if it is missing (4.5). From then on the platform controller is its only writer (4.4). The Deployment only mounts it.

### 4.2 Accounts

| Account | Users | Purpose |
|---|---|---|
| `SCHEDULER` | the operator (`operator.platform.scheduler.di-framework.invalid`) | Receives heartbeats and sends commands, through imports only. |
| `HOSTS_<env>`, one per tenant, `<env>` = `di-tenant-<t>` | the tenant's current host identity, plus the previous one during a routine renewal (4.5) | That tenant's hosts. |
| `HOSTS_<platform-ns>` (default `HOSTS_wasmcloud`) | `host.platform.scheduler.di-framework.invalid` | The platform's own host group, `hostgroup-default` (4.7). |
| `DATA` | `data.platform.scheduler.di-framework.invalid` | The data connection of `hostgroup-default`. It has no imports or exports, so it cannot see scheduler traffic. |

`<env>` is the host's `--environment`:
- for tenant hosts, the tenant namespace `di-tenant-<t>` (`resources.ts:1499`, `names()` at `resources.ts:878-885`);
- for `hostgroup-default`, the pod's own namespace (`chart: templates/runtime/deployment.yaml:139-142,194`).

Every value is a DNS label (`validName`, `resources.ts:886-890`), so it is a valid single NATS subject token. The renderer refuses a tenant whose environment equals the platform namespace.

### 4.3 Permissions, exports, imports, mappings and limits

The shape of `accounts.conf` for one tenant `a` follows. Appendix A has the complete configuration the probe ran, with two tenants and the platform host group. Each further host account adds the same `HOSTS_` block and two imports to `SCHEDULER`.

```
accounts {
  SCHEDULER: {
    users: [
      { user: "operator.platform.scheduler.di-framework.invalid",
        permissions: {
          publish:   { allow: ["runtime.host.*.*.>"] }
          subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] }
        } }
    ]
    imports: [
      { stream:  { account: "HOSTS_di-tenant-a", subject: "runtime.operator.heartbeat.*" },
        to: "runtime.operator.heartbeat.di-tenant-a.*" }
      { service: { account: "HOSTS_di-tenant-a", subject: "runtime.host.*.>" },
        to: "runtime.host.di-tenant-a.*.>" }
    ]
  }
  HOSTS_di-tenant-a: {
    limits: { max_connections: <2 x replicas + 2>, max_subscriptions: 64, max_payload: 1048576 }
    users: [
      { user: "<issuance-id>.di-tenant-a.tenants.scheduler.di-framework.invalid",
        permissions: {
          publish:   { allow: ["runtime.operator.heartbeat.*"] }
          subscribe: { allow: ["runtime.host.*.>"] }
          allow_responses: { max: 1, expires: "2m" }
        } }
    ]
    exports: [
      { stream:  "runtime.operator.heartbeat.*", accounts: ["SCHEDULER"] }
      { service: "runtime.host.*.>",             accounts: ["SCHEDULER"] }
    ]
  }
  DATA: { jetstream: enabled, users: [ { user: "data.platform.scheduler.di-framework.invalid" } ] }
}
```

How the pieces give the properties:

- **Heartbeats (P2).** A host publishes `runtime.operator.heartbeat.<host_id>` in its own account. The stream import maps it to `runtime.operator.heartbeat.<env>.<host_id>` in `SCHEDULER` (`nats-server: server/accounts.go:2644-2690`, `server/opts.go:3774-3794`). The host's publish permission is exactly one token after the prefix, so it cannot add tokens that would look like another environment. **P**
- **Commands (P1, P3).** The operator requests `runtime.host.<env>.<host_id>.<cmd>`. The service import for `<env>` matches only that environment's token, and it delivers into that account as `runtime.host.<host_id>.<cmd>` (`server/accounts.go:2051-2110`, `server/opts.go:3795-3810`). That is exactly the subject wash parses (`washlet/mod.rs:372`). The reply returns through the service import's response mapping. **P**
- **Replies.** A host may publish only to the reply subjects of requests it received (`allow_responses`, `nats-server: server/client.go:3876-3884,4153-4166`). A publish to another tenant's reply subject is refused. `expires` is twice the operator's one-minute round-trip timeout (`host_client.go:17`). **P**
  - With `max: 1`, two subscriptions on one connection that both match a request use up the single reply between them.
  - wash has one subscription per host connection (`washlet/mod.rs:211-214`), so this does not affect it.
- **Isolation (P1).** Host accounts share nothing with one another. A tenant user can subscribe to `runtime.host.*.>`, but in its own account that matches only its own hosts' commands. Everything else is refused with `Permissions Violation`, including `>`, `_INBOX.>`, the heartbeat subjects, any `runtime.host.` publish and `$JS.API.>`. **P**
- **The operator (P4)** can only send commands and read heartbeats and its own replies. It is the one identity that reaches every host account, and it does so through the imports. It needs no JetStream and has none.
- **Availability.** Account `limits` (`nats-server: server/opts.go:3400-3425,3619`) cap one tenant's connections, subscriptions and payload size, so one tenant cannot exhaust the shared server. Two connections per replica leave room for a rolling replacement. **V** for the config keys. **U** for the sizes, which the implementation tunes against Layer 3.

What a tenant host's identity can reach, in full: publish its own heartbeat, receive commands addressed to its own tenant's hosts, and reply to them. All hosts of one tenant share one identity. The boundary is the tenant (5).

### 4.4 Who renders the accounts file, and how it is reloaded

- **Owner.** The platform controller is the only writer of `di-scheduler-nats-accounts` after bootstrap.
  - It renders `accounts.conf` from the full Tenant list and the identity record (4.5) on each pass, never incrementally.
  - Accounts, users and imports are sorted, so an unchanged state renders identical bytes and causes no write and no reload.
  - A removed Tenant always drops out.
- **Inputs.** The Tenant list, each tenant's current and previous issuance IDs from the identity record, and the platform namespace. Nothing comes from tenant-writable input.
- **Validation.** Before writing, the controller checks:
  - each tenant user name against `^[0-9a-f]{16}\.di-tenant-<t>\.tenants\.scheduler\.di-framework\.invalid$`;
  - that all user names are unique;
  - that every account and token is valid.

  nats-server refuses a reload with a duplicate user as a whole and keeps the previous configuration (**P**, 9). One bad entry would therefore block every later tenant change. The controller refuses to write instead and reports the offending Tenant in a condition.
- **Writes.** A write is never partial: the whole file is one ConfigMap key.
- **RBAC.** The controller's ClusterRole already covers ConfigMaps everywhere (`platform/platform/src/tenancy/install.ts:186-197`). Narrowing that ClusterRole is parked for v0.2 (4.9).
- **Reload.**
  1. The kubelet updates the mounted ConfigMap.
  2. The reloader sees the change and signals the server.
  3. nats-server applies the account changes in place. Clients of unchanged accounts stay connected, users that were removed are disconnected, and a new account's heartbeats reach the operator's existing subscription.

  **P** for the server's behaviour. **U** for the kubelet's propagation delay on the target clusters.
- **Ordering for a new or changed tenant.**
  1. The controller records the issuance and issues the certificate into `di-scheduler-tls`.
  2. It writes the accounts file.
  3. It creates or rolls the host Deployment.

  If a host starts before the server has reloaded, its first connect is refused, and the pod restarts with back-off until the account exists. **U**: `connect_nats` returns the connect error (`washlet/mod.rs:339-341`), but that wash then exits needs confirming. Layer 4 measures the delay (8.4, step 12).

### 4.5 Credentials: CAs, issuance, record, lifetimes and rotation

**Two CAs, both owned by the platform** (O2):

| CA | Signs | Name constraints (critical) |
|---|---|---|
| Platform scheduler CA | the NATS server certificate, the operator, `hostgroup-default` and the `DATA` user | DNS names `platform.scheduler.di-framework.invalid` and the four `nats` Service names (`nats`, `nats.<ns>`, `nats.<ns>.svc`, `nats.<ns>.svc.cluster.local`, as in `chart: templates/certificates.yaml:70-75`); IP addresses excluded |
| Tenant scheduler CA | tenant host certificates only | DNS, email and URI names only under `tenants.scheduler.di-framework.invalid`; IP addresses excluded |

- **No tenant-CA certificate can carry a platform user name.** nats-server maps a client certificate to a user by email SAN, then DNS SAN, then URI SAN, then subject DN (`nats-server: server/auth.go:1267-1340`). The tenant CA is constrained in every SAN form, and no user name is DN-shaped. The TLS handshake refuses a tenant-CA certificate that names the operator by DNS or email SAN, and a certificate with only a subject maps to no user. **P**
- **Clients get only the platform CA.** `ca_file` is the bundle of both CAs. Clients receive only the platform CA, which they use to verify the server.
- **The names never resolve.** `.invalid` (RFC 2606) guarantees that these identity names never resolve and cannot be confused with a server name.
- **`tls.ts` needs three additions.** `platform/platform/src/tenancy/tls.ts` already writes CA certificates with DNS name constraints and an IP exclusion (`tls.ts:83-110,247-260`). It needs a permitted email subtree, a permitted URI subtree and a client-auth leaf. `leafCertificate` sets only `serverAuth` (`tls.ts:389`), and nats-server is built in Go, whose TLS server checks client certificates for `clientAuth`. **V** for the code; **U** for the EKU check in this note, which is standard Go `crypto/tls` behaviour.

**Identities:**

| Identity | NATS user (DNS SAN) | Secret (keys) | Mounted by |
|---|---|---|---|
| NATS server | the `nats` Service names | `di-scheduler-nats-tls` (platform ns: `tls.crt`, `tls.key`, `ca.crt`) | `nats` |
| Operator | `operator.platform.scheduler.di-framework.invalid` | `di-scheduler-operator-tls` (platform ns: `tls.crt`, `tls.key`, `ca.crt`) | `runtime-operator` |
| Platform host group | `host.platform.scheduler.di-framework.invalid` | `di-scheduler-platform-host-tls` (platform ns: `tls.crt`, `tls.key`, `ca.crt`) | `hostgroup-default` |
| Platform data | `data.platform.scheduler.di-framework.invalid` | `di-scheduler-data-tls` (platform ns: `tls.crt`, `tls.key`, `ca.crt`) | `hostgroup-default` |
| Tenant `<t>` hosts | `<issuance-id>.di-tenant-<t>.tenants.scheduler.di-framework.invalid` | `di-scheduler-tls` (`di-runtime-<t>`: `tls.crt`, `tls.key`, `ca.crt`) | `hostgroup-tenant-<t>` |
| Both CA keys | none | `di-scheduler-ca` (`<platform-ns>-scheduler-pki`) | **no pod** |
| Identity record | none | ConfigMap `di-scheduler-identities` (`<platform-ns>-scheduler-pki`) | **no pod** |

- **`ca.crt` is the platform CA bundle everywhere.** The chart mounts `ca.crt` from each platform Secret (`chart: templates/operator/deployment.yaml:43`, `templates/runtime/deployment.yaml:197,203`). The NATS server's `ca_file` is a separate key of its Secret and holds both CAs.
- **`<platform-ns>-scheduler-pki` holds only the CA keys and the identity record.**
  - It is in neither `watchNamespaces` nor `hostNamespaces`, so the runtime-operator cannot read it, and no WorkloadDeployment `secretFrom` can name anything in it.
  - No pod runs there except the bootstrap Job, which mounts nothing from it. On the vCluster target its Secrets therefore stay out of the host namespace, because vCluster syncs only Secrets a pod uses (`vcluster: values.yaml:26-30`). **V**
  - The platform controller reads it (cluster-wide).
- **The identity record.** `di-scheduler-identities` holds one entry per tenant: `{ current: <issuance-id>, previous?: <issuance-id>, previousUntil?: <time> }`. The issuance IDs are not secret.
  - The controller writes the record before it issues a certificate or renders accounts. It never reads identities back from tenant namespaces.
  - `<issuance-id>` is 16 random hex characters, new for every certificate. A user name therefore names exactly one certificate. Re-creating a tenant with the same name produces a new user.

**Revocation and rotation** (P5):

- **Removal.** When a Tenant is deleted, its entry and its account leave the next render. The reload disconnects its hosts, and its certificate is refused from then on. **P**
- **Forced rotation (suspected compromise).** Either changing the Tenant annotation `platform.di-framework.dev/rotate-scheduler-identity` or deleting `di-scheduler-tls` starts one. The controller:
  1. records a new current ID with no previous;
  2. issues the new certificate;
  3. renders accounts without the old user;
  4. rolls the hosts.

  The old identity is refused from that reload on, and the tenant's hosts reconnect with the new certificate when they roll. This is the same pattern as deleting the registry pull Secret, which rotates its token (`controller.ts:735-739`).
- **Routine renewal.** The controller:
  1. records the new current ID and sets `previous`, with `previousUntil` = now + 10 minutes;
  2. issues the certificate;
  3. renders both users;
  4. rolls only that tenant's host Deployment, through a certificate-digest pod annotation (the pattern used for the registry CA, `resources.ts:1456-1466`).

  It drops `previous` as soon as the rollout has finished (`observedGeneration` current and all replicas updated and ready, as the readiness gate at `controller.ts:1028-1042` checks), or at `previousUntil`, whichever comes first.

**Lifetimes** (O3):
- **CAs.** 10 years, rotated with the controller's existing CA machinery: publish a successor 90 days before expiry, trust both for 30 days, then switch (`platform/platform/src/tenancy/ca-rotation.ts:13-25,140-215`). `ca_file` and each `ca.crt` carry current and next.
- **Leaves.** 90 days, renewed when 30 days remain (`LEAF_RENEW_DAYS`, `ca-rotation.ts:20`). Revocation never waits for expiry.
- **Operator renewal needs no restart.** nats.go reloads the client certificate files on every TLS handshake (`nats.go: nats.go:1212-1234`; the operator uses `nats.ClientCert`, `wasmcloud: runtime-operator/cmd/main.go:189`). **V**
- **`hostgroup-default` renewal.** The controller restarts that Deployment through a pod-template annotation, because wash's behaviour on reconnect was not checked. **U**: that Helm keeps an annotation it did not render.
- **Server renewal.** The reloader sees the Secret change and the server reloads its certificate.

**Bootstrap** (O4):
- **Why a Job.** The `nats` Deployment, the operator and `hostgroup-default` must be ready before the Helm release finishes (`atomic: true`, `index.ts:377`), and the platform controller is deployed after the release.
- **What it does.** A one-shot Job runs in `<platform-ns>-scheduler-pki`. It uses the platform controller's image and code with a `scheduler-pki` entry point. If they are missing, it creates:
  - `di-scheduler-ca` and `di-scheduler-identities`;
  - the four platform leaf Secrets in the platform namespace;
  - `di-scheduler-nats-accounts`, with no tenants.

  It overwrites nothing that exists. No key ever enters Pulumi state.
- **Ordering.** The NATS Deployment and the Helm release both declare `dependsOn` on the Job. **U**: that the Pulumi Kubernetes provider awaits the Job's completion and not only its creation. If it does not, the Job is wrapped in an explicit wait.
- **Its RBAC, stated as it really is.** RBAC `resourceNames` cannot restrict `create`. The Job's ServiceAccount therefore holds namespace-wide `create` on Secrets and ConfigMaps in `<platform-ns>-scheduler-pki` and in the platform namespace, plus `get` limited by `resourceNames` to the objects above. This wider grant is accepted explicitly:
  - The ServiceAccount has no long-lived token, and only the Job's pod receives a token for it.
  - The Job sets `ttlSecondsAfterFinished`, so that token ends with the pod.
  - Only principals who can already create Secrets in those namespaces (instance admin and the platform controller) can run a pod as that ServiceAccount.

  So the grant gives no new principal a capability it did not already have.

### 4.6 The runtime-operator patch

**Scope.** One patch, `0001-tenant-scheduler-bus.patch`, against `wasmcloud: runtime-operator/`:

1. **Heartbeat subject.**
   - `hostStatusUpdater` passes `msg.Subject` (`wasmcloud: runtime-operator/pkg/wasmbus/bus.go:78-83`) to `handleHeartbeat` (`host_controller.go:211-213`).
   - It accepts only `runtime.operator.heartbeat.<env>.<host_id>`, exactly five tokens, with `<host_id>` a canonical lowercase UUID. A wildcard character published by a host arrives as a literal token and is rejected.
   - `msg.Reply` is ignored, so the operator never publishes to a reply subject a host chose.
   - Anything rejected is dropped, logged and counted.
2. **Payload agreement.** The heartbeat is rejected unless `req.Environment == <env>` and `req.Id == <host_id>`.
3. **Pod binding.** `req.Hostname` must be the IP of exactly one host pod. The patch looks the pod up explicitly; it does not use the route controller's resolver, which passes IP addresses through unchecked. The pod must meet all of these conditions:
   - it carries the label `wasmcloud.com/hostgroup` (`host_pod_controller.go:27`) and runs in one of the operator's host namespaces (already in its cache);
   - its `status.podIP` or one of its `status.podIPs` equals `req.Hostname`;
   - its phase is `Running` and it has no `deletionTimestamp`.

   The pod's environment comes from its namespace through `-host-namespace-environments` (4.1). A namespace without an entry maps to itself, which covers `hostgroup-default`. That environment must equal `<env>`. No pod label is consulted, so a principal that can create or patch pods in a host namespace cannot choose the environment. The flag is set only through the operator's Deployment.
4. **One environment per host ID, Host and pod.** The Host gets the label `runtime.wasmcloud.dev/bus-environment=<env>` from the subject. That label overrides any label of the same name copied from the payload (`host_controller.go:246`). The heartbeat is rejected when any of these holds:
   - **(a)** a Host with this name exists with another `bus-environment`;
   - **(b)** a Host with this host ID exists under another name or with another `bus-environment` (through the existing `HostID` index);
   - **(c)** another live Host is already bound to this pod IP in another environment.

   A new host ID for the same pod in the same environment, as after a container restart, replaces the previous one, so each pod has at most one live Host.
5. **Addressing by placement, not by ID.**
   - `NewWashHostClient` takes the environment, and subjects become `runtime.host.<env>.<host_id>.<cmd>` (`host_client.go:19-37`).
   - `workload.start`, `workload.status` and `workload.stop` (`workload_controller.go:383,403,437`) use `Workload.Status.Environment`. It is set at placement from the selected Host's `Environment` (`workload_controller.go:117-118`), which items 1-4 have verified. A Workload with an empty `Status.Environment` gets no command.
   - The host heartbeat command (`host_controller.go:61`) uses the `bus-environment` label of the Host it is reconciling, which it got by name.
   - No command derives its environment from a host ID.
6. **Ambiguous lookups are refused.**
   - `lookupHostByID` (`workload_controller.go:195-207`) and the route controller's `findHostByID` (`workload_route_controller.go:280-292`) filter by `bus-environment == Workload.Status.Environment`.
   - Either one returns an error when more than one Host matches, instead of taking `Items[0]`.
   - Route endpoints therefore come only from a Host in the Workload's own environment.
7. **No compatibility path.** The patched operator has no switch back to unprefixed subjects and no fallback.

**Unit tests in the patch.** One for each rejection:
- subject shape, a non-UUID host ID, and a reply subject that is ignored;
- a payload mismatch;
- no matching pod, a terminating pod, and a pod in another environment;
- name takeover, host-ID reuse across environments, and a pod bound to another Host.

They also cover:
- command subjects taken from `Status.Environment`;
- refusal of an ambiguous lookup by ID, in both the workload and the route controller.

**Where the fork lives and how it is built**, mirroring `platform/tenant-host/`:
- **`platform/runtime-operator/`** holds the patch, a README and a `Dockerfile`. The Dockerfile:
  - clones wasmCloud at the tag and fails unless `HEAD` is the pinned commit;
  - runs `git apply --check`, then applies the patch;
  - builds `./runtime-operator/cmd` as upstream's Dockerfile does (`wasmcloud: runtime-operator/Dockerfile`);
  - pins the build and runtime base images by digest, as in `platform/tenant-host/Dockerfile:15-58`.

  With a single variant there is no `variants` table. The image tag is `2.8.0-tenant-bus`.
- **`.github/workflows/runtime-operator-image.yml`**, modelled on `tenant-host-image.yml`:
  - it triggers on pushes to `main` that change `platform/runtime-operator/**` or the workflow;
  - it skips a source that is already published (`src-<hash>`, `scripts/source-check.ts`);
  - it builds amd64 and arm64 on native runners and merges the index;
  - it opens a `bot/pin-runtime-operator` PR.
- **`.github/workflows/runtime-operator-patch-check.yml`**, modelled on `tenant-host-patch-check.yml`, runs on pull requests:
  - it applies the patch to the pinned commit;
  - it runs `go test ./internal/controller/runtime/...` with envtest assets: `setup-envtest` at `release-0.19` and Kubernetes `1.31.0`, both pinned, as upstream's Makefile does (`wasmcloud: runtime-operator/Makefile:4,64,181-187`), with `KUBEBUILDER_ASSETS` exported;
  - it runs the broker test (8.2).
- **`scripts/pin-artifact.ts`** gets a `runtime-operator` artifact (`ARTIFACTS`, `scripts/pin-artifact.ts:70`). It rewrites the operator image constant in `platform/platform/src/index.ts` and the pinned reference in the fork's README.

The patch has no di-framework concepts. The environment token and the namespace-to-environment map are generic, so it is worth offering upstream once it ships (O8).

### 4.7 `hostgroup-default` and the operator's own identity

- **`hostgroup-default` stays** (O1). It serves the platform namespace (`platform/platform/src/index.ts:425-439`, `wasmcloud-http`) and is treated like a tenant:
  - its own account `HOSTS_<platform-ns>`, with the same host permissions, limits and mappings;
  - the platform namespace as its environment token, mapped to itself;
  - its own certificate from the platform CA.

  The patched operator applies the same rules to it, and no unprefixed path is left for anyone.
- **Its data connection** uses the `DATA` user, in an account with no imports or exports, so it can no longer see scheduler subjects. That account keeps JetStream, so any NATS key-value or blobstore use on `hostgroup-default` keeps working (O6). Whether anything uses it is not known.
- **The operator** keeps the chart's Deployment, flags and mount path (`chart: templates/operator/deployment.yaml:31-45`). Only the Secret (`di-scheduler-operator-tls`), the image and the added mapping flag change. Its user is alone in `SCHEDULER`, with the permissions in 4.3.

### 4.8 Tenant hosts

- `controller.ts:994-996` stops reading `wasmcloud-runtime-tls`, and the controller issues the tenant certificate instead (4.5). The host readiness gate (`controller.ts:1028-1042`) requires that certificate where it now requires the copied Secret.
- `di-scheduler-tls` holds only the tenant's own key and certificate and the platform CA bundle (P6). Flags, mount path and URL stay the same (`resources.ts:1495-1505,1548,1573`).
- The host pod template gets the certificate-digest annotation (4.5). It needs no environment label: the operator derives a host pod's environment from its namespace (4.6, item 3).
- A pod that mounts `di-scheduler-tls` holds one tenant's identity, not the platform's.

### 4.9 Platform-side exposure on the vCluster target: closed or parked

Each item is listed by exposure class. It is either closed by this work or parked for v0.2.

| Exposure class | Decision |
|---|---|
| Message payloads in scheduler NATS logs | **Closed.** #552 removes the flags for the chart's server. The platform-owned server runs without `-D`/`-V` (4.1). |
| Runtime-operator Secret read beyond the namespaces it serves | **Closed.** `operator.watchNamespaces` covers the platform namespace and the tenant namespaces, and the chart binds namespaced Roles instead of its ClusterRole (4.1). The CA keys are in `<platform-ns>-scheduler-pki`, which the operator does not watch (4.5). |
| Virtual ServiceAccount token placement on synced pods | **Closed.** The operator's vCluster values set `sync.toHost.pods.useSecretsForSATokens: true` (`vcluster: values.yaml:46-48`; `platform/operator/internal/targets/vcluster/defaults.go:30-60`) for every synced pod. That includes the runtime-operator and the platform controller, which is the CA issuer. **U**: the effect on existing operator tests and on a running instance. |
| The shared platform key in tenant runtime namespaces and their synced copies | **Closed.** Each tenant's copy is only its own identity (P6). |
| CA keys in synced Secrets or in Helm manifests | **Closed.** No pod mounts a CA key, and no key is in a Helm manifest (4.5). |
| Synced platform identities that pods must mount, and host-side RBAC in `pi-*` | **Parked for v0.2.** vCluster must sync the Secrets pods mount. Host `edit`/`admin` in a `pi-*` namespace is equivalent to instance admin, and this design does not change that. |
| Instance-admin and host-admin capabilities (admin kubeconfig, state store, node access) | **Unchanged by design.** Instance owners are trusted in v1alpha1, and these capabilities are outside the scheduler bus. |
| The platform controller's cluster-wide Secret read | **Parked for v0.2.** The controller is the issuer, and narrowing its RBAC is a separate change. |

## 5. Non-goals

- **Isolation between hosts of the same tenant.** All of a tenant's hosts share one identity. The tenant is the isolation unit #541 asks for.
- **Changes to `di-nats`**, the per-tenant data bus (2.3).
- **End-to-end encryption of `workload.start` payloads.** The broker sees plaintext. P3 limits who can receive them.
- **Patching wash.** The scheduler connection needs no change, because the server maps the subjects.
- **Migration, rollout phases, compatibility, and release notes.** This covers unpatched operators and the chart's certificates (owner direction). Existing development instances are reinstalled.

## 6. Code that changes when this is implemented

- `platform/platform/src/index.ts`, `values.ts`: chart values (4.1), the operator image constant, `watchNamespaces`, and the namespace-to-environment flag. Also the NATS resources, the PKI namespace, and the bootstrap Job and its RBAC, all ordered before the Helm release. The `postrender` from #552 is removed.
- `platform/platform/src/watched-namespaces.ts`: the tenant-namespace and mapping lists, with the same lifecycle as `hostNamespaces`.
- `platform/platform/src/tenancy/tls.ts`: email and URI name constraints, and a client-auth leaf.
- `platform/platform/src/tenancy/`: a new `scheduler-nats.ts`, plus changes to `controller.ts` and `resources.ts`. Together they cover the identity record, issuance and rotation, the accounts renderer and its validation, the certificate-digest annotation, and removal of the `wasmcloud-runtime-tls` copy.
- `platform/runtime-operator/` (new), `.github/workflows/runtime-operator-image.yml`, `.github/workflows/runtime-operator-patch-check.yml`, `scripts/pin-artifact.ts`.
- `platform/operator/internal/targets/vcluster/defaults.go`: `useSecretsForSATokens`.
- `platform/platform/README.md`: the scheduler bus and its identities.

## 7. Considered and rejected

- **Per-tenant certificates mapped to restricted users in one account.** Host IDs are random, so no permission can name a tenant's hosts, and the operator would still trust the payload (2.5).
- **Auth callout (NATS 2.10 and later)** in the controller, minting scoped user JWTs from the client certificate. It needs no config reloads, but it puts a service in the authentication path of every connection. It would still need the mappings and the operator patch. Static accounts are simpler at this scale.
- **Operator mode with NKeys or creds files.** wash has no creds option for the scheduler bus (`host.rs:21-39`), so this would need a wash patch.
- **A tenant token in the subjects hosts publish.** wash builds its subjects itself (`washlet/mod.rs:344-354`), so this would need a wash patch, and a token the client chooses proves nothing. Server-side mapping needs neither.
- **One CA for every identity.** It works, but a bug in tenant issuance could then mint a platform name. Two CAs with name constraints bound the damage for little extra code (O2).
- **A pod label as the source of a host's environment.** Anyone who can create or patch pods in a host namespace could set it. The namespace mapping in an operator flag cannot be set that way (4.6, item 3).
- **Resolving the environment from Namespace labels in the operator.** That would need new cluster-scoped RBAC for the operator. The flag carries the same information.

## 8. Verification

### 8.1 Unit tests (`bun test` in `platform/platform`)

- **Accounts renderer.**
  - One account per tenant, plus the three platform accounts.
  - Exact permissions and limits, and two imports per host account with the right tokens.
  - Sorted, byte-stable output.
  - A removed Tenant disappears. `previous` is present only during a routine renewal and never after `previousUntil`. A forced rotation renders no previous user.
  - The user-name pattern and uniqueness are enforced, and an invalid or colliding entry blocks the write with a condition.
  - The rendered output is shared with the broker test as a golden file.
- **Identity record and issuance.**
  - The record is written before issuance, and every issue gets a new ID.
  - Leaves carry the client-auth EKU and the SAN form.
  - Both CAs carry their name constraints, so the tenant CA refuses a platform name.
  - Lifetimes and the renewal threshold are correct.
  - Every platform Secret carries `ca.crt`, and `di-scheduler-tls` holds only the tenant's key and the platform CA bundle.
- **Chart values.**
  - `nats.enabled=false`, `generate=false`, the Secret names, the pinned operator image, `watchNamespaces` and the mapping flag are all enforced over `args.values`.
  - A `helm template` render of chart 2.8.0 asserts the image reference and that no ClusterRole other than the metrics ones remains.
  - `di-scheduler-nats-accounts` is not a Pulumi resource.
- **Controller and host pods.** The controller no longer reads `wasmcloud-runtime-tls`. Host pods carry the certificate-digest annotation.

### 8.2 Fork CI (no cluster)

- The patch applies to the pinned commit, and the operator's unit tests pass under envtest, including every rejection test of 4.6.
- **Broker test.** It runs nats-server 2.12.8 in process with the golden `accounts.conf` and freshly minted CAs, with no network policy, so only the broker's permissions are under test. It repeats the matrix of section 9:
  - connections, mapping and command delivery;
  - every refused publish and subscribe, including another tenant's `_R_` reply subject;
  - refusal of forged certificates;
  - adding a tenant by reload while the operator is subscribed, with no disconnect for others;
  - a colliding user name refusing the reload as a whole and keeping the previous configuration;
  - removal and rotation disconnecting only the affected identity, which is then refused.

### 8.3 Layer 3

Two tenants and the platform host group: hosts register, workloads are placed and run on each, and Layer 3 passes. Host objects carry the right `bus-environment` labels, and Workloads carry `Status.Environment`.

### 8.4 Layer 4, against the broker with tenant A's credentials

**Setup.** The client is a pod in `di-runtime-a`:
- it is labelled `wasmcloud.com/name=hostgroup`;
- it mounts `di-scheduler-tls` read-only;
- it runs a digest-pinned NATS CLI image.

The platform's NATS ingress rule admits that pod, so network policy cannot mask a missing broker permission. The harness creates the pod with the instance admin kubeconfig. Record the broker's exact response for each step.

1. **Refused publishes.** Publish to `runtime.host.<B-host-id>.workload.status`, `runtime.host.di-tenant-b.<B-host-id>.workload.status`, `runtime.operator.heartbeat.di-tenant-b.<id>`, `$JS.API.INFO`, and a `_R_.` reply subject observed for B. Each gets `Permissions Violation for Publish`.
2. **Refused subscriptions.** Subscribe to `>`, `runtime.operator.heartbeat.>` and `_INBOX.>`. Each gets `Permissions Violation for Subscription`.
3. **Non-delivery within A's own subject space.**
   - Subscribe to `runtime.host.*.>`, which is allowed in A's own subject space.
   - While that subscription is open, deploy a workload in tenant B whose `secretFrom` value is a unique marker, and one in tenant A.
   - A's subscription receives A's `workload.start` (positive control) and nothing with B's marker.

   For this subject the boundary is the account, not a permission, so the evidence is non-delivery plus the control.
4. **Rejected heartbeats.** Publish heartbeats that:
   - claim B's environment in the payload;
   - reuse a host ID currently registered in tenant B;
   - report the IP of one of B's host pods, or an IP that belongs to no host pod.

   For each, the operator logs and counts the rejection. No Host for that ID appears or changes, B's Host keeps its environment and host ID, and no B workload is placed on or addressed to it.
5. **Forced rotation.** Force a new identity for A.
   - A's old certificate gets `Authorization Violation` from that reload on.
   - A's hosts roll and keep scheduling.
   - Tenant B shows no reconnect and no restart.
6. **Routine renewal.** Renew A's certificate. The previous user is gone once the rollout finishes, and in any case within 10 minutes.
7. **Removal.** Delete tenant B.
   - B's hosts are disconnected, and B's certificate gets `Authorization Violation`.
   - A shows no reconnect and no restart, and still schedules.
8. **Keys and Secrets.** `di-scheduler-tls` in A and in B have different public-key fingerprints. No `wasmcloud-runtime-tls` and no `wasmcloud-ca` exist.
9. **Logs.** The NATS pod's log has no `MSG_PAYLOAD` lines after a deploy.
10. **Operator RBAC.** `kubectl auth can-i get secrets --as=system:serviceaccount:<platform-ns>:<runtime-operator-sa>` gives:
    - `no` in `di-runtime-a`, `kube-system` and `<platform-ns>-scheduler-pki`;
    - `yes` in `di-tenant-a`.
11. **Token annotations.** On the vCluster target, no synced pod in the instance's `pi-*` namespace carries a `vcluster.loft.sh/token-*` annotation. Check explicitly the platform controller, the runtime-operator, `hostgroup-default` and a tenant host.
12. **Reload delay.** Measure the time from Tenant creation to the first registered host, which is the reload delay of 4.4.

## 9. Evidence from the design probe

**Setup.** A local program, not committed, ran nats-server v2.12.8 in process with the exact configuration in Appendix A. That configuration has:
- host accounts for `wasmcloud`, `di-tenant-a` and `di-tenant-b`, with `di-tenant-c` added by reload;
- a platform CA, and a tenant CA constrained in DNS, email and URI names with IPs excluded;
- a client certificate for each identity.

No cluster was involved. Appendix A omits the `limits` block and the `DATA` JetStream setting that 4.3 adds. Those are **V** from source, not **P**. All 33 checks passed:

- **Connections.** The operator, the tenants and the platform host connect with their certificates.
- **Mapping.** A heartbeat published as `runtime.operator.heartbeat.HA` by A arrives as `runtime.operator.heartbeat.di-tenant-a.HA`, and the platform host's arrives with `wasmcloud`. A's heartbeat with an extra token is refused.
- **Commands and replies.** Requests to `runtime.host.di-tenant-a.HA.workload.status` and to B's host each return that host's own reply. A's host sees `runtime.host.HA.workload.status`.
- **Isolation.** A's `runtime.host.*.>` subscriber, on a separate connection, received none of B's `workload.start`, while B's subscriber received its own.
- **Refusals.** For A, each of these returned `Permissions Violation`:
  - publishing to `runtime.host.HB.workload.status`, `runtime.host.di-tenant-b.HB.workload.status`, `$JS.API.INFO`, and B's `_R_.` reply subject;
  - subscribing to `runtime.operator.heartbeat.>`, `>` and `_INBOX.>`.
- **Forged certificates.** Tenant-CA certificates naming the operator by DNS SAN or email SAN failed the TLS handshake (`bad certificate`). A certificate with only a subject CN mapped to no user (`Authorization Violation`).
- **Adding a tenant by reload.** C's heartbeats reached the operator's existing subscription, and C's commands worked. A and the operator stayed connected.
- **Atomic refusal.** A reload with a duplicate user name was refused (`Duplicate user … detected`), and the previous configuration kept serving.
- **Removal.** A reload without tenant B disconnected B, and A stayed reachable. B's still-valid certificate was then refused (`Authorization Violation`).

The first run also found the `allow_responses` interaction described in 4.3: two matching subscriptions on one connection use up `max: 1`.

## 10. Open questions for the owner

Each question has a recommendation. Section 4 is written as if the recommendations are accepted.

- **O1 `hostgroup-default`.** Keep it with its own host account, or remove the platform host group altogether? *Recommendation: keep it, treated like a tenant (4.7).* The gateway's default backend and platform-namespace workloads depend on it, and uniform treatment leaves no unprefixed path.
- **O2 CA layout.** One platform CA, or a platform CA plus a name-constrained tenant CA? *Recommendation: two CAs (4.5).* It costs one more Secret key, and no tenant issuance can then produce a platform identity.
- **O3 Leaf lifetime.** 90 days renewed at 30 days left, or something shorter such as 30 days? *Recommendation: 90/30.* Each renewal rolls the tenant's hosts. Storage hosts are replaced without a surge (`resources.ts:1436-1442`), so a renewal briefly interrupts that tenant. Revocation never depends on lifetime (4.5).
- **O4 Bootstrap.** A one-shot PKI Job before the Helm release, or keys generated by the Pulumi program? *Recommendation: the Job (4.5).* It keeps keys out of Pulumi state, and its wider `create` grant adds no new principal.
- **O5 Source of a host pod's environment.** An operator flag that maps host namespaces to environments, or Namespace labels that the operator reads? *Recommendation: the flag (4.6, item 3).* It needs no new cluster-scoped RBAC, and it changes with the same lifecycle as `hostNamespaces`.
- **O6 JetStream.** Keep it for the `DATA` account only, or turn it off? *Recommendation: keep it for `DATA` only.* No scheduler identity uses JetStream, and it is unknown whether any `hostgroup-default` workload does.
- **O7 vCluster exposure.** *Recommendation: close the log, operator-Secret-read and token-placement classes in this work (4.9).* As the owner directed, host-side RBAC in `pi-*` is recorded as parked for v0.2.
- **O8 Upstreaming.** Offer the operator patch to wasmCloud? *Recommendation: yes, after it ships here. It does not block this work.* The patch is generic, and upstream's own comment acknowledges the unvalidated heartbeat.
- **O9 Per-host identities within a tenant.** *Recommendation: out of scope (5).* As the owner directed, narrowing the platform controller's cluster-wide Secret read is recorded as parked for v0.2.

## 11. Unverified items

These are marked **U** above. The implementation or Layer 4 must confirm them:

1. The reloader image's flags, and the kubelet's propagation delay for ConfigMaps and Secrets on the target clusters (4.1, 4.4, 8.4 step 12).
2. That wash exits and restarts on a failed first connect, and how it behaves when it reconnects after a certificate change (4.4, 4.5).
3. That the Pulumi Kubernetes provider awaits the bootstrap Job's completion (4.5).
4. That Helm keeps a pod-template annotation the controller adds to `hostgroup-default` (4.5).
5. The effect of `useSecretsForSATokens: true` on the operator's tests and on a running instance (4.9).
6. The account `limits` sizes (4.3).
7. The upstream statements in 2.4: the v2 and v1 documentation, and the runtime-operator 2.9 changes.
8. Whether any `hostgroup-default` workload uses JetStream (O6).

## Appendix A. The probe's exact configuration

This is the configuration the probe of section 9 ran, rendered for the platform host group and tenants `a` and `b`. Certificate paths are placeholders. `listen` is the probe's ephemeral port. The design's static `nats-server.conf` (4.1) supplies the `tls` block and includes the `accounts` block.

```
listen: 127.0.0.1:-1
tls {
  cert_file: "/etc/nats/server.crt"
  key_file: "/etc/nats/server.key"
  ca_file: "/etc/nats/bundle.crt"
  verify_and_map: true
}
accounts {
  SCHEDULER: {
    users: [
      { user: "operator.platform.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.host.*.*.>"] },
          subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] }
      } }
    ]
    imports: [
      { stream: { account: HOSTS_wasmcloud, subject: "runtime.operator.heartbeat.*" }, to: "runtime.operator.heartbeat.wasmcloud.*" }
      { service: { account: HOSTS_wasmcloud, subject: "runtime.host.*.>" }, to: "runtime.host.wasmcloud.*.>" }
      { stream: { account: HOSTS_di-tenant-a, subject: "runtime.operator.heartbeat.*" }, to: "runtime.operator.heartbeat.di-tenant-a.*" }
      { service: { account: HOSTS_di-tenant-a, subject: "runtime.host.*.>" }, to: "runtime.host.di-tenant-a.*.>" }
      { stream: { account: HOSTS_di-tenant-b, subject: "runtime.operator.heartbeat.*" }, to: "runtime.operator.heartbeat.di-tenant-b.*" }
      { service: { account: HOSTS_di-tenant-b, subject: "runtime.host.*.>" }, to: "runtime.host.di-tenant-b.*.>" }
    ]
  }
  DATA: { users: [ { user: "data.platform.scheduler.di-framework.invalid" } ] }

  HOSTS_wasmcloud: {
    users: [
      { user: "host.platform.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.operator.heartbeat.*"] },
          subscribe: { allow: ["runtime.host.*.>"] },
          allow_responses: { max: 1, expires: "2m" }
      } }
    ]
    exports: [
      { stream: "runtime.operator.heartbeat.*", accounts: [SCHEDULER] }
      { service: "runtime.host.*.>", accounts: [SCHEDULER] }
    ]
  }
  HOSTS_di-tenant-a: {
    users: [
      { user: "0123456789abcdef.di-tenant-a.tenants.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.operator.heartbeat.*"] },
          subscribe: { allow: ["runtime.host.*.>"] },
          allow_responses: { max: 1, expires: "2m" }
      } }
    ]
    exports: [
      { stream: "runtime.operator.heartbeat.*", accounts: [SCHEDULER] }
      { service: "runtime.host.*.>", accounts: [SCHEDULER] }
    ]
  }
  HOSTS_di-tenant-b: {
    users: [
      { user: "0123456789abcdef.di-tenant-b.tenants.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.operator.heartbeat.*"] },
          subscribe: { allow: ["runtime.host.*.>"] },
          allow_responses: { max: 1, expires: "2m" }
      } }
    ]
    exports: [
      { stream: "runtime.operator.heartbeat.*", accounts: [SCHEDULER] }
      { service: "runtime.host.*.>", accounts: [SCHEDULER] }
    ]
  }
}
```
