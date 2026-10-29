# Design: per-tenant identity and authorization on the scheduler NATS (#541)

| | |
|---|---|
| Issue | #541 (part of epic #495, E2 Tenant isolation and transport; found during the #535 check) |
| Related | #535, #540, #542 (network policy on the scheduler NATS) |
| Status | **Design.** No code changes. Implementation waits for this note to merge. |
| Scope | `platform/platform` (scheduler NATS, PKI, tenant host wiring), a new `platform/runtime-operator` fork directory and its workflows, and one vCluster value in `platform/operator` |
| Constraints from the owner | No users yet: no rollout phases, no tenant-by-tenant migration, no compatibility shims, no release notes. The shared certificate is replaced outright. The gap is fixed, not documented away. |

## Conventions

- Paths are relative to the repository root and were read at `origin/main` `300edea`.
- `chart:` is a template or values line of the runtime-operator Helm chart 2.8.0 (`oci://ghcr.io/wasmcloud/charts/runtime-operator`, the version `platform/platform/src/index.ts:255` pins).
- `wasmcloud:` is wasmCloud `v2.8.0` at `5c4ec4a3` (the commit `platform/tenant-host/Dockerfile:15-16` pins). Its `runtime-operator/` directory is the operator source.
- `nats-server:` is nats-server `v2.12.8` (the image tag `chart: values.yaml:65` pins). `nats.go:` is nats.go `v1.53.1` (`wasmcloud: runtime-operator/go.mod:20`).
- `vcluster:` is the vCluster chart 0.37.3 bundled at `platform/operator/internal/targets/vcluster/chart/vcluster-0.37.3.tgz`.
- Each claim is marked **V** (verified in source or the chart), **P** (verified by the local broker probe in section 9) or **U** (unverified; the implementation or Layer 4 must confirm it).
- Inputs: the step 1 check recorded for #541 and the scheduler NATS access-surface review. Both are summarised in section 2. This note keeps to the gap and the target. It does not describe how the current state could be abused.

## 1. Summary

Today every tenant host group and the platform's own host group present the same client certificate to the scheduler NATS. The certificate maps to one NATS user with no permission limits in the global account. Subjects carry no tenant, and the runtime-operator takes a host's tenant from the heartbeat payload without checking who sent it. The bus cannot tell tenants apart.

The end state:

- **The scheduler NATS leaves the chart.** The platform deploys it (same Service name, port and labels), owns its configuration, and reloads it in place. It runs without trace logging.
- **One NATS account per host environment.** Each tenant's hosts get an account with a single certificate-mapped user. So does the platform's own host group. The operator has its own account, and the platform data user has its own. Accounts share nothing except two server-side mappings per host account:
  - heartbeats published as `runtime.operator.heartbeat.<host_id>` reach the operator as `runtime.operator.heartbeat.<environment>.<host_id>`;
  - commands the operator sends to `runtime.host.<environment>.<host_id>.<cmd>` reach the host as `runtime.host.<host_id>.<cmd>`, the subject unpatched wash expects.

  The server adds the environment token. A host cannot choose or forge it.
- **Per-tenant certificates from a platform-issued, name-constrained tenant CA.** The platform controller issues them, binds each to a fresh NATS user name per issuance, and rotates them. Removing a tenant or rotating its certificate removes the old user, and the broker disconnects it. Other tenants are not touched.
- **A small runtime-operator patch** shipped as a forked image (`ghcr.io/di-framework/runtime-operator`), built and pinned the way the tenant host image is. It accepts a heartbeat only when the server-added environment token, the payload's environment, the subject's host ID and the host's pod all agree. It addresses every host through its verified environment. wash stays unpatched.
- **The shared certificate and the chart's CA are gone.** No tenant namespace receives a platform key.

A local broker probe (section 9) ran the proposed configuration on nats-server 2.12.8. All 25 checks passed: cross-tenant isolation, explicit permission violations, mapping, rejection of forged certificates, and revocation on reload.

## 2. Current state

### 2.1 Authentication and authorization on the scheduler NATS

- The chart ships its own `nats` Deployment and ConfigMap (`chart: templates/nats/config.yaml`, `templates/nats/deployment.yaml`). TLS is on by default (`chart: values.yaml:24-27`) and the platform does not change it (`platform/platform/src/index.ts:369-404`, `platform/platform/src/values.ts:2-17`). **V**
- Clients authenticate with mTLS and `verify_and_map`. Three users exist, `wasmcloud-operator`, `wasmcloud-runtime` and `wasmcloud-data`, with no accounts, no `permissions`, no NKeys or JWTs, and no `no_auth_user` (`chart: templates/nats/config.yaml:19-34`). All three are therefore in the global account with unrestricted publish and subscribe. **V**
- Helm generates the CA and one certificate per role at render time and reuses them through `lookup` (`chart: templates/certificates.yaml:24-61`). The certificates are valid for 365 days. The CA key is in Secret `wasmcloud-ca` and in the Helm release history. **V** (the release-history copy is standard Helm storage, **U** on a cluster)
- The chart has no value for the server configuration. Changing authentication means `nats.enabled: false` (`chart: values.yaml:54-56`) and a platform-owned server. **V**
- The server runs with `-DV` (`chart: templates/nats/deployment.yaml:50`). `-DV` turns on debug and trace (`nats-server: server/opts.go:6247-6249`), and at trace level the server logs the payload of each inbound and delivered message (`server/parser.go:516-517`, `server/client.go:3900-3903`) to the pod's log. **V**

### 2.2 What a tenant host presents

