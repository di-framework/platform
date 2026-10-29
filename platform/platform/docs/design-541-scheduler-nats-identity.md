# Design: per-tenant identity and authorization on the scheduler NATS (#541)

| | |
|---|---|
| Issue | #541 (part of epic #495, E2 Tenant isolation and transport; found during the #535 check) |
| Related | #535, #540, #542 (network policy on the scheduler NATS); #552 (scheduler NATS without debug/trace logging) |
| Status | **Design, revision 3.** Revised after review round 1 on PR #558 and after the owner's decision not to fork the runtime-operator. No code changes. Implementation waits for this note to merge. |
| Scope | `platform/platform` (scheduler NATS, PKI, tenant host and per-tenant operator wiring), and one vCluster value in `platform/operator`. Upstream wash and runtime-operator stay unpatched, apart from the existing wash fork in `platform/tenant-host/`. |
| Constraints from the owner | No users yet: no rollout phases, no tenant-by-tenant migration, no compatibility shims, no release notes. The shared certificate is replaced outright. The gap is fixed, not documented away. The runtime-operator is not forked. |

## Conventions

- **Platform sources.** Paths are relative to the repository root and were read at `origin/main` `300edea`. #552 merged after that commit. It adds `platform/platform/src/nats-log-level.ts` and changes no line cited here.
- **`chart:`** is a template or values line of the runtime-operator Helm chart 2.8.0 (`oci://ghcr.io/wasmcloud/charts/runtime-operator`, the version `platform/platform/src/index.ts:255` pins).
- **`wasmcloud:`** is wasmCloud `v2.8.0` at `5c4ec4a3` (the commit `platform/tenant-host/Dockerfile:15-16` pins). Its `runtime-operator/` directory is the operator source. **`wasmcloud-2.9:`** is the `v2.9.0` tag, cited only for comparison.
- **`nats-server:`** is nats-server `v2.12.8` (the image tag `chart: values.yaml:65` pins). **`nats.go:`** is nats.go `v1.53.1` (`wasmcloud: runtime-operator/go.mod:20`).
- **`vcluster:`** is the vCluster chart 0.37.3 bundled at `platform/operator/internal/targets/vcluster/chart/vcluster-0.37.3.tgz`.
- **Evidence marks.**
  - **V**: verified in source, or in the chart rendered with `helm template`.
  - **P**: verified by the local broker probes in section 9, whose exact configuration is Appendix A.
  - **U**: unverified; the implementation or Layer 4 must confirm it.
- This note states the gap and the target properties. It does not describe how the current state could be abused.

## 1. Summary

Today every tenant host group and the platform's own host group present the same client certificate to the scheduler NATS. That certificate maps to one NATS user, in the global account, with no permission limits. One runtime-operator serves every tenant. Subjects carry no tenant, and the operator takes a host's tenant from the heartbeat payload. The bus cannot tell tenants apart.

The end state, with upstream wash and runtime-operator unmodified:

- **The scheduler NATS leaves the chart.** The platform deploys it with the same Service name, port and labels, owns its configuration, and reloads it in place. It runs without debug or trace logging.
- **One NATS account per environment, and nothing shared between accounts.** Each account holds two users:
  - the hosts of one environment;
  - the runtime-operator instance that serves that environment.

  There are no imports, exports or mappings. Subjects stay exactly what wash and the operator use today.
- **One unmodified runtime-operator per tenant.** Each instance:
  - runs in its own namespace `di-operator-<t>`;
  - connects through its tenant's account only;
  - watches only `di-tenant-<t>`, and manages host pods only in `di-runtime-<t>`.

  It can hear only its tenant's heartbeats, reach only its tenant's hosts, read only its tenant's Secrets, and place only its tenant's workloads. The chart's own operator keeps serving the platform namespace and `hostgroup-default`.
- **Per-tenant host certificates from a platform-issued, name-constrained tenant CA.** Each certificate is bound to a fresh NATS user name per issuance, and current and previous issuances are recorded in controller-owned state. Removing a tenant, or force-rotating its identity, revokes the old user in the next reload. A routine renewal keeps the previous user for at most 10 minutes.
- **The shared certificate and the chart's CA are gone.** No tenant namespace receives a platform key. The CA keys live in a namespace that no pod and no workload can reach.

**What was compared.** Section 7 compares this option, (a), with a platform-owned relay (b) and broker isolation alone (c).
- Option (a) meets P1-P7 without any patch. A local nats-server 2.12.8 probe of its configuration passed 13 of 13 checks.
- Option (c) fails P3. In the probe, a `workload.start` for tenant B was also delivered to tenant A's credentials.
- Option (b) meets the properties only by adding a new component that sees every secret and sits on every heartbeat path. On 2.8.0, if that component stops, the operator deletes every host and its workloads.

## 2. Current state

### 2.1 Authentication and authorization on the scheduler NATS

- **The chart ships its own server.** The chart ships its own `nats` Deployment and ConfigMap (`chart: templates/nats/config.yaml`, `templates/nats/deployment.yaml`). TLS is on by default (`chart: values.yaml:24-27`), and the platform does not change it (`platform/platform/src/index.ts:369-404`, `platform/platform/src/values.ts:2-17`). **V**
- **Three users, all unrestricted.** Clients authenticate with mTLS and `verify_and_map`. The config defines three users, `wasmcloud-operator`, `wasmcloud-runtime` and `wasmcloud-data`, and no accounts, no `permissions`, no NKeys or JWTs and no `no_auth_user` (`chart: templates/nats/config.yaml:19-34`). All three users are therefore in the global account with unrestricted publish and subscribe. **V**
- **Helm makes the certificates.** Helm generates the CA and one certificate per role at render time, and reuses them through `lookup` (`chart: templates/certificates.yaml:24-61`). **V**
- **The chart cannot change the server configuration.** It has no value for it. Changing authentication means setting `nats.enabled: false` (`chart: values.yaml:54-56`) and running a platform-owned server. **V**
- **Debug and trace logging.** The chart starts the server with debug and trace logging (`chart: templates/nats/deployment.yaml:50`). #552 post-renders those flags away. With the server out of the chart, that post-renderer has nothing left to rewrite and is removed (4.1). **V**

### 2.2 What a tenant host presents

- **Every tenant gets the platform's key.** The platform controller reads `wasmcloud-runtime-tls` from the platform namespace (`platform/platform/src/tenancy/controller.ts:994-996`). It copies the whole `data` into `di-scheduler-tls` in each `di-runtime-<tenant>` (`platform/platform/src/tenancy/resources.ts:1426-1432`). Every tenant therefore holds the same private key as the platform's own host group. **V**
- **TLS is wash's only scheduler credential.** The host mounts `di-scheduler-tls` read-only at `/scheduler` (`resources.ts:1548,1573`) and passes `--scheduler-nats-tls-{ca,cert,key}` (`resources.ts:1495-1505`). wash 2.8.0 has no other credential for the scheduler bus:
  - its only scheduler authentication flags are the TLS ones (`wasmcloud: crates/wash/src/cli/host.rs:21-39`);
  - `connect_nats` adds only root certificates and a client certificate (`wasmcloud: crates/wash-runtime/src/washlet/mod.rs:294-341`).

  **V**
