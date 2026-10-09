import type { OperationName } from '@di-framework/tenant-cli/src/api/handlers.ts';
import type { Principal } from '../identity.ts';

export type Role = Principal['role'];

const EVERYONE: readonly Role[] = ['developer', 'viewer'];
const DEVELOPERS: readonly Role[] = ['developer'];

/**
 * Which tenant roles may call each `/v1` operation. The role is the caller's membership in this
 * tenant on their `User` resource. A viewer is read-only: it may read, preview, and manage its own
 * credential, but nothing that changes the tenant. Typed as a full record, so a new contract
 * operation does not compile until it declares a policy.
 */
export const POLICY: Record<OperationName, readonly Role[]> = {
  authInfo: EVERYONE,
  whoami: EVERYONE,
  logout: EVERYONE,
  previewDeploy: EVERYONE,
  deploy: DEVELOPERS,
  createService: DEVELOPERS,
  logs: EVERYONE,
  proxy: DEVELOPERS,
  deployments: EVERYONE,
  deploymentStats: EVERYONE,
  rollback: DEVELOPERS,
  secrets: EVERYONE,
  setSecret: DEVELOPERS,
  updateSecret: DEVELOPERS,
  unsetSecret: DEVELOPERS,
  vars: EVERYONE,
  setVar: DEVELOPERS,
  updateVar: DEVELOPERS,
  unsetVar: DEVELOPERS,
};

/** Whether `role` may call `operation`; an operation without a policy is denied to everyone. */
export const permits = (operation: OperationName, role: Role): boolean =>
  POLICY[operation]?.includes(role) ?? false;