- The platform controller reads `wasmcloud-runtime-tls` from the platform namespace (`platform/platform/src/tenancy/controller.ts:994-996`) and copies its whole `data` into `di-scheduler-tls` in each `di-runtime-<tenant>` (`platform/platform/src/tenancy/resources.ts:1426-1432`). Every tenant holds the same private key as the platform's own host group. **V**
- The host mounts it read-only at `/scheduler` (`resources.ts:1548,1573`) and passes `--scheduler-nats-tls-{ca,cert,key}` (`resources.ts:1495-1505`). wash 2.8.0 has no other credential for the scheduler bus: its only scheduler authentication flags are the TLS ones (`wasmcloud: crates/wash/src/cli/host.rs:21-39`), and `connect_nats` adds only root certificates and a client certificate (`wasmcloud: crates/wash-runtime/src/washlet/mod.rs:294-341`). **V**
- The tenant host patches (`platform/tenant-host/0001-*.patch`, `0002-*`, `0003-*`) do not touch the scheduler connection. **V**
- Tenant hosts run `ghcr.io/di-framework/wash:2.8.0-wasi-tls` by default (`DEFAULT_HOST_IMAGE`, `platform/platform/src/index.ts:124-125`), or `2.8.0-wasi-tls-exclusive` through `tenantHostImage` (`platform/tenant-host/variants`). The design is the same for both. **V**

### 2.3 Subjects and the operator

| Direction | Subject | Source |
|---|---|---|
| host subscribes | `runtime.host.<host_id>.>` (`heartbeat`, `workload.start`, `workload.stop`, `workload.status`) | `wasmcloud: crates/wash-runtime/src/washlet/mod.rs:211-214,344-346,377-400` |
| host publishes | `runtime.operator.heartbeat.<host_id>` (plain publish, no reply) | `washlet/mod.rs:233-238,352-354` |
| host publishes | the reply to each command, to the request's reply subject | `washlet/mod.rs:241-247` |
| operator subscribes | `runtime.operator.heartbeat.>` | `wasmcloud: runtime-operator/internal/controller/runtime/host_controller.go:205` |
| operator requests | `runtime.host.<host_id>.<cmd>`, reply on a `_INBOX.` subject | `runtime-operator/internal/controller/runtime/host_client.go:31-37,84`; `runtime-operator/pkg/wasmbus/nats.go:166-175` |

- wash derives the command from the subject by skipping three tokens (`washlet/mod.rs:372`). The subject a host sees must therefore stay `runtime.host.<host_id>.<cmd>`. **V**
- `host_id` is a fresh UUIDv4 on every start (`wasmcloud: crates/wash-runtime/src/host/mod.rs:1198`), so no static permission can name "tenant A's hosts". **V**
- The operator decodes only the payload (`host_controller.go:211-213`). It upserts `Host/<friendlyName>` with `HostID`, `Environment` and labels copied from the payload. Its own comment says the heartbeat "is the source of truth and is not validated against cluster state" (`host_controller.go:229-251`). With `allowSharedHosts=false` placement matches `Host.Environment` against the workload namespace (`runtime-operator/internal/controller/runtime/workload_controller.go:126-170`). **V**
- `Host.Hostname` from the payload drives the host pod finalizer (`runtime-operator/internal/controller/runtime/host_pod_controller.go:81-110`) and the EndpointSlices of HTTP routes (`workload_route_controller.go:114-140`). **V**
- `workload.start` carries the resolved values of every `secretFrom` Secret and the image pull credentials (`runtime-operator/internal/controller/runtime/utils.go:82-94,109-149,158-180`). **V**
- The scheduler bus carries no tenant data or messaging traffic. That goes to each tenant's own `di-nats`, which this design does not change (`platform/platform/src/tenancy/registry-nats.ts:12-31,152-170`). **V**

### 2.4 Upstream position

- The chart's values call cross-tenant scheduling "permissive" and offer `allowSharedHosts=false` as the namespace boundary (`chart: values.yaml:165-180`). The heartbeat comment above shows that the operator does not authenticate the environment. **V**
- The wasmCloud v2 documentation defines no tenant boundary on the scheduler bus. wasmCloud v1's multi-tenant guidance was one NATS account per tenant. runtime-operator and wash 2.9 change nothing here. These points come from the owner's reading of upstream and were not re-checked for this note. **U**

### 2.5 Conclusion

Tenants have no distinct NATS identity, and the operator does not tie a heartbeat to its sender. Per-tenant certificates mapped to restricted users would still not be enough. A subject permission cannot name a tenant's hosts, and a forged payload would still misattribute a host. The design therefore changes three things together: the broker's accounts, the subjects the operator sees (through server-side mapping), and the operator's acceptance rule.

## 3. Target properties

- **P1 Broker-level isolation.** Credentials issued to tenant A cannot publish or subscribe to any subject that carries tenant B's scheduler traffic. The broker refuses it with an explicit permission violation, or the subject space of A's account has no route to B. Network policy is not needed for this property.
- **P2 No foreign heartbeats.** A heartbeat is attributed to the environment of the account that sent it, which the server adds. The operator rejects a heartbeat whose payload claims another environment or another host ID, whose host pod is not in that environment, or that would move an existing Host to another environment.
- **P3 Secrets reach only the target tenant.** A `workload.start` for a tenant's host is delivered only into that tenant's account, so only that tenant's host identity can receive it. The server does not log message payloads.
- **P4 Least privilege for every identity.** Each user can publish and subscribe only to the subjects its role needs (section 4.3). No identity other than the operator's has a wildcard over another account's traffic.
- **P5 Independent lifecycle.** Issuing, rotating or removing one tenant's identity reloads the server without disconnecting any other tenant. A removed or rotated identity is disconnected and can no longer authenticate, even while its certificate is still within its validity period.
- **P6 No shared secrets in tenant namespaces.** A tenant runtime namespace holds only that tenant's own key and the public CA bundle that verifies the server.
- **P7 Issuance cannot escape its scope.** The CA that signs tenant certificates can only sign names inside the tenant subtree, so neither a bug nor a stolen tenant CA key can produce the operator's or the platform's identity.