- **The wash fork does not touch the scheduler connection.** The tenant host patches (`platform/tenant-host/0001-*.patch`, `0002-*`, `0003-*`) leave it alone. Tenant hosts run `ghcr.io/di-framework/wash:2.8.0-wasi-tls` by default (`DEFAULT_HOST_IMAGE`, `platform/platform/src/index.ts:124-125`), or `2.8.0-wasi-tls-exclusive` through `tenantHostImage` (`platform/tenant-host/variants`). The design is the same for both. **V**

### 2.3 Subjects and the operator

| Direction | Subject | Source |
|---|---|---|
| host subscribes | `runtime.host.<host_id>.>` (`heartbeat`, `workload.start`, `workload.stop`, `workload.status`) | `wasmcloud: crates/wash-runtime/src/washlet/mod.rs:211-214,344-346,365-400` |
| host publishes | `runtime.operator.heartbeat.<host_id>` (plain publish, no reply) | `washlet/mod.rs:233-238,352-354` |
| host publishes | the reply to each command, to the request's reply subject | `washlet/mod.rs:241-247` |
| operator subscribes | `runtime.operator.heartbeat.>` | `wasmcloud: runtime-operator/internal/controller/runtime/host_controller.go:205` |
| operator requests | `runtime.host.<host_id>.<cmd>`, reply on a `_INBOX.` subject | `runtime-operator/internal/controller/runtime/host_client.go:31-37,84`; `runtime-operator/pkg/wasmbus/nats.go:166-175` |

- **The command subject is fixed.** wash derives the command by skipping three tokens of the subject (`washlet/mod.rs:372`). **V**
- **Host IDs are random identifiers, not secrets.** Each host start gets a fresh UUIDv4 (`wasmcloud: crates/wash-runtime/src/host/mod.rs:1198`), so no static permission can name "tenant A's hosts". Host IDs also appear in Workload status and in logs. **V**
- **The operator trusts the heartbeat.**
  - It decodes only the payload and ignores the reply subject (`host_controller.go:211-213`).
  - It upserts `Host/<friendlyName>` in its own namespace, with `HostID`, `Environment` and labels copied from the payload (`host_controller.go:229-251`).
  - Placement matches `Host.Environment` against the workload namespace (`workload_controller.go:126-170`).
  - Commands and route endpoints resolve the Host by `HostID` alone (`workload_controller.go:195-207,383,403,437`; `workload_route_controller.go:109,280-292`). **V**
- **Host objects are namespaced.** Hosts, Workloads, WorkloadReplicaSets, WorkloadDeployments and Artifacts are all namespaced CRDs (`chart: crds/*.yaml:15-17`, `scope: Namespaced`). Host objects live in the operator's own namespace (`OPERATOR_NAMESPACE`, `wasmcloud: runtime-operator/cmd/main.go:160-166`). The operator caches Hosts only there (`main.go:280-283`). **V**
- **Silent hosts are deleted on 2.8.0.** A Host that has not reported within the heartbeat TTL of 60 seconds (`wasmcloud: runtime-operator/operator.go:90`, `main.go:171`) becomes not-ready and is deleted. Its finalizer then deletes every Workload placed on it (`host_controller.go:87-97,102-124,131-142`). **V**
- **`workload.start` carries Secret values.** It carries the workload's resolved configuration, including Secret values (`runtime-operator/internal/controller/runtime/utils.go:82-94,158-180`). **V**
- **The scheduler bus carries no tenant data or messaging traffic.** That traffic goes to each tenant's own `di-nats`, which this design does not change (`platform/platform/src/tenancy/registry-nats.ts:12-31,152-170`). **V**

### 2.4 Upstream position

- **Upstream treats namespaces as the tenant boundary.** The chart's values call cross-tenant scheduling "permissive" and offer `allowSharedHosts=false` as the namespace boundary (`chart: values.yaml:165-180`). The heartbeat comment cited above shows that the operator does not authenticate the environment. **V**
- **wasmCloud 2.9 adds a fleet witness.** It stops the operator from deleting hosts when it hears no host at all, but it still deletes hosts that fall silent while others keep reporting (`wasmcloud-2.9: runtime-operator/internal/controller/runtime/host_controller.go:60-120,212-225`). **V**
- **Points not re-checked for this note.** These come from the owner's reading of upstream. **U**
  - The wasmCloud v2 documentation defines no tenant boundary on the scheduler bus.
  - wasmCloud v1's multi-tenant guidance was one NATS account per tenant.

### 2.5 Conclusion

Tenants have no distinct NATS identity. A single operator hears every heartbeat and reaches every host. Per-tenant certificates mapped to restricted users in one shared account would not be enough: a subject permission cannot name a tenant's hosts, and the shared operator would still accept a misattributed heartbeat. Without changing the operator, the only way to give the broker a tenant boundary is to give each tenant its own account and its own operator.

## 3. Target properties

- **P1 Broker-level isolation.** Credentials issued to tenant A cannot publish or subscribe to any subject that carries tenant B's scheduler traffic. Either the broker refuses with an explicit permission violation, or A's account has no route to B. The property does not depend on network policy.
- **P2 A heartbeat reaches only its own tenant's operator.**
  - Heartbeats sent with tenant A's credentials reach only the operator that serves A, and that operator places only A's workloads. A host therefore cannot claim another tenant's environment, host ID or Host name.
  - Within one tenant, a compromised host can still misdescribe itself. That stays inside the tenant's own trust boundary (4.6).
- **P3 Secrets reach only the target tenant.**
  - Every `workload.start`, `workload.status` and `workload.stop` for a tenant's workload is sent by that tenant's operator, inside that tenant's account. Only that tenant's host identity can receive it.
  - Each operator resolves host IDs only against its own tenant's Hosts.
  - The server does not log message payloads.
- **P4 Least privilege for every identity.** On the broker, each user can publish and subscribe only to the subjects its role needs (4.3). In Kubernetes, each operator can read only its own tenant's namespaces (4.6).
- **P5 Independent lifecycle and prompt revocation.**
  - Issuing, rotating or removing one tenant's identity reloads the server without disconnecting any other tenant.
  - Removal and forced rotation revoke the old identity in the next reload. Its connections are dropped, and its certificate is refused even though it is still valid.
  - A routine renewal keeps the previous identity for at most 10 minutes while hosts roll, then revokes it the same way.
  - No identity outlives its record until certificate expiry.
- **P6 No shared secrets in tenant namespaces.** A tenant runtime namespace holds only that tenant's own key and the public CA bundle that verifies the server.
- **P7 Issuance cannot escape its scope.** The CA that signs tenant host certificates can sign only names inside the tenant subtree, so neither a bug nor a stolen tenant CA key can produce an operator's or the platform's identity.

## 4. Design

### 4.1 The scheduler NATS leaves the chart, and the chart's operator serves only the platform namespace

The Helm values below are enforced in `platformValues` (`platform/platform/src/values.ts:2-17`), so `args.values` cannot undo them. All are **V** against a `helm template` render of chart 2.8.0 with these values. The render has no NATS resources, no `wasmcloud-ca` and no generated certificates. It has per-namespace Roles, and only the metrics ClusterRoles remain.

