import { ConfigList, ConfigValue, Empty, SecretList } from './api.schemas.ts';
import { env, manifest, operation } from './manifest.ts';

const schema = { module: './api.schemas.ts' };
const schemas = {
  Empty: { schema: Empty, ...schema },
  ConfigList: { schema: ConfigList, ...schema },
  ConfigValue: { schema: ConfigValue, ...schema },
  SecretList: { schema: SecretList, ...schema },
};

/** `secrets` and `vars` share one shape; secrets are write-only on read. */
function entries(noun: 'secret' | 'var', readDescription: string) {
  const plural = `${noun}s`;
  const title = noun === 'secret' ? 'Secret' : 'Var';
  return [
    operation(
      plural,
      {
        method: 'GET',
        path: `/${plural}`,
        successStatus: 200,
        summary: `List ${plural}`,
        description: readDescription,
        parameters: [env],
      },
      'Empty',
      noun === 'secret' ? 'SecretList' : 'ConfigList',
    ),
    operation(
      `set${title}`,
      {
        method: 'PUT',
        path: `/${plural}/:name`,
        successStatus: 204,
        summary: `Set a ${noun}`,
        description: `Creates or replaces the ${noun}. The CLI reads the value from a file or stdin so it stays out of shell history.`,
        parameters: [env],
      },
      'ConfigValue',
      'Empty',
    ),
    operation(
      `update${title}`,
      {
        method: 'PATCH',
        path: `/${plural}/:name`,
        successStatus: 204,
        summary: `Update a ${noun}`,
        description: `Replaces the value of an existing ${noun}; 404 when it does not exist.`,
        parameters: [env],
      },
      'ConfigValue',
      'Empty',
    ),
    operation(
      `unset${title}`,
      {
        method: 'DELETE',
        path: `/${plural}/:name`,
        successStatus: 204,
        summary: `Unset a ${noun}`,
        parameters: [env],
      },
      'Empty',
      'Empty',
    ),
  ];
}

export const secrets = manifest(
  'secrets',
  '/v1',
  schemas,
  entries('secret', 'Names and update times only; secret values are never returned.'),
);

export const vars = manifest(
  'vars',
  '/v1',
  schemas,
  entries('var', 'Names, values, and update times of the environment variables.'),
);

export default secrets;
