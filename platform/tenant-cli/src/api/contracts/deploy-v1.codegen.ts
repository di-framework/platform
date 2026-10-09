import { DeployBundle, Deployment, DeployPlan, Empty, RegistryInfo } from './api.schemas.ts';
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
    RegistryInfo: { schema: RegistryInfo, ...schema },
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
      'registry',
      {
        method: 'GET',
        path: '/deploy/registry',
        successStatus: 200,
        summary: 'Get the tenant registry',
        description:
          "The tenant's own OCI registry: its URL and how to log in. Pull is open to viewers and developers; push needs developer. No credential is minted.",
      },
      'Empty',
      'RegistryInfo',
    ),
  ],
);