| Value | Setting | Effect |
|---|---|---|
| `nats.enabled` | `false` | The chart renders no NATS Deployment, Service, ConfigMap or policy (`chart: templates/nats/*.yaml:1`). |
| `global.tls.enabled` | `true` (unchanged) | The chart's operator and `hostgroup-default` still mount client certificates, including `ca.crt`, and pass the TLS flags (`chart: templates/operator/deployment.yaml:41-45`, `templates/runtime/deployment.yaml:195-205`). |
| `global.certificates.generate` | `false` | The chart generates no CA and no certificates (`chart: templates/certificates.yaml:2`). |
| `global.certificates.{operator,runtime,data}CertSecretName` | `di-scheduler-operator-tls`, `di-scheduler-platform-host-tls`, `di-scheduler-data-tls` | The chart mounts the platform-issued Secrets (`chart: values.yaml:36-41`). |
| `operator.watchNamespaces` | the platform namespace only | Namespaced Roles replace the chart ClusterRole's cluster-wide Secret read (`chart: templates/operator/clusterrole.yaml:1`, `workload-namespace-role.yaml:1-30`). |
| `operator.hostNamespaces` | the platform namespace only | The chart's operator manages only `hostgroup-default`'s pods. |

**No restarts on tenant changes.** Both lists are now static. Adding or removing a tenant therefore no longer changes the chart's operator Deployment. Today it does, through `hostNamespaces` (`platform/platform/src/watched-namespaces.ts:150-200`) and the `-host-namespaces` process flag (`chart: templates/operator/deployment.yaml:50-51`). Each tenant's own operator has fixed flags for its whole life (4.6).

**Service and labels stay the same.** The platform-owned server keeps the Service name `nats`, port 4222 and the pod label `wasmcloud.com/name: nats`. These are what the chart's default `schedulerUrl` (`chart: templates/_helpers.tpl:172`) and the tenant hosts' URL (`platform/platform/src/tenancy.ts:297`) resolve to. The platform's policies (`platform/platform/src/platform-ingress.ts:56-77`, `platform/platform/src/tenancy.ts:213-247`) and the vCluster target's `allow-platform-nats` policy (`platform/operator/internal/targets/vcluster/networkpolicy.go:110-116,193`) select the same labels. The #552 post-renderer is removed together with the chart's NATS.

**Pulumi-managed resources** in the platform namespace, created before the Helm release:

- **Deployment `nats`.**
  - One replica, image `nats:2.12.8-alpine` pinned by digest.
  - Arguments `-c /etc/nats/nats-server.conf` only, with no `-D` or `-V`.
  - The chart's hardened security context (`chart: values.yaml:74-92`) and `automountServiceAccountToken: false`.
  - `shareProcessNamespace: true` for the reloader.
  - It mounts the ConfigMap below, the accounts ConfigMap (required) and Secret `di-scheduler-nats-tls`.
- **Container `reloader`.** The upstream `nats-server-config-reloader`, pinned by digest. It watches the config, the accounts file and the server certificate, and signals the server through the shared process namespace and `pid_file`. **U**: its flags.
- **ConfigMap `di-scheduler-nats`.** The static `nats-server.conf`:
  - `port` and `pid_file`;
  - a `tls` block with `verify_and_map: true`;
  - `ca_file`, the bundle of the platform CA and the tenant CA, current and next of each;
  - `include "accounts/accounts.conf"`.

  Only `pulumi up` changes it.
- **Service `nats`**, port 4222, and a ServiceAccount without a token.
- **Namespace `<platform-ns>-scheduler-pki`** for the CA keys and the identity record (4.5).
- **JetStream**, enabled at server level with the same `emptyDir` store as today (`chart: templates/nats/deployment.yaml:37-38,59-60`), for the `DATA` account only (O5).

**ConfigMap `di-scheduler-nats-accounts` is not a Pulumi resource**, so a `pulumi up` cannot reset it and drop tenant accounts. The bootstrap Job creates it if it is missing (4.5), the platform controller is its only writer afterwards (4.4), and the Deployment only mounts it.

### 4.2 Accounts