## 4. Design

### 4.1 The scheduler NATS leaves the chart

Helm values, enforced in `platformValues` (`platform/platform/src/values.ts:2-17`) the same way `hostNamespaces` and `allowSharedHosts` are, so that `args.values` cannot undo them:

| Value | Setting | Effect |
|---|---|---|
| `nats.enabled` | `false` | The chart renders no NATS Deployment, Service, ConfigMap or policy (`chart: templates/nats/*.yaml:1`). |
| `global.tls.enabled` | `true` (unchanged) | The operator and hosts still mount client certificates and pass the TLS flags (`chart: templates/operator/deployment.yaml:41-45`, `templates/runtime/deployment.yaml:195-205`). |
| `global.certificates.generate` | `false` | The chart generates no CA and no certificates (`chart: templates/certificates.yaml:2`). |
| `global.certificates.{operator,runtime,data}CertSecretName` | `di-scheduler-operator-tls`, `di-scheduler-platform-host-tls`, `di-scheduler-data-tls` | The chart mounts the platform-issued Secrets (`chart: values.yaml:36-41`). New names, so nothing can confuse them with the chart's former certificates. |
| `operator.image` | `ghcr.io/di-framework/runtime-operator`, tag `2.8.0-tenant-bus@sha256:<digest>` | The patched operator (4.6). The chart renders `<registry>/<repository>:<tag>` (`chart: templates/operator/deployment.yaml:39`), so a `tag@digest` value pins the digest. **U** for the rendered reference, to be checked with `helm template` in a unit test. |
| `operator.watchNamespaces` | the platform namespace plus every tenant namespace `di-tenant-<t>` | Replaces the chart ClusterRole's cluster-wide Secret read with namespaced Roles (section 4.9). |

The chart's default `schedulerUrl` already resolves to `nats://nats.<release-namespace>.svc.cluster.local:4222` (`chart: templates/_helpers.tpl:172`), and tenant hosts use the same URL (`platform/platform/src/tenancy.ts:297`). The platform-owned server therefore keeps the Service name `nats`, port 4222 and the pod label `wasmcloud.com/name: nats`. These are what the platform's policies (`platform/platform/src/platform-ingress.ts:56-77`, `platform/platform/src/tenancy.ts:213-247`) and the vCluster target's `allow-platform-nats` policy (`platform/operator/internal/targets/vcluster/networkpolicy.go:186-188`) select. No client changes its URL.

The platform renders these resources in the platform namespace, before the Helm release (4.5 covers the bootstrap):

- **Deployment `nats`**, one replica. Image `nats:2.12.8-alpine` pinned by digest. Arguments `-c /etc/nats/nats-server.conf` only, with no `-D` or `-V`, so payloads are never traced. The same hardened pod and container security context as the chart (`chart: values.yaml:74-92`). `automountServiceAccountToken: false`. `shareProcessNamespace: true` for the reloader.
- **Container `reloader`**: the upstream `nats-server-config-reloader` image, pinned by digest. It watches the config, the accounts file and the server certificate, and sends the server a reload signal through the shared process namespace and the server's `pid_file`. **U**: the flags come from the upstream NATS Helm chart and were not checked for this note.
- **ConfigMap `di-scheduler-nats`**: the static `nats-server.conf`. It sets `port`, `pid_file`, a `tls` block with `verify_and_map: true` and the server certificate from Secret `di-scheduler-nats-tls`, `ca_file` as a bundle of the platform CA and the tenant CA (current and next of each, 4.5), and `include "accounts/accounts.conf"`. The platform renders it and only `pulumi up` changes it.
- **ConfigMap `di-scheduler-nats-accounts`**: `accounts.conf`, which the platform controller writes (4.4).
- **Service `nats`**, port 4222, and a ServiceAccount without a token.
- JetStream is enabled at server level with the same `emptyDir` store as today (`chart: templates/nats/deployment.yaml:37-38,59-60`), and only for the `DATA` account (4.7, O6).

### 4.2 Accounts

| Account | Users | Purpose |
|---|---|---|
| `SCHEDULER` | the operator (`operator.platform.scheduler.di-framework.invalid`) | Receives heartbeats and sends commands, through imports only. |
| `HOSTS_<env>`, one per tenant, `<env>` = `di-tenant-<t>` | the tenant's current host identity, plus the previous one during a rotation (4.5) | That tenant's hosts. |
| `HOSTS_<platform-ns>` (default `HOSTS_wasmcloud`) | `host.platform.scheduler.di-framework.invalid` | The platform's own host group, `hostgroup-default` (4.7). |
| `DATA` | `data.platform.scheduler.di-framework.invalid` | The data connection of `hostgroup-default`. It has no imports or exports, so it cannot see scheduler traffic. |

`<env>` is the host's `--environment`. For tenant hosts that is the tenant namespace `di-tenant-<t>` (`resources.ts:1499`, `names()` at `resources.ts:878-885`). For `hostgroup-default` it is the pod's own namespace (`chart: templates/runtime/deployment.yaml:139-142,194`). Every value is a DNS label (`validName`, `resources.ts:886-890`), so it is a valid single NATS subject token. The renderer refuses a tenant whose environment equals the platform namespace.

### 4.3 Permissions, exports, imports and mappings

Shape of `accounts.conf` for one tenant `a` (other tenants and `HOSTS_wasmcloud` repeat the `HOSTS_` block and add two imports each to `SCHEDULER`):

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

