import { notImplemented, type V1Module } from './context.ts';

/** `/v1/deploy` and `/v1/deployments` (platform#55). */
export const deploy: V1Module = {
  previewDeploy: notImplemented('previewDeploy'),
  deploy: notImplemented('deploy'),
  pushCredential: notImplemented('pushCredential'),
  deployments: notImplemented('deployments'),
  deploymentStats: notImplemented('deploymentStats'),
  rollback: notImplemented('rollback'),
};