| Account | Users | Serves |
|---|---|---|
| `T_<platform-ns>` (default `T_wasmcloud`) | `host.platform.scheduler.di-framework.invalid` (`hostgroup-default`), `operator.platform.scheduler.di-framework.invalid` (the chart's operator) | The platform namespace (4.7). |
| `T_di-tenant-<t>`, one per tenant | `<issuance-id>.di-tenant-<t>.tenants.scheduler.di-framework.invalid` (the tenant's hosts: the current user, plus the previous one during a routine renewal), `operator.di-tenant-<t>.platform.scheduler.di-framework.invalid` (the tenant's operator) | Tenant `<t>`. |
| `DATA` | `data.platform.scheduler.di-framework.invalid` | The data connection of `hostgroup-default`. It has no other users, so it cannot see scheduler traffic. |

No account imports or exports anything. Every value of `<t>` is a DNS label (`validName`, `resources.ts:886-890`), so every account name is valid.

### 4.3 Permissions and limits

The shape of `accounts.conf` for one tenant `a` is shown below. Appendix A has the complete configuration the probe ran, with the platform account, two tenants and `DATA`.

```
accounts {
  T_di-tenant-a: {
    limits: { max_connections: <2 x replicas + 4>, max_subscriptions: 64, max_payload: 1048576 }
    users: [
      { user: "<issuance-id>.di-tenant-a.tenants.scheduler.di-framework.invalid",
        permissions: {
          publish:   { allow: ["runtime.operator.heartbeat.*"] }
          subscribe: { allow: ["runtime.host.*.>"] }
          allow_responses: { max: 1, expires: "2m" }
        } }
      { user: "operator.di-tenant-a.platform.scheduler.di-framework.invalid",
        permissions: {
          publish:   { allow: ["runtime.host.*.>"] }
          subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] }
        } }
    ]
  }
  DATA: { jetstream: enabled, users: [ { user: "data.platform.scheduler.di-framework.invalid" } ] }
}
```

How the pieces give the properties:

- **Isolation (P1, P3).** Accounts share nothing.
  - A request from tenant B's operator is delivered only to hosts in B's account, and its reply returns through B's `_INBOX`.
  - Credentials holding A's host identity receive none of B's `workload.start` (a positive control was received).
  - A's operator cannot reach B's hosts.
  - The platform operator hears no tenant heartbeat. **P**
- **Host identity inside its own account (P4).**
  - A host can publish only `runtime.operator.heartbeat.<one token>`, subscribe only to `runtime.host.*.>`, and reply only to requests it received (`allow_responses`, `nats-server: server/client.go:3876-3884,4153-4166`).
  - Subscribing to `_INBOX.>` (its operator's replies) or to `runtime.operator.heartbeat.>`, and publishing any `runtime.host.` command, are each refused with `Permissions Violation`. **P**
  - `expires` is twice the operator's one-minute round-trip timeout (`host_client.go:17`).
  - With `max: 1`, two matching subscriptions on one connection use up the single reply between them. wash has one subscription per host connection (`washlet/mod.rs:211-214`). **P**
- **Operator identity (P4).** An operator can send commands to and read heartbeats from only its own account, and it needs no JetStream. Heartbeats arrive unchanged (`runtime.operator.heartbeat.<host_id>`), so the unmodified operator parses them as today. **P**
- **Availability.** Account `limits` (`nats-server: server/opts.go:3400-3425,3619`) cap one tenant's connections, subscriptions and payload size, so one tenant cannot exhaust the shared server. **V** for the keys; **U** for the sizes, which are tuned against Layer 3.

### 4.4 Who renders the accounts file, and how it is reloaded

- **Owner.** After bootstrap, the platform controller is the only writer of `di-scheduler-nats-accounts`. On each pass it renders `accounts.conf` from the full Tenant list and the identity record (4.5), never incrementally. The output is sorted and byte-stable, so an unchanged state causes no write and no reload. A removed Tenant always drops out.
- **Inputs.** The Tenant list, the identity record and the platform namespace. Nothing comes from tenant-writable input.
- **Validation.** Before writing, the controller checks:
  - each tenant host user against `^[0-9a-f]{16}\.di-tenant-<t>\.tenants\.scheduler\.di-framework\.invalid$`;
  - each operator user against `^operator\.di-tenant-<t>\.platform\.scheduler\.di-framework\.invalid$`;
  - that all users are unique, and that every account name is valid.

  nats-server refuses a reload with a duplicate user as a whole and keeps the previous configuration (**P**). The controller therefore refuses to write instead, and reports the offending Tenant in a condition. A write is never partial, because the whole file is one ConfigMap key.
- **RBAC.** The controller's ClusterRole already covers ConfigMaps (`platform/platform/src/tenancy/install.ts:186-197`). Narrowing it is parked for v0.2 (4.9).
- **Reload.** The kubelet updates the mounted ConfigMap, the reloader signals the server, and nats-server applies the account changes in place. Clients of unchanged accounts stay connected, and users that were removed are disconnected. **P** for the server; **U** for the kubelet's propagation delay.
- **Ordering for a new or changed tenant.**
  1. The controller records the issuances and issues the host and operator certificates.
  2. It writes the accounts file.
  3. It creates or rolls the tenant's operator and host Deployments.

  A client that starts before the server has reloaded gets its first connect refused and restarts with back-off. **U**: that wash exits on a failed first connect (`connect_nats` returns the error, `washlet/mod.rs:339-341`). Layer 4 measures the delay (8.4, step 11).

### 4.5 Credentials: CAs, issuance, record, lifetimes and rotation

**Two CAs, both owned by the platform** (O2):

| CA | Signs | Name constraints (critical) |
|---|---|---|
| Platform scheduler CA | the NATS server, every operator (platform and per tenant), `hostgroup-default`, `DATA` | DNS names `platform.scheduler.di-framework.invalid` and the four `nats` Service names (`nats`, `nats.<ns>`, `nats.<ns>.svc`, `nats.<ns>.svc.cluster.local`, as `chart: templates/certificates.yaml:70-75`); IP addresses excluded |
| Tenant scheduler CA | tenant host certificates only | DNS, email and URI names only under `tenants.scheduler.di-framework.invalid`; IP addresses excluded |

- **The tenant CA cannot mint a platform name.** nats-server maps a client certificate to a user by email SAN, then DNS SAN, then URI SAN, then subject DN (`nats-server: server/auth.go:1267-1340`). The tenant CA is constrained in every SAN form, and no user name is DN-shaped. The handshake refuses a tenant-CA certificate that names an operator by DNS or email SAN, and a subject-only certificate maps to no user. **P**
- **Operator certificates come from the platform CA.** Tenant operator certificates are issued by the platform CA, never by the tenant CA. A tenant host identity can therefore never become an operator identity.
- **`.invalid` names** (RFC 2606) never resolve and cannot be confused with a server name.
- **`tls.ts` needs three additions.** `platform/platform/src/tenancy/tls.ts` already writes CA certificates with DNS name constraints and an IP exclusion (`tls.ts:83-110,247-260`). It needs a permitted email subtree, a permitted URI subtree, and a client-auth leaf: `leafCertificate` sets only `serverAuth` (`tls.ts:389`). **V**; **U** for Go's `clientAuth` EKU check in this note.

**Identities.** Every Secret holds `tls.crt` and `tls.key`, and `ca.crt` with the platform CA bundle. The chart mounts `ca.crt` too (`chart: templates/operator/deployment.yaml:43`, `templates/runtime/deployment.yaml:197,203`).

| Identity | NATS user (DNS SAN) | Secret | Mounted by |
|---|---|---|---|
| NATS server | the `nats` Service names | `di-scheduler-nats-tls` (platform ns; its `ca_file` key holds both CAs) | `nats` |
| Platform operator | `operator.platform.scheduler.di-framework.invalid` | `di-scheduler-operator-tls` (platform ns) | the chart's `runtime-operator` |
| Platform host group | `host.platform.scheduler.di-framework.invalid` | `di-scheduler-platform-host-tls` (platform ns) | `hostgroup-default` |
| Platform data | `data.platform.scheduler.di-framework.invalid` | `di-scheduler-data-tls` (platform ns) | `hostgroup-default` |
| Tenant `<t>` operator | `operator.di-tenant-<t>.platform.scheduler.di-framework.invalid` | `di-scheduler-operator-tls` (`di-operator-<t>`) | the tenant's operator |
| Tenant `<t>` hosts | `<issuance-id>.di-tenant-<t>.tenants.scheduler.di-framework.invalid` | `di-scheduler-tls` (`di-runtime-<t>`) | `hostgroup-tenant-<t>` |
| Both CA keys | none | `di-scheduler-ca` (`<platform-ns>-scheduler-pki`) | **no pod** |
| Identity record | none | ConfigMap `di-scheduler-identities` (`<platform-ns>-scheduler-pki`) | **no pod** |

- **Where the CA keys live.** `<platform-ns>-scheduler-pki` holds only the CA keys and the identity record.
  - No operator watches it, so no WorkloadDeployment `secretFrom` can name anything in it.
  - The only pod that runs there is the bootstrap Job, and it mounts nothing from the namespace. vCluster syncs only Secrets a pod uses (`vcluster: values.yaml:26-30`), so these Secrets stay out of the host namespace on the vCluster target. **V**
  - The platform controller reads it.
- **The identity record.** `di-scheduler-identities` holds one entry per tenant: `{ current: <issuance-id>, previous?: <issuance-id>, previousUntil?: <time> }`.
  - The controller writes it before it issues a certificate or renders accounts, and never reads identities back from tenant namespaces.
  - `<issuance-id>` is 16 random hex characters, new for every host certificate, so a user name names exactly one certificate.
  - Operator user names are fixed per tenant. An operator renewal needs no overlap, because nats.go reloads the certificate files on every handshake (`nats.go: nats.go:1212-1234`; `nats.ClientCert` at `wasmcloud: runtime-operator/cmd/main.go:189`). **V**

**Revocation and rotation** (P5):

- **Removal.** Deleting a Tenant drops its account from the next render. The reload disconnects its hosts and its operator, and their certificates are refused from then on. **P** The controller then deletes `di-operator-<t>`.
- **Forced rotation.** Changing the Tenant annotation `platform.di-framework.dev/rotate-scheduler-identity`, or deleting `di-scheduler-tls`, starts it. The controller:
  1. records a new current ID with no previous;
  2. issues the new certificate;
  3. renders accounts without the old user;
  4. rolls the hosts.

  The old identity is refused from that reload on. This mirrors how deleting the registry pull Secret rotates its token (`controller.ts:735-739`).
- **Routine renewal.** The controller:
  1. records the new current ID, sets `previous`, and sets `previousUntil` to now + 10 minutes;
  2. issues the certificate;
  3. renders both users;
  4. rolls only that tenant's host Deployment through a certificate-digest pod annotation (the registry-CA pattern, `resources.ts:1456-1466`).

  `previous` is dropped as soon as the rollout has finished (as the readiness gate at `controller.ts:1028-1042` checks), or at `previousUntil`, whichever comes first.

**Lifetimes** (O3):
- **CAs.** 10 years, rotated with the controller's existing CA machinery (`platform/platform/src/tenancy/ca-rotation.ts:13-25,140-215`). `ca_file` and each `ca.crt` carry the current and next CA.
- **Leaves.** 90 days, renewed when 30 days remain (`ca-rotation.ts:20`). Revocation never waits for expiry.
- **`hostgroup-default` renewal.** It restarts through a pod-template annotation. **U**: that Helm keeps an annotation it did not render.
- **Server renewal.** The server reloads its certificate when the reloader sees the Secret change.

**Bootstrap** (O4):
- **Why a Job.** The `nats` Deployment, the chart's operator and `hostgroup-default` must be ready before the Helm release finishes (`atomic: true`, `index.ts:377`). The controller is deployed after the release.
- **What it does.** A one-shot Job in `<platform-ns>-scheduler-pki` runs the controller's image and code with a `scheduler-pki` entry point. It creates whatever is missing:
  - `di-scheduler-ca` and `di-scheduler-identities`;
  - the four platform leaf Secrets in the platform namespace;
  - `di-scheduler-nats-accounts`, with no tenants.

  It overwrites nothing that exists, and no key enters Pulumi state.
- **Ordering.** The NATS Deployment and the Helm release both `dependsOn` the Job. **U**: that the Pulumi Kubernetes provider awaits the Job's completion; if it does not, the Job is wrapped in an explicit wait.
- **RBAC, as it really is.** RBAC `resourceNames` cannot restrict `create`. The Job's ServiceAccount therefore holds namespace-wide `create` on Secrets and ConfigMaps in the PKI and platform namespaces, plus `get` by `resourceNames`. This is accepted explicitly:
  - the ServiceAccount has no long-lived token, and only the Job's pod receives one;
  - the Job sets `ttlSecondsAfterFinished`;
  - only principals who can already create Secrets in those namespaces can run a pod as that ServiceAccount.

### 4.6 One unmodified runtime-operator per tenant

The platform controller renders, for each Tenant, the same objects the chart renders for its operator when `watchNamespaces` is set. It renders them directly, not through a second Helm release. They live in a new namespace, `di-operator-<t>`, which carries the installation and tenant labels and `namespace-role: operator`.

- **Deployment `runtime-operator`.**
  - The upstream image the chart uses (`chart: templates/operator/deployment.yaml:39`, `ghcr.io/wasmcloud/runtime-operator:2.8.0`), pinned by digest and unmodified.
  - One replica, with the chart's security context and resources (`chart: values.yaml:113-144`).
  - `OPERATOR_NAMESPACE=di-operator-<t>`.
  - Arguments:
    - `-nats-url=nats://nats.<platform-ns>.svc.cluster.local:4222` and `-nats-{ca,client-cert,client-key}`;
    - `-watch-namespaces=di-tenant-<t>`, `-host-namespaces=di-runtime-<t>`, `-allow-shared-hosts=false`;
    - `-leader-elect`;
    - `-metrics-bind-address=0`, which disables metrics (`wasmcloud: runtime-operator/cmd/main.go:86-87`), so no metrics ClusterRole is needed.

  These flags never change during the tenant's life, so a tenant change restarts only that tenant's operator.
- **ServiceAccount and RBAC.** Namespaced Roles only, mirroring the chart:
  - leases, events, pods and Hosts in `di-operator-<t>` (`chart: templates/operator/role.yaml`);
  - the workload CRDs, ConfigMaps, Secrets, Services, EndpointSlices and events in `di-tenant-<t>` (`workload-crd-role.yaml`, `workload-namespace-role.yaml`, `endpointslice-role.yaml`);
  - pods in `di-runtime-<t>` (`host-pod-role.yaml`).

  Each operator can read only its own tenant's Secrets.
- **NATS identity.** `di-scheduler-operator-tls` in `di-operator-<t>`, user `operator.di-tenant-<t>.platform.scheduler.di-framework.invalid`, in account `T_di-tenant-<t>` (4.2).

**Why several operators can coexist.** Each of these points is **V** in the 2.8.0 source.
- **CRDs.** All CRDs are namespaced (`chart: crds/*.yaml:15-17`) and installed once, by the platform's Helm release. Every operator runs the same image, so all agree on the CRD version.
- **Hosts.** Each operator creates and caches Hosts only in its own `OPERATOR_NAMESPACE` (`cmd/main.go:160-166,280-283`). Tenants therefore never share a Host store, a Host name or a host-ID index.
- **Workloads.** The workload cache is limited to `-watch-namespaces` (`cmd/main.go:252-255`). Exactly one operator watches each namespace: the chart's operator watches the platform namespace, and each tenant's operator watches its own tenant namespace. The host finalizer lists Workloads by host ID through that cache (`host_controller.go:102-124`), so it sees only its own tenant's Workloads.
- **Pods.** The pod cache is limited to the operator's namespace and `-host-namespaces` (`cmd/main.go:262-283`).
- **Leader election.** The lease `d34db3ef.wasmcloud.dev` (`cmd/main.go:292`) lives in each operator's own namespace, so the operators never contend. **U**: that controller-runtime defaults the lease namespace to the pod's namespace.
- **Webhooks.** The operator registers no admission webhooks, and the chart renders no webhook configuration (`chart: templates/`). The webhook server it constructs serves nothing (`cmd/main.go:225-227`).
- **Cluster-scoped objects.** None per tenant, because metrics are off. The CRDs and the chart's own metrics ClusterRoles exist once.

**What changes for the tenant's existing objects.**
- **The controller's host check.** Its readiness check that the tenant's hosts are registered (`controller.ts:1045-1052`) lists Hosts in `di-operator-<t>` instead of the platform namespace.
- **Network policy.** The platform's NATS ingress rule (`platform-ingress.ts:56-77`, `tenancy.ts:213-247`) also admits pods labelled `wasmcloud.com/name=runtime-operator` in namespaces that carry the installation and tenant labels and `namespace-role: operator`. On the vCluster target that rule is synced, and policies are additive, so no operator-repository change is needed (`networkpolicy.go:110-116`). The namespace's egress allows the API server and `nats` 4222. Its ingress allows nothing except kubelet probes.
- **Why a separate namespace rather than `di-runtime-<t>`.** Tenant roles can read pod logs and port-forward in `di-runtime-<t>` (`resources.ts:1139-1151`), and backup Jobs are created there (`platform/backup-destination/chart/templates/runtime.yaml:1-60`). A pod created there could use the operator's ServiceAccount. `di-operator-<t>` has no tenant role bindings and no other workloads, and its operator does not count against the tenant's runtime quota (`resources.ts:940-1002`).

**Cost per tenant.** One pod with a 100m CPU request, a 64Mi memory request and a 192Mi memory limit (`chart: values.yaml:117-122`). It idles at about 19Mi (the chart's own note, `values.yaml:113`). It also adds one NATS connection, one namespace, about six Roles and bindings, and one certificate. The platform budgets this outside the tenant's quotas.

**Residual risk, stated plainly.** The unmodified operator still copies a heartbeat's payload into its Host objects (`host_controller.go:229-251`). Isolation now comes from where a heartbeat can travel, not from validating it.
- **Within one tenant.** A compromised host of tenant A can misdescribe itself to A's operator. It can claim another environment string, which then matches none of A's workloads. It can reuse another A host's ID or name. It can report a foreign pod IP as its hostname, which can point A's own route endpoints at that IP.
- **Across tenants.** None of this crosses into tenant B. B's operator never receives A's heartbeat, B's Hosts and Workloads live in stores that A's operator cannot see, and A's operator has no Kubernetes access to B's namespaces.
- This is the tenant's own trust boundary. It needs a host sandbox escape first, and it is the same exposure a single-tenant wasmCloud install has.

### 4.7 `hostgroup-default` and the platform operator

- **`hostgroup-default` stays** (O1). It serves the platform namespace (`platform/platform/src/index.ts:425-439`, `wasmcloud-http`). It and the chart's operator share account `T_<platform-ns>`, exactly as a tenant and its operator do. The chart's operator watches and hosts only the platform namespace (4.1), so it never sees a tenant heartbeat (**P**) and never places a tenant workload.
- **The data connection** uses `DATA`, an account with no other users, so it cannot see scheduler subjects. `DATA` keeps JetStream for any NATS key-value or blobstore use on `hostgroup-default` (O5).

### 4.8 Tenant hosts

- `controller.ts:994-996` stops reading `wasmcloud-runtime-tls`. The controller issues the tenant host certificate instead (4.5). The readiness gate (`controller.ts:1028-1042`) requires that certificate where it now requires the copied Secret, and it requires the tenant operator's Deployment to be ready.
- `di-scheduler-tls` holds only the tenant's own key and certificate and the platform CA bundle (P6). Flags, mount path and URL stay the same (`resources.ts:1495-1505,1548,1573`).
- The host pod template gets the certificate-digest annotation (4.5).
- A pod that mounts `di-scheduler-tls` holds one tenant's host identity, which reaches only that tenant's operator.

### 4.9 Platform-side exposure on the vCluster target: closed or parked

| Exposure class | Decision |
|---|---|
| Message payloads in scheduler NATS logs | **Closed.** #552 drops the flags on the chart's server. The platform-owned server runs without `-D`/`-V` (4.1). |
| Runtime-operator Secret read beyond the namespaces it serves | **Closed.** The chart's operator watches only the platform namespace, and each tenant operator watches only its own tenant namespace, all through namespaced Roles (4.1, 4.6). No operator can read `<platform-ns>-scheduler-pki`. |
| Virtual ServiceAccount token placement on synced pods | **Closed.** The operator's vCluster values set `sync.toHost.pods.useSecretsForSATokens: true` (`vcluster: values.yaml:46-48`; `platform/operator/internal/targets/vcluster/defaults.go:30-60`). This covers every synced pod, including the platform controller (the CA issuer) and every runtime-operator. **U**: the effect on the operator's tests and on a running instance. |
| The shared platform key in tenant runtime namespaces and their synced copies | **Closed.** Each tenant's copy is only its own host identity (P6). |
| CA keys in synced Secrets or in Helm manifests | **Closed.** No pod mounts a CA key, and no key is in a Helm manifest (4.5). |
| Synced platform identities that pods must mount, and host-side RBAC in `pi-*` | **Parked for v0.2.** Host `edit`/`admin` in a `pi-*` namespace is equivalent to instance admin. |
| Instance-admin and host-admin capabilities (admin kubeconfig, state store, node access) | **Unchanged by design.** Instance owners are trusted in v1alpha1. These capabilities are outside the scheduler bus. |
| The platform controller's cluster-wide Secret read | **Parked for v0.2.** The controller is the issuer. |

## 5. Non-goals

- **Isolation between hosts of the same tenant.** The tenant is the isolation unit #541 asks for (residual risk in 4.6).
- **Patching wash or the runtime-operator** (owner decision).
- **Changes to `di-nats`,** the per-tenant data bus (2.3).
- **End-to-end encryption of `workload.start` payloads.** The broker sees plaintext; P3 limits who can receive them.
- **Migration, rollout phases, compatibility with the chart's certificates, and release notes** (owner direction). Existing development instances are reinstalled.

## 6. Code that changes when this is implemented

- **`platform/platform/src/index.ts`, `values.ts`.**
  - The chart values (4.1).
  - The NATS resources, the PKI namespace, and the bootstrap Job and its RBAC, all ordered before the Helm release.
  - Removal of the #552 `postrender`.
- **`platform/platform/src/watched-namespaces.ts`.** `hostNamespaces` becomes the platform namespace only. The tenant list it computes no longer feeds the chart.
- **`platform/platform/src/tenancy/tls.ts`.** Email and URI name constraints, and a client-auth leaf.
- **`platform/platform/src/tenancy/`.** A new `scheduler-nats.ts`, plus changes to `controller.ts` and `resources.ts`:
  - the identity record, issuance and rotation;
  - the accounts renderer and its validation;
  - the per-tenant `di-operator-<t>` namespace, operator Deployment, ServiceAccount, Roles and certificate;
  - the Host lookup in the readiness check, and the certificate-digest annotation;
  - removal of the `wasmcloud-runtime-tls` copy.
- **`platform/platform/src/platform-ingress.ts`, `tenancy.ts`.** The NATS ingress rule admits the tenant operators.
- **`platform/operator/internal/targets/vcluster/defaults.go`.** `useSecretsForSATokens`.
- **`platform/platform/README.md`.** The scheduler bus, its identities, and the per-tenant operators.

No new image is built or pinned. The per-tenant operators use the upstream image the chart already uses.

## 7. Alternatives considered

All three options keep the platform-owned NATS, the per-tenant host certificates and the identity record from 4.4 and 4.5. They differ in how heartbeats and commands cross the account boundary.

| | (a) Per-tenant operators (chosen) | (b) Platform-owned relay | (c) Broker isolation only |
|---|---|---|---|
| P1 broker isolation | **Met.** Accounts share nothing (**P**). | Met for hosts. The relay holds a user in every account. | Met for host-to-host traffic. |
| P2 heartbeats | **Met across tenants.** A heartbeat reaches only its tenant's operator (**P**). A within-tenant residual remains (4.6). | Met if the relay validates every heartbeat and keeps a host-ID-to-tenant map. | **Not met.** Every tenant's heartbeats arrive at one operator with no tenant marker (**P**), and the operator trusts the payload (2.3). |
| P3 secrets | **Met** (**P**). | Met if the relay forwards each command only to the owning account. The relay itself sees every `workload.start`. | **Not met.** A `workload.start` for B was delivered to A's credentials as well (**P**, 9). |
| P4 Kubernetes reach | **Improved.** Each operator reads only its tenant's namespaces. | Unchanged: one operator reads every tenant. | Unchanged. |
| New code in the auth path | None. Upstream operator, platform-rendered manifests. | A new service that parses heartbeats, tracks host IDs, and proxies request/reply. | None. |
| Failure blast radius | One tenant's operator failing affects only that tenant. | Relay down: the operator hears no host. On 2.8.0 it deletes every Host after 60 s, and their Workloads with them (`host_controller.go:87-97,102-124,131-142`). 2.9's fleet witness spares only total silence (`wasmcloud-2.9: host_controller.go:60-120`). | One operator for everyone, as today. |
| Cost | One small pod and one namespace per tenant (4.6). | One relay, plus one hop on every heartbeat and command. Latency **U**. | None. |

**(b) Platform-owned relay, rejected.** It would need several pieces:
- a user in the operator's account and in every tenant account;
- validation of each stamped heartbeat against its account, and a map from host ID to tenant;
- a subscription to `runtime.host.*.>` in the operator's account that re-issues each request into the owning tenant account with its own `_INBOX`, then copies the reply to the operator's reply subject, inside the operator's one-minute timeout (`host_client.go:17`);
- refusal of ambiguous host IDs.

It meets P1-P3 only while it runs correctly. It is a new process that sees every secret, and its failure deletes hosts and workloads on 2.8.0. Option (a) gets the same isolation from the broker and Kubernetes RBAC without new code in the path.

**(c) Broker isolation only, rejected.** Without a tenant marker in the subjects, a single operator account must import `runtime.host.*.>` from every tenant account. nats-server accepts that configuration (**P**), and a request then reaches every importing account. The probe's `workload.start` for B was received by A's credentials. P2 and P3 fail. Option (c) would only move today's gap behind accounts.

**Also rejected.**
- **A patched runtime-operator** that prefixes subjects and validates heartbeats (revision 2 of this note). The owner decided not to fork the operator.
- **Auth callout.** It adds a service to every connection's authentication and still needs one of (a) to (c).
- **Operator mode with creds.** wash has no creds option for the scheduler bus (`host.rs:21-39`).
- **One CA for every identity.** A tenant issuance bug could then mint an operator name (O2).

## 8. Verification

### 8.1 Unit tests (`bun test` in `platform/platform`)

- **Accounts renderer.**
  - One account per tenant, plus the platform account and `DATA`.
  - Two users per account, with exact permissions and limits, and no imports or exports.
  - Sorted, byte-stable output.
  - A removed Tenant disappears.
  - `previous` appears only during a routine renewal and never after `previousUntil`. A forced rotation renders no previous user.
  - The user-name patterns and uniqueness are enforced, and a bad entry blocks the write with a condition.
  - A golden file is shared with the broker test.
- **Identity record and issuance.**
  - The record is written before issuance, and every host issue gets a new ID.
  - Leaves carry the client-auth EKU and the right SAN form.
  - Both CAs carry their name constraints: the tenant CA refuses `operator.*` names, and operator certificates come only from the platform CA.
  - Lifetimes are as specified.
  - Every Secret carries `ca.crt`.
- **Per-tenant operator manifests.**
  - The flags (`-watch-namespaces=di-tenant-<t>`, `-host-namespaces=di-runtime-<t>`, `-allow-shared-hosts=false`, `-metrics-bind-address=0`) and `OPERATOR_NAMESPACE` are set.
  - The upstream image is pinned by digest.
  - RBAC is namespaced only and limited to the tenant's three namespaces.
  - The namespace labels and the NATS ingress rule admit the operator.
- **Chart values.**
  - `nats.enabled=false`, `generate=false`, the Secret names, and `watchNamespaces` and `hostNamespaces` set to the platform namespace are all enforced over `args.values`.
  - A `helm template` render shows no tenant namespace and no ClusterRole other than the metrics ones.
  - `di-scheduler-nats-accounts` is not a Pulumi resource.

### 8.2 Broker test (CI, no cluster)

A CI job runs nats-server 2.12.8, pinned by image digest, with the golden `accounts.conf`, freshly minted CAs and no network policy. A client test repeats the matrix of section 9:
- isolation and refusals;
- forged certificates;
- adding a tenant by reload with no disconnect for others;
- a colliding user refusing the reload as a whole;
- removal and rotation disconnecting only the affected identity, which is then refused.

**U**: whether the client test is written with the Bun NATS client or in Go.

### 8.3 Layer 3

Two tenants and the platform host group:
- each tenant's operator registers its hosts in `di-operator-<t>`;
- workloads are placed and run on each;
- the chart's operator registers only `hostgroup-default`;
- Layer 3 passes.

### 8.4 Layer 4, against the broker with tenant A's credentials

**Setup.** The client is a pod in `di-runtime-a` labelled `wasmcloud.com/name=hostgroup`. It mounts `di-scheduler-tls` read-only and runs a digest-pinned NATS CLI image. The platform's NATS ingress rule admits it, so network policy cannot mask a missing broker permission. The harness creates it with the instance admin kubeconfig. For each step, record the broker's exact response.

1. **Refused publishes.** Publish to `runtime.host.<A-host-id>.workload.status`, `runtime.host.<B-host-id>.workload.status`, `$JS.API.INFO` and `_INBOX.x`. Each gets `Permissions Violation for Publish`.
2. **Refused subscriptions.** Subscribe to `>`, `runtime.operator.heartbeat.>` and `_INBOX.>`. Each gets `Permissions Violation for Subscription`.
3. **Non-delivery of B's commands.** Subscribe to `runtime.host.*.>`, which is allowed. While it is open, deploy a workload in tenant B whose `secretFrom` value is a unique marker, and one in tenant A. A's subscription receives A's `workload.start` (positive control) and nothing with B's marker.
4. **Heartbeats stay in A.** Publish heartbeats that claim B's environment, reuse a host ID registered in B, and report one of B's pod IPs. B's operator logs nothing about them, and B's Hosts in `di-operator-b` are unchanged. A's operator may record the forged host, but it places no B workload: A's operator does not watch `di-tenant-b`.
5. **Forced rotation.** Force a new identity for A. A's old certificate gets `Authorization Violation` from that reload on, and A keeps scheduling. B shows no reconnect and no restart.
6. **Routine renewal.** Renew A's certificate. The previous user is gone once the rollout finishes, and within 10 minutes in any case.
7. **Removal.** Delete tenant B. B's hosts and operator are disconnected, and B's certificate gets `Authorization Violation`. `di-operator-b` is gone. A shows no reconnect and no restart.
8. **Keys and certificates.** `di-scheduler-tls` in A and in B have different public-key fingerprints. Neither `wasmcloud-runtime-tls` nor `wasmcloud-ca` exists.
9. **Logs.** After a deploy, the NATS pod's log has no `MSG_PAYLOAD` lines.
10. **Operator RBAC.** Check `kubectl auth can-i get secrets` as each operator's ServiceAccount:
    - tenant A's operator: `yes` in `di-tenant-a`; `no` in `di-tenant-b`, `di-runtime-a`, `kube-system` and `<platform-ns>-scheduler-pki`;
    - the chart's operator: `no` in every tenant namespace.
11. **Reload delay.** Measure the time from Tenant creation to the first registered host.
12. **ServiceAccount tokens.** On the vCluster target, no synced pod in `pi-*` carries a `vcluster.loft.sh/token-*` annotation. Check by name: the platform controller, the chart's operator, a tenant operator, `hostgroup-default` and a tenant host.

## 9. Evidence from the local probes

**Setup.** Local programs ran nats-server v2.12.8 in process. They were not committed, and no cluster was involved. Each used a platform CA and a tenant CA constrained in DNS, email and URI names, with IPs excluded, and a client certificate for each identity.

**Option (a), the chosen design: 13 of 13 checks passed.** The configuration is Appendix A, verbatim.
- **Connections.** The platform operator connects to its own account.
- **Heartbeats.**
  - B's heartbeat never reaches A's operator, even when its payload claims `di-tenant-a`.
  - A's heartbeat reaches A's operator unchanged, as `runtime.operator.heartbeat.HA`.
  - The platform operator hears no tenant heartbeat.
- **Commands.**
  - A's operator's request to A's host gets the reply through the same-account `_INBOX`.
  - B's operator reaches B's host.
  - A's operator cannot reach B's host.
  - A second connection holding A's host credentials, subscribed to `runtime.host.*.>`, saw none of B's `workload.start`.
- **Refusals for A's host identity.** Each returned `Permissions Violation`:
  - subscribing to `_INBOX.>`;
  - subscribing to `runtime.operator.heartbeat.>`;
  - publishing `runtime.host.HX.workload.start`.

**Option (c): 3 checks passed and the decisive one failed.**
- The configuration loads, with one operator account importing `runtime.host.*.>` and the heartbeat stream from two tenant accounts, unmapped.
- A's heartbeat arrives with no tenant marker, carrying the payload `{"environment":"di-tenant-b"}`.
- The operator's request to B's host succeeds.
- **The `workload.start` for B was also delivered to A's credentials.**

**Round-1 probe: 33 of 33 checks passed.** It used the import-mapping layout of revision 2. Its results that do not depend on imports carry over unchanged, because the same server mechanisms apply:
- forged tenant-CA certificates naming a platform user by DNS or email SAN fail the handshake;
- a subject-only certificate maps to no user;
- adding an account by reload keeps other clients connected;
- a duplicate user makes the reload fail as a whole, and the previous configuration keeps serving;
- removing an account disconnects only its users;
- a removed user's still-valid certificate is refused;
- `allow_responses` `max: 1` holds, and a publish to another account's reply subject is refused.

**Independent probe.** The round-1 reviewer's probe, 40 of 40 checks, confirms the same server behaviour.

## 10. Open questions for the owner

Each question has a recommendation. Section 4 is written as if the recommendations are accepted.

- **O1 `hostgroup-default`.** Keep it, served by the chart's operator in its own account, or remove the platform host group? *Recommendation: keep it (4.7).* The gateway's default backend and platform-namespace workloads depend on it.
- **O2 CA layout.** One platform CA, or a platform CA plus a name-constrained tenant CA? *Recommendation: two CAs (4.5).* No tenant host issuance can then produce an operator identity.
- **O3 Leaf lifetime.** 90 days renewed at 30 days left, or shorter? *Recommendation: 90/30.* Each host renewal rolls the tenant's hosts, which are replaced without a surge (`resources.ts:1436-1442`), and revocation never depends on lifetime.
- **O4 Bootstrap.** A one-shot PKI Job before the Helm release, or keys generated by the Pulumi program? *Recommendation: the Job (4.5).* It keeps keys out of Pulumi state.
- **O5 JetStream.** Keep it for `DATA` only, or turn it off? *Recommendation: `DATA` only.* No scheduler identity uses it, and whether any `hostgroup-default` workload does is unknown.
- **O6 Where tenant operators run.** In a dedicated `di-operator-<t>` namespace, or in `di-runtime-<t>`? *Recommendation: the dedicated namespace (4.6).* No tenant role or backup Job reaches the operator's pod or ServiceAccount there, and the operator stays outside the tenant's quota. The cost is one namespace per tenant.
- **O7 vCluster exposure.** *Recommendation: close the log, operator-Secret-read and token-placement classes in this work (4.9).* Host-side `pi-*` RBAC and the platform controller's cluster-wide Secret read are parked for v0.2, as the owner directed.

## 11. Unverified items

These are marked **U** above. The implementation or Layer 4 must confirm them:

1. The reloader image's flags, and the kubelet's propagation delay for ConfigMaps and Secrets (4.1, 4.4, 8.4 step 11).
2. That wash exits and restarts on a failed first connect, and how it reconnects after a certificate change (4.4).
3. That the Pulumi Kubernetes provider awaits the bootstrap Job's completion (4.5).
4. That Helm keeps a pod-template annotation the controller adds to `hostgroup-default` (4.5).
5. That controller-runtime places each operator's leader-election lease in that operator's own namespace (4.6).
6. The effect of `useSecretsForSATokens: true` on the operator's tests and on a running instance (4.9).
7. The account `limits` sizes (4.3).
8. Option (b)'s added latency (7). This needs checking only if (b) is reconsidered.
9. The upstream documentation statements in 2.4.
10. Whether any `hostgroup-default` workload uses JetStream (O5).
11. The client library for the broker test (8.2).

## Appendix A. The probe's exact configuration (option (a))

This is the configuration the option (a) probe of section 9 ran: the platform account (`T_wasmcloud`), tenants `a` and `b`, and `DATA`. Certificate paths are placeholders, and `listen` is the probe's ephemeral port. The design adds the per-account `limits` and the `DATA` JetStream setting (4.3), and its static `nats-server.conf` (4.1) supplies the `tls` block and includes the `accounts` block.

```
listen: 127.0.0.1:-1
tls { cert_file: "/etc/nats/server.crt", key_file: "/etc/nats/server.key", ca_file: "/etc/nats/bundle.crt", verify_and_map: true }
accounts {
  T_wasmcloud: { users: [ { user: "host.platform.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.operator.heartbeat.*"] },
          subscribe: { allow: ["runtime.host.*.>"] },
          allow_responses: { max: 1, expires: "2m" } } }, { user: "operator.platform.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.host.*.>"] },
          subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] } } } ] }
  T_di-tenant-a: { users: [ { user: "0123456789abcdef.di-tenant-a.tenants.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.operator.heartbeat.*"] },
          subscribe: { allow: ["runtime.host.*.>"] },
          allow_responses: { max: 1, expires: "2m" } } }, { user: "operator.di-tenant-a.platform.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.host.*.>"] },
          subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] } } } ] }
  T_di-tenant-b: { users: [ { user: "0123456789abcdef.di-tenant-b.tenants.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.operator.heartbeat.*"] },
          subscribe: { allow: ["runtime.host.*.>"] },
          allow_responses: { max: 1, expires: "2m" } } }, { user: "operator.di-tenant-b.platform.scheduler.di-framework.invalid", permissions: {
          publish: { allow: ["runtime.host.*.>"] },
          subscribe: { allow: ["runtime.operator.heartbeat.>", "_INBOX.>"] } } } ] }

  DATA: { users: [ { user: "data.platform.scheduler.di-framework.invalid" } ] }
}
```
