import { DeployBundle, Deployment, DeployPlan, Empty, PushCredential } from './api.schemas.ts';
import { manifest, operation } from './manifest.ts';

const schema = { module: './api.schemas.ts' };

export default manifest(
  'deploy',
  '/v1',
  {
    DeployBundle: { schema: DeployBundle, ...schema },
    DeployPlan: { schema: DeployPlan, ...schema },
    Empty: { schema: Empty, ...schema },
    Deployment: { schema: Deployment, ...schema },
    PushCredential: { schema: PushCredential, ...schema },
  },
  [
    operation(
      'previewDeploy',
      {
        method: 'POST',
        path: '/deploy/preview',
        successStatus: 200,
        summary: 'Preview a deployment',
        description:
          'Validates the bundle and reports what applying it would change in the given environment, without changing anything.',
      },
      'DeployBundle',
      'DeployPlan',
    ),
    operation(
      'deploy',
      {
        method: 'POST',
        path: '/deploy',
        successStatus: 202,
        summary: 'Apply a deployment',
        description:
          'Validates the bundle and starts the rollout. Progress is streamed by the logs operation of the service.',
      },
      'DeployBundle',
      'Deployment',
    ),
    operation(
      'pushCredential',
      {
        method: 'POST',
        path: '/deploy/push-credential',
        successStatus: 200,
        summary: 'Get a registry push credential',
        description:
          'Returns a short-lived registry token scoped to the tenant repository path. The controller mints it as the registry token service; pushes go straight to the registry.',
      },
      'Empty',
      'PushCredential',
    ),
  ],
);