- **Heartbeats (P2).** A host publishes `runtime.operator.heartbeat.<host_id>` in its own account. The stream import maps it to `runtime.operator.heartbeat.<env>.<host_id>` in `SCHEDULER` (`nats-server: server/accounts.go:2644-2690`, `server/opts.go:3774-3794`). The host's publish permission is exactly one token after the prefix (`runtime.operator.heartbeat.*`), so it cannot add tokens that look like another environment. **P**
- **Commands (P1, P3).** The operator requests `runtime.host.<env>.<host_id>.<cmd>`. The service import for `<env>` matches only that environment's token and delivers into that account as `runtime.host.<host_id>.<cmd>` (`server/accounts.go:2051-2110`, `server/opts.go:3795-3810`). The host sees exactly the subject wash parses (`washlet/mod.rs:372`). The reply returns through the service import's response mapping. **P**
- **Replies.** The host may publish only to reply subjects of requests it received (`allow_responses`, `nats-server: server/client.go:3876-3884,4153-4166`). `expires` is twice the operator's one-minute round-trip timeout (`host_client.go:17`). With `max: 1`, two subscriptions on the same connection that both match a request use up the single reply. wash has one subscription per host connection (`washlet/mod.rs:211-214`), so this does not affect it. **V/P**
- **Isolation (P1).** Host accounts share nothing with one another. A tenant user can subscribe to `runtime.host.*.>`, but in its own account that matches only its own hosts' commands. Everything else, including `>`, `_INBOX.>`, the heartbeat subjects, any `runtime.host.` publish and `$JS.API.>`, is refused with `Permissions Violation`. **P**
- **The operator (P4)** can only send commands and read heartbeats and its own replies. It is the one identity that reaches every host account, through the imports. It needs no JetStream and has none.

What a tenant host's identity can reach, in full: publish its own heartbeat, receive commands addressed to its own tenant's hosts, and reply to them. All hosts of one tenant share one identity. The boundary is the tenant (see O9).

### 4.4 Who renders the accounts file, and how it is reloaded

- **Owner.** The platform controller, which already reconciles every Tenant and its host group. It renders `accounts.conf` from the full list of Tenants on each pass, never incrementally. Accounts, users and imports are sorted, so an unchanged state renders identical bytes and causes no write and no reload. A removed Tenant therefore always drops out.
- **Inputs.** The Tenant list, the user names of each tenant's current and previous host certificate (read back from the certificates the controller issued, not from tenant input), and the platform namespace.
- **RBAC.** The controller's ClusterRole already covers ConfigMaps everywhere (`platform/platform/src/tenancy/install.ts:186-197`). The write is limited to the named ConfigMap by convention in code. Narrowing the controller's own RBAC is out of scope (O9).
- **Reload.** The kubelet updates the mounted ConfigMap. The reloader sees the change and signals the server. nats-server applies the account changes in place. Clients of unchanged accounts stay connected, and users that were removed are disconnected. **P** for the server's behaviour; **U** for the kubelet's propagation delay on the target clusters.
- **Ordering for a new or changed tenant.** The controller (1) issues the tenant certificate into `di-scheduler-tls`, (2) writes the accounts file, and (3) creates or rolls the host Deployment. If a host starts before the server has reloaded, its first connect is refused and the pod restarts with back-off until the account exists. **U**: that wash exits on a failed first connect needs confirming; `connect_nats` returns the connect error (`washlet/mod.rs:339-341`). The verification plan bounds this time (8.4).
- **Validation.** Before writing, the controller checks the rendered file against the account and user names it expects, and refuses a tenant whose name would produce an invalid token. A write is never partial: the whole file is one ConfigMap key.

### 4.5 Credentials: CAs, issuance, lifetimes and rotation

**Two CAs, both owned by the platform** (O2):

| CA | Signs | Name constraints (critical) |
|---|---|---|
| Platform scheduler CA | the NATS server certificate, the operator, `hostgroup-default` and the `DATA` user | DNS names `platform.scheduler.di-framework.invalid` and the four `nats` Service names (`nats`, `nats.<ns>`, `nats.<ns>.svc`, `nats.<ns>.svc.cluster.local`, as `chart: templates/certificates.yaml:70-75`); IP addresses excluded |
| Tenant scheduler CA | tenant host certificates only | DNS, email and URI names only under `tenants.scheduler.di-framework.invalid`; IP addresses excluded |

- nats-server maps a client certificate to a user by email SAN, then DNS SAN, then URI SAN, then the subject DN (`nats-server: server/auth.go:1267-1340`). With the tenant CA constrained in every SAN form, a certificate it signs cannot carry any platform user name. The probe confirms that the TLS handshake refuses a tenant-CA certificate naming the operator by DNS SAN or by email SAN, and that a subject-only certificate maps to no user (`Authorization Violation`). **P**
- `ca_file` is the bundle of both CAs. Only the platform CA is distributed to clients, which use it to verify the server.
- `.invalid` (RFC 2606) guarantees that these identity names never resolve and cannot be confused with a server name.
- `platform/platform/src/tenancy/tls.ts` already writes CA certificates with DNS name constraints and an IP exclusion (`tls.ts:83-110,247-260`). It needs a permitted email subtree and a permitted URI subtree, plus a client-auth leaf: `leafCertificate` sets only `serverAuth` (`tls.ts:389`), and nats-server, built in Go, verifies client certificates for `clientAuth`. **V** for the code; the EKU requirement is standard Go `crypto/tls` behaviour, **U** in this note.

**Identities:**

