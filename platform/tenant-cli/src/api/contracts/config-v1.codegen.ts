import { ConfigList, ConfigValue, Empty, SecretList, VarUnset } from './api.schemas.ts';
import { env, manifest, operation } from './manifest.ts';

const schema = { module: './api.schemas.ts' };
const shared = {
  Empty: { schema: Empty, ...schema },
  ConfigValue: { schema: ConfigValue, ...schema },
};
/** Each manifest declares only its own list schema, so neither generated module validates the other's. */
const secretSchemas = { ...shared, SecretList: { schema: SecretList, ...schema } };
const varSchemas = {
  ...shared,
  ConfigList: { schema: ConfigList, ...schema },
  VarUnset: { schema: VarUnset, ...schema },
};

/**
 * `secrets` and `vars` take the same operations and write the same `ConfigValue`, but list
 * different entries: a `SecretList` carries names and update times only, a `ConfigList` also
 * carries each var's value.
 */
function entries(noun: 'secret' | 'var', readDescription: string, unsetDescription: string) {
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
        // A var unset answers its warnings (platform#100); a referenced secret is refused instead.
        successStatus: noun === 'secret' ? 204 : 200,
        summary: `Unset a ${noun}`,
        description: unsetDescription,
        parameters: [env],
      },
      'Empty',
      noun === 'secret' ? 'Empty' : 'VarUnset',
    ),
  ];
}

export const secrets = manifest(
  'secrets',
  '/v1',
  secretSchemas,
  entries(
    'secret',
    'Names and update times only; secret values are never returned.',
    'Deletes the secret; 404 when it does not exist, 409 naming the deployed workloads while any of them injects it.',
  ),
);

export const vars = manifest(
  'vars',
  '/v1',
  varSchemas,
  entries(
    'var',
    'Names, values, and update times of the environment variables.',
    "Removes the var; 404 when it does not exist. It succeeds while deployed workloads inject the environment's vars, with a `referenced` warning naming them.",
  ),
);

export default secrets;
