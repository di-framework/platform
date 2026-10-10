# Diagnosis: identity `hostgroup-tenant-identity` apply returns 409 (#57)

Observed read-only on the `authproto` cluster on 2026-10-09 (`kubectl get ... --show-managed-fields -o yaml`).

## Verdict

Hypothesis (b) holds. Hypothesis (a) is not observed.

The Deployment `hostgroup-tenant-identity` (ns `di-runtime-identity`) has exactly three managers:

| Manager | Operation | Owns |
| --- | --- | --- |
| `di-platform-controller` | Apply (2026-10-07T23:42:28Z, its only apply) | labels, selector, pod template (containers, env, volumes, securityContext). Env `WASH_CORE_INSTANCES` is owned by name only |
| `kubectl-set` | Update (2026-10-08T04:57:08Z) | `spec.template.spec.containers[name=host].env[name=WASH_CORE_INSTANCES].value` |
| `kubesolo` | Update, subresource `status` | status fields |

The only conflicting field is `.spec.template.spec.containers[name="host"].env[name="WASH_CORE_INSTANCES"].value`.
The #38 hand edit (`kubectl set env ... WASH_CORE_INSTANCES=300`) is an Update, which took ownership of the value from the applier. The live value is `"300"`. The platform declares `{ name: 'WASH_CORE_INSTANCES', value: '100' }` (`platform/src/tenancy/resources.ts:669`). Applying a different value to a field owned by another manager, without `force`, is a 409. The Tenant stays `Ready=False / ReconcileError` while the guest keeps serving.

No Pulumi (`pulumi-kubernetes*`) manager exists on this Deployment, and `spec.strategy` is the Kubernetes default (`25%/25%`) with no owner. So the identity-server `DeploymentPatch` resources (`tenant-host-rollout`, `tenant-host-secrets`) have not applied to this object and are not the cause of this 409.

## Running controller version

The Tenant status message is `PATCH /apis/apps/v1/namespaces/di-runtime-identity/deployments/hostgroup-tenant-identity returned 409`, with no manager or field detail. The running controller therefore predates #64 (`:conflict-logging`). Once it is upgraded, the message will name `kubectl-set` and the field above, which confirms this directly. The recorded applied set (no `replicas`, no `strategy`) also shows the last successful apply was by a controller older than #104.

## Co-ownership example: `hostgroup-tenant-acme` (ns `di-runtime-acme`)

Managers: `di-platform-controller` (Apply, 2026-10-07T23:42:25Z), `kubectl-patch` (Update, 2026-10-09T20:22:26Z), `kubesolo` (status). `kubectl-patch` owns `spec.strategy.rollingUpdate.maxSurge` and `maxUnavailable` (live `0` / `1`, the manual workaround for #99). `WASH_CORE_INSTANCES` is `"100"` and still owned by the controller. The Tenant is `Ready=True`.

Co-ownership is harmless while values agree: server-side apply lets several managers own a field with an identical value, and only a different value is a conflict. #104 declares `maxSurge: 0, maxUnavailable: 1`, the same values `kubectl-patch` set, so acme's next apply makes the controller a co-owner with no 409. Identity's strategy is currently unowned defaults. #118 showed that the 409 on `WASH_CORE_INSTANCES` blocks the whole apply, so #104's `strategy` is not set on identity until the ownership cleanup in `README.md` ("Tenant host core instances") is done; the first successful apply then lands it together with any accumulated pod-template changes.

## Will #104's `strategy` make identity worse?

No, as long as identity-server's Pulumi patch keeps the same values. Pulumi's `DeploymentPatch` declares `strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }` (`identity-server/deploy/platform/index.ts` ~245 and ~418), identical to #104, so the two appliers share ownership. It becomes a conflict only if either side changes its values. The `WASH_CORE_INSTANCES` conflict is independent of `strategy`.

## What each owner should do

- Platform: no strategy knob needed. Ship the #64 controller so future 409s name their managers. Do not add `force=true`.
- Clearing the current 409 is an operator action (not done here). The live `300` conflicts with the declared `100`: either the cluster operator force-applies the declared value as the controller, or the platform gains the knob below and the Tenant declares 300.
- identity-server#49: drop the `strategy` block from `tenant-host-rollout` and `tenant-host-secrets` (the platform owns it since #104), keeping only the pod-template annotations (`host-image` digest, `runtime-secrets` digest), which do not overlap platform-owned fields. Never edit env on the platform-owned Deployment by hand.
- #38 design: yes, it needs a platform knob. `WASH_CORE_INSTANCES` is hard-coded to `100` in `resources.ts`. Add a per-Tenant setting (for example `spec.runtime.coreInstances`, default `100`) that the controller applies, so a tenant needing 300 declares it on the Tenant CR and nobody patches the Deployment out of band.