| Identity | NATS user (DNS SAN) | Secret | Mounted by |
|---|---|---|---|
| NATS server | the `nats` Service names | `di-scheduler-nats-tls` (platform ns) | `nats` |
| Operator | `operator.platform.scheduler.di-framework.invalid` | `di-scheduler-operator-tls` (platform ns) | `runtime-operator` |
| Platform host group | `host.platform.scheduler.di-framework.invalid` | `di-scheduler-platform-host-tls` (platform ns) | `hostgroup-default` |
| Platform data | `data.platform.scheduler.di-framework.invalid` | `di-scheduler-data-tls` (platform ns) | `hostgroup-default` |
| Tenant `<t>` hosts | `<issuance-id>.di-tenant-<t>.tenants.scheduler.di-framework.invalid` | `di-scheduler-tls` (`di-runtime-<t>`): `tls.crt`, `tls.key`, and `ca.crt` = platform CA bundle | `hostgroup-tenant-<t>` |
| Both CA keys | none | `di-scheduler-ca` (platform ns) | **no pod** |

- `<issuance-id>` is 16 random hex characters, new for every certificate the controller issues. A user name therefore names one certificate. Re-creating a tenant with the same name, or rotating its certificate, produces a new user. The old certificate stops authenticating as soon as the accounts file drops its name, without waiting for expiry and without revocation lists. **P** (the probe's removed user is refused with `Authorization Violation` while its certificate is still valid)
- The CA keys are kept in a Secret that no pod mounts. On the vCluster target that keeps them out of the host namespace, because vCluster syncs only Secrets a pod uses (`vcluster: values.yaml:26-30`). **V**

**Lifetimes and rotation** (O3):

- CAs: 10 years, rotated with the controller's existing CA machinery: publish a successor 90 days before expiry, trust both for 30 days, then switch (`platform/platform/src/tenancy/ca-rotation.ts:13-25,140-215`). `ca_file` and each `ca.crt` carry current and next.
- Leaves: 90 days, renewed when 30 days remain (`LEAF_RENEW_DAYS`, `ca-rotation.ts:20`).
- Tenant leaf renewal: issue the new certificate, keep the previous user in the accounts file, roll only that tenant's host Deployment through a certificate-digest pod annotation (the pattern used for the registry CA, `resources.ts:1456-1466`), and drop the previous user once the rollout has finished. If the rollout does not finish, the previous user is dropped when its certificate expires.
- Forced rotation of one tenant: deleting `di-scheduler-tls` makes the controller issue a new identity and roll that tenant, as deleting the registry pull Secret does for its token (`controller.ts:735-745`).
- Operator renewal needs no restart. nats.go reloads the client certificate files on every TLS handshake (`nats.go: nats.go:1212-1234`), and an established connection is not re-authenticated. **V**
- `hostgroup-default` renewal: the controller restarts that Deployment through a pod-template annotation, because wash's behaviour on reconnect was not checked. **U**: that Helm keeps an annotation it did not render needs checking.
- Server renewal: the reloader sees the Secret change and the server reloads its certificate. Clients verify it with the CA bundle.
- Tenant removal: the Tenant leaves the accounts file. The reload disconnects its hosts, and `di-scheduler-tls` is deleted with the runtime namespace.

**Bootstrap** (O4). The `nats` Deployment, the operator and `hostgroup-default` must be ready before the Helm release finishes (`atomic: true`, `index.ts:372-381`). The platform controller is deployed after the release. A one-shot Job in the platform namespace therefore runs before the NATS Deployment and the Helm release. It uses the platform controller's image and code with a `scheduler-pki` entry point, and it does what the controller's reconcile would do for the platform identities: create `di-scheduler-ca` and the four platform leaf Secrets if they are missing, and write the initial `accounts.conf` with no tenants. Its ServiceAccount may `get`/`create` only those named Secrets and that ConfigMap in the platform namespace. No key ever enters Pulumi state. From then on the controller is the only writer.

### 4.6 The runtime-operator patch

**Scope.** One patch, `0001-tenant-scheduler-bus.patch`, against `wasmcloud: runtime-operator/`:

1. **Heartbeat subject.** `hostStatusUpdater` passes `msg.Subject` (`wasmcloud: runtime-operator/pkg/wasmbus/bus.go:78-83`) to `handleHeartbeat` (`host_controller.go:211-213`). It accepts only `runtime.operator.heartbeat.<env>.<host_id>`, exactly five tokens. Anything else is dropped, logged and counted.
2. **Payload agreement.** It rejects the heartbeat unless `req.Environment == <env>` and `req.Id == <host_id>`.
3. **Pod binding.** `req.Hostname` must resolve to a host pod (label `wasmcloud.com/hostgroup`, `host_pod_controller.go:27`) in the operator's host namespaces, the same way the route controller resolves it (`workload_route_controller.go:114-140,256-275`). That pod's environment must be `<env>`. A pod's environment is its label `runtime.wasmcloud.dev/environment` when present, otherwise its namespace. The platform sets the label on tenant host pods, which run in `di-runtime-<t>` but serve `di-tenant-<t>`. Tenant roles cannot create pods (`resources.ts:1108-1151`), so only the platform and the chart create host pods.
4. **No takeover.** The Host object gets the label `runtime.wasmcloud.dev/bus-environment=<env>` from the subject. It overrides any label of that name copied from the payload (`host_controller.go:246`). A heartbeat for an existing Host whose label names another environment is rejected.
5. **Addressing.** `NewWashHostClient` takes the environment. Subjects become `runtime.host.<env>.<host_id>.<cmd>` (`host_client.go:19-37`). Every caller (`host_controller.go:61`, `workload_controller.go:383,403,437`) takes `<env>` from the Host's `bus-environment` label, never from a Workload field. A Host without the label gets no command.
6. **No compatibility path.** The patched operator has no flag and no fallback to the unprefixed subjects.

Unit tests in the patch cover each rejection (subject shape, payload mismatch, pod in another environment, takeover) and the new command subjects.

**Where the fork lives and how it is built**, mirroring `platform/tenant-host/`:

- `platform/runtime-operator/`: the patch, a README, and a `Dockerfile` that clones wasmCloud at the tag, fails unless `HEAD` is the pinned commit, runs `git apply --check` and then applies the patch, and builds `./runtime-operator/cmd` as upstream's Dockerfile does (`wasmcloud: runtime-operator/Dockerfile`). Build and runtime base images are pinned by digest, as in `platform/tenant-host/Dockerfile:15-58`. With a single variant there is no `variants` table. The image tag is `2.8.0-tenant-bus`.
- `.github/workflows/runtime-operator-image.yml`, modelled on `tenant-host-image.yml`: it triggers on pushes to `main` that change `platform/runtime-operator/**` or the workflow, skips a source that is already published (`src-<hash>`, `scripts/source-check.ts`), builds amd64 and arm64 on native runners, merges the index, and opens a `bot/pin-runtime-operator` PR.
- `.github/workflows/runtime-operator-patch-check.yml`, modelled on `tenant-host-patch-check.yml`: it applies the patch to the pinned commit on pull requests and runs `go test ./internal/controller/runtime/...` plus the broker test (8.2).
- `scripts/pin-artifact.ts` gets a `runtime-operator` artifact (`ARTIFACTS`, `scripts/pin-artifact.ts:70`) that rewrites the operator image constant in `platform/platform/src/index.ts` and the pinned reference in the fork's README.
- The patch has no di-framework concepts. The environment token and the pod-environment label are generic. It is worth offering upstream once it ships (O8).

### 4.7 `hostgroup-default` and the operator's own identity

- **`hostgroup-default` stays** (O1). It serves the platform namespace (`platform/platform/src/index.ts:425-438`, `wasmcloud-http`) and is treated like a tenant: its own account `HOSTS_<platform-ns>` with the same host permissions and mappings, its environment token the platform namespace, and its own certificate from the platform CA. The patched operator applies the same rules to it. There is no unprefixed path left for anyone.
- Its data connection uses the `DATA` user, in an account with no imports or exports. It can no longer see scheduler subjects. That account keeps JetStream so that any NATS key-value or blobstore use on `hostgroup-default` keeps working (O6). Whether anything uses it is not known.
- **The operator** keeps the chart's Deployment, flags and mount path (`chart: templates/operator/deployment.yaml:31-45`). Only the Secret (`di-scheduler-operator-tls`) and the image change. Its user lives alone in `SCHEDULER` with the permissions in 4.3.

### 4.8 Tenant hosts

- `controller.ts:994-996` stops reading `wasmcloud-runtime-tls`. The controller issues the tenant certificate instead (4.5). The host Deployment's readiness gate (`controller.ts:1028`) waits for that certificate.
- `di-scheduler-tls` holds only the tenant's own key and certificate and the platform CA bundle (P6). Flags, mount path and URL stay the same (`resources.ts:1495-1505,1548,1573`).
- The host pod template gets the label `runtime.wasmcloud.dev/environment: di-tenant-<t>` (4.6, item 3) and the certificate-digest annotation (4.5).
- A pod that mounts `di-scheduler-tls` holds one tenant's identity, not the platform's. Paths that need pod creation in `di-runtime-<t>`, such as backup Jobs, therefore reach only that tenant (`platform/backup-destination/chart/templates/runtime.yaml:1-60`).

### 4.9 Platform-side exposure on the vCluster target: closed or left

From the access-surface review. Each item is either closed by this work or explicitly left, with a reason.

| Exposure | Decision |
|---|---|
| Trace logging of message payloads in the NATS pod's logs, readable wherever `pods/log` on that pod is granted, including the host `view` role in `pi-*` | **Closed.** The platform's NATS runs without `-D`/`-V` (4.1). |
| Runtime-operator ServiceAccount with cluster-wide Secret read (`chart: templates/operator/clusterrole.yaml:1,58-66`, because no `watchNamespaces` is set) | **Closed.** `operator.watchNamespaces` = the platform namespace plus every tenant namespace (`di-tenant-<t>`, where WorkloadDeployments and their `secretFrom` Secrets live). The chart then binds namespaced Roles (`chart: templates/operator/workload-namespace-role.yaml:1-30`) and drops the ClusterRole. The list follows the same lifecycle as `hostNamespaces` (`platform/platform/src/watched-namespaces.ts:150-200`). The operator still reads Secrets in the platform namespace. It is the bus's most privileged identity, so this does not widen its reach on the bus. |
| The runtime-operator's virtual ServiceAccount token stored as a host pod annotation in `pi-*`, readable with host `get pods` (the built-in `view` role) | **Closed.** The operator's vCluster values set `sync.toHost.pods.useSecretsForSATokens: true` (`vcluster: values.yaml:46-48`; `platform/operator/internal/targets/vcluster/defaults.go:30-60`). The token becomes a host Secret, which `view` cannot read. **U**: the effect on existing operator tests and on a running instance. |
| A tenant runtime namespace holding the platform's key, including its synced host copy `di-scheduler-tls-x-…` | **Closed.** Each tenant's copy is only its own identity (P6). |
| The CA key in synced Secrets and in Helm release history | **Closed** for the scheduler bus. No pod mounts a CA key, and no key is in a Helm manifest (4.5). |
| Synced copies in `pi-*` of the platform identities that pods must mount (operator, platform host, data, server), readable with host `get secrets` (the built-in `edit`/`admin` roles), and `pods/portforward` to the NATS pod in `pi-*` | **Left, explicitly.** Pods need these Secrets, so vCluster must sync them. Host `edit`/`admin` in a `pi-*` namespace equals instance admin. The operator README should state that, and a separate operator issue should track it. |
| The vCluster admin kubeconfig, vCluster's unencrypted state store, node and hostPath access, and host cluster admin | **Left.** These are instance-admin or host-admin by design ("instance owners are trusted in v1alpha1"). They are outside the scheduler bus. |
| The platform controller's cluster-wide Secret read | **Left** (O9). The controller is the issuer. Narrowing its RBAC is a separate change. |

## 5. Non-goals

- Isolation between hosts of the same tenant. All of a tenant's hosts share one identity (O9).
- Changes to `di-nats`, the per-tenant data bus (2.3).
- Encryption of `workload.start` payloads end to end. The broker sees plaintext. P3 limits who can receive them.
- Patching wash. The scheduler connection needs no change because the server maps the subjects.
- Migration, rollout phases, compatibility with unpatched operators or the chart's certificates, and release notes (owner direction). Existing development instances are reinstalled.

## 6. Code that changes when this is implemented

- `platform/platform/src/index.ts`, `values.ts`: chart values (4.1), the operator image constant, `watchNamespaces`, and the NATS resources, the bootstrap Job and its RBAC, ordered before the Helm release.
- `platform/platform/src/tenancy/tls.ts`: email and URI name constraints, and a client-auth leaf.
- `platform/platform/src/tenancy/` (a new `scheduler-nats.ts`, plus `controller.ts` and `resources.ts`): issuance, rotation, the accounts renderer, the host label and annotation, and removal of the `wasmcloud-runtime-tls` copy.
- `platform/runtime-operator/` (new), `.github/workflows/runtime-operator-image.yml`, `.github/workflows/runtime-operator-patch-check.yml`, `scripts/pin-artifact.ts`.
- `platform/operator/internal/targets/vcluster/defaults.go`: `useSecretsForSATokens`.
- READMEs: `platform/platform/README.md` (the scheduler bus and its identities) and `platform/operator/README.md` (`pi-*` host RBAC equals instance admin).

## 7. Considered and rejected

- **Per-tenant certificates mapped to restricted users in one account.** Rejected. Host IDs are random, so no permission can name a tenant's hosts, and the operator would still trust the payload (2.5).
- **Auth callout (NATS 2.10 and later)** in the controller, minting scoped user JWTs from the client certificate. It needs no config reloads, but it puts a service in the authentication path of every connection, and it still needs the mappings and the operator patch. Static accounts are simpler at this scale.
- **Operator mode with NKeys or creds files.** wash has no creds option for the scheduler bus (`host.rs:21-39`), so this would need a wash patch.
- **A tenant token in the subjects the hosts publish.** wash builds its subjects itself (`washlet/mod.rs:344-354`), so this would need a wash patch, and a token chosen by the client proves nothing. Server-side mapping needs neither.
- **One CA for every identity.** It works, but a bug in tenant issuance could then mint a platform name. Two CAs with name constraints bound the damage for little extra code (O2).

## 8. Verification

### 8.1 Unit tests (`bun test` in `platform/platform`)

- Accounts renderer: one account per tenant plus the three platform accounts; exact permissions; two imports per host account with the right tokens; sorted, byte-stable output; a removed Tenant disappears; the previous user is present only during a rotation; an invalid name is refused. A golden file is shared with the broker test.
- Issuance: client-auth EKU; the SAN form; name constraints on both CAs, so the tenant CA refuses a platform name; lifetimes and the renewal threshold; a new issuance ID for every issue; `di-scheduler-tls` holds only the tenant's key and the platform CA bundle.
- Chart values: `nats.enabled=false`, `generate=false`, the Secret names, the pinned operator image and `watchNamespaces`, all enforced over `args.values`; a `helm template` render of the operator image reference.
- The controller no longer reads `wasmcloud-runtime-tls`. Host pods carry the environment label and the certificate-digest annotation.

### 8.2 Fork CI (no cluster)

- The patch applies to the pinned commit, and the operator's unit tests pass, including the new rejection tests.
- **Broker test.** nats-server 2.12.8, run in process with the golden `accounts.conf` and freshly minted CAs, repeats the probe matrix of section 9. It runs with no network policy, so only the broker's permissions are under test.

### 8.3 Layer 3

Two tenants and the platform host group: hosts register, workloads are placed and run on each, and Layer 3 passes. Host objects carry the right `bus-environment` labels.

### 8.4 Layer 4, against the broker with tenant A's credentials

The client runs as a pod in `di-runtime-a` labelled `wasmcloud.com/name=hostgroup`, mounting `di-scheduler-tls` read-only and running a digest-pinned NATS CLI image. The platform's NATS ingress rule admits that pod, so network policy cannot mask a missing broker permission. The harness creates it with the instance admin kubeconfig. Record the broker's exact response for each step.

1. Publish to `runtime.host.<B-host-id>.workload.status`, `runtime.host.di-tenant-b.<B-host-id>.workload.status`, `runtime.operator.heartbeat.di-tenant-b.<id>` and `$JS.API.INFO`: each gets `Permissions Violation for Publish`.
2. Subscribe to `>`, `runtime.operator.heartbeat.>` and `_INBOX.>`: each gets `Permissions Violation for Subscription`.
3. Subscribe to `runtime.host.*.>` (allowed; A's own subject space). While it is open, deploy a workload in tenant B whose `secretFrom` value is a unique marker, and one in tenant A. A's subscription receives A's `workload.start` (positive control) and nothing with B's marker. For this subject the boundary is the account, not a permission, so the evidence is non-delivery plus the control.
4. Publish a heartbeat for a new host ID that claims B's environment in its payload. The operator logs and counts the rejection, no Host with environment `di-tenant-b` appears for that ID, and no B workload is placed on it. The same goes for a payload whose `hostname` is a pod of tenant B.
5. Rotation: force a new identity for A. A's hosts roll and keep scheduling. A's old certificate then gets `Authorization Violation`. Tenant B shows no reconnect and no restart.
6. Removal: delete tenant B. B's hosts are disconnected and B's certificate gets `Authorization Violation`. A shows no reconnect and no restart, and still schedules.
7. `di-scheduler-tls` in A and in B have different public-key fingerprints. No `wasmcloud-runtime-tls` and no `wasmcloud-ca` exist.
8. The NATS pod's log has no `MSG_PAYLOAD` lines after a deploy.
9. `kubectl auth can-i get secrets --as=system:serviceaccount:<platform-ns>:<runtime-operator-sa>` is `no` in `di-runtime-a` and in `kube-system`, and `yes` in `di-tenant-a`.
10. On the vCluster target, the host `pi-*` copy of the runtime-operator pod has no `vcluster.loft.sh/token-*` annotation.
11. Time from Tenant creation to the first registered host, so the reload delay of 4.4 is measured.

## 9. Evidence from the design probe

A local program (not committed) ran nats-server v2.12.8 in process with the configuration of 4.3. It used three host accounts (`wasmcloud`, `di-tenant-a`, `di-tenant-b`), a platform CA and a tenant CA with name constraints on DNS, email and URI names and IPs excluded, and client certificates for each identity. No cluster was involved. All 25 checks passed:

- **Connections.** The operator, both tenants and the platform host connect with their certificates.
- **Mapping.** A heartbeat published as `runtime.operator.heartbeat.HA` by A arrives as `runtime.operator.heartbeat.di-tenant-a.HA`. The platform host's arrives with `wasmcloud`. A's heartbeat with an extra token is refused.
- **Commands and replies.** Requests to `runtime.host.di-tenant-a.HA.workload.status` and to B's host return each host's own reply. A's host sees `runtime.host.HA.workload.status`.
- **Isolation.** A's `runtime.host.*.>` subscriber, on a separate connection, received none of B's `workload.start`, while B's received its own.
- **Refusals.** For A: publish `runtime.host.HB.workload.status`, publish `runtime.host.di-tenant-b.HB.workload.status`, publish `$JS.API.INFO`, and subscribe to `runtime.operator.heartbeat.>`, `>` and `_INBOX.>` each returned `Permissions Violation`.
- **Forged certificates.** Tenant-CA certificates naming the operator by DNS SAN or email SAN failed the TLS handshake (`bad certificate`). With only a subject CN, the certificate mapped to no user (`Authorization Violation`).
- **Reload.** A reload without tenant B disconnected B, A stayed reachable, and B's still-valid certificate was then refused (`Authorization Violation`).

The first run also found the `allow_responses` interaction in 4.3: two matching subscriptions on one connection use up `max: 1`.

## 10. Open questions for the owner

Each has a recommendation. Section 4 is written as if the recommendations are accepted.

- **O1 `hostgroup-default`.** Keep it with its own host account, or remove the platform host group altogether? *Recommendation: keep it, treated like a tenant (4.7).* The gateway's default backend and platform-namespace workloads depend on it, and treating it uniformly leaves no unprefixed path.
- **O2 CA layout.** One platform CA, or a platform CA plus a name-constrained tenant CA? *Recommendation: two CAs (4.5).* It costs one more Secret key, and it means no tenant issuance can produce a platform identity.
- **O3 Leaf lifetime.** 90 days renewed at 30 days left, or shorter, such as 30 days? *Recommendation: 90/30.* Each renewal rolls the tenant's hosts, and storage hosts are replaced without a surge (`resources.ts:1436-1442`), so a renewal briefly interrupts that tenant. Revocation does not depend on lifetime, because each issuance has its own user name.
- **O4 Bootstrap.** A one-shot PKI Job before the Helm release, or keys generated by the Pulumi program? *Recommendation: the Job (4.5).* It keeps keys out of Pulumi state and needs no change to the order in which the controller starts.
- **O5 Pod binding in the operator patch.** Include the check that `Hostname` belongs to a host pod of the claimed environment (4.6, item 3), or ship only the subject and payload checks? *Recommendation: include it.* Without it, a host could still point another environment's routing and pod finalizer at a pod it does not own.
- **O6 JetStream.** Keep it for the `DATA` account only, or turn it off? *Recommendation: keep it for `DATA` only.* No scheduler identity uses JetStream. Whether any `hostgroup-default` workload does is unknown (access-surface evidence gap).
- **O7 vCluster exposure.** Close the virtual ServiceAccount token annotation, the trace logs and the runtime-operator's cluster-wide Secret read in this work, and leave host `edit`/`admin`/exec in `pi-*` as instance-admin-equivalent? *Recommendation: yes (4.9),* plus a separate operator issue that documents and tracks `pi-*` RBAC.
- **O8 Upstreaming.** Offer the operator patch to wasmCloud? *Recommendation: yes, after it ships here. It does not block this work.* The patch is generic, and upstream's own comment acknowledges the unvalidated heartbeat.
- **O9 Out of scope here.** Per-host identities within a tenant, and narrowing the platform controller's cluster-wide Secret read. *Recommendation: leave both out. File an issue for the controller's RBAC.* The tenant is the isolation unit this issue asks for, and the controller is the issuer.

## 11. Unverified items

These are marked **U** above. The implementation or Layer 4 must confirm them:

1. The reloader image's flags, and the kubelet's propagation delay for ConfigMaps and Secrets on the target clusters (4.1, 4.4, 8.4 step 11).
2. That wash exits and restarts on a failed first connect, and how it behaves when it reconnects after a certificate change (4.4, 4.5).
3. The rendered `tag@digest` operator image reference (4.1).
4. That Helm keeps a pod-template annotation the controller adds to `hostgroup-default` (4.5).
5. The effect of `useSecretsForSATokens: true` on the operator's tests and on a running instance (4.9).
6. The upstream statements in 2.4: the v2 and v1 documentation, and the runtime-operator 2.9 changes.
7. Whether any `hostgroup-default` workload uses JetStream (O6).
