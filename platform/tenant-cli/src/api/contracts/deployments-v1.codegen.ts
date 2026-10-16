import {
  Deployment,
  DeploymentList,
  DeploymentStats,
  Empty,
  RollbackRequest,
} from './api.schemas.ts';
import { env, manifest, operation, queryParameter } from './manifest.ts';

const schema = { module: './api.schemas.ts' };

export default manifest(
  'deployments',
  '/v1',
  {
    Empty: { schema: Empty, ...schema },
    Deployment: { schema: Deployment, ...schema },
    DeploymentList: { schema: DeploymentList, ...schema },
    DeploymentStats: { schema: DeploymentStats, ...schema },
    RollbackRequest: { schema: RollbackRequest, ...schema },
  },
  [
    operation(
      'deployments',
      {
        method: 'GET',
        path: '/deployments',
        successStatus: 200,
        summary: 'List deployments',
        description: 'Deployments of the environment, newest first, optionally for one service.',
        parameters: [env, queryParameter('service', { type: 'string' })],
      },
      'Empty',
      'DeploymentList',
    ),
    operation(
      'deploymentStats',
      {
        method: 'GET',
        path: '/deployments/stats',
        successStatus: 200,
        summary: 'Summarize deployments',
        parameters: [env],
      },
      'Empty',
      'DeploymentStats',
    ),
    operation(
      'rollback',
      {
        method: 'POST',
        path: '/deployments/rollback',
        successStatus: 202,
        summary: 'Roll a service back',
        description:
          'Starts a rollout of an earlier deployment, the previous one unless `to` names it.',
      },
      'RollbackRequest',
      'Deployment',
    ),
    operation(
      'removeDeployment',
      {
        method: 'DELETE',
        path: '/deployments/:service',
        successStatus: 204,
        summary: 'Remove a deployed service',
        description:
          'Removes the service from the environment: its WorkloadDeployment (running or not), its ServiceBindings and its deploy history. 404 when the environment has none of them.',
        parameters: [env],
      },
      'Empty',
      'Empty',
    ),
  ],
);
