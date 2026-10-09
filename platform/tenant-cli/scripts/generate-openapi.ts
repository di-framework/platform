import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateOpenAPI } from '@di-framework/http';
import { YAML } from 'bun';
import { schemas } from '../src/api/schemas.ts';
import '../src/api/generated/auth/v1/http.ts';
import '../src/api/generated/deploy/v1/http.ts';
import '../src/api/generated/deployments/v1/http.ts';
import '../src/api/generated/secrets/v1/http.ts';
import '../src/api/generated/services/v1/http.ts';
import '../src/api/generated/vars/v1/http.ts';

export const openApiSpecFile = resolve(import.meta.dir, '../api/v1/openapi.yaml');

/** Operations a CLI may call before it holds a credential. */
const PUBLIC = new Set(['authInfo']);

/**
 * Write the OpenAPI document from the generated `@Endpoint` routes. Unlike identity-server's,
 * this document is committed: it is the contract both CLIs compile against, and
 * `tests/openapi.test.ts` fails when the committed file drifts from the manifests.
 */
export function writeOpenApiSpec(path = openApiSpecFile): string {
  const document = generateOpenAPI({
    title: 'Tenant Controller API',
    version: 'v1',
    description:
      'The only surface a tenant CLI talks to. Every call carries an identity-server credential; the controller holds the kubeconfig and never exposes Kubernetes.',
  });
  for (const methods of Object.values(document.paths)) {
    for (const operation of Object.values(methods)) {
      const operationId = operation.operationId;
      if (typeof operationId !== 'string') continue;
      const method = operationId.slice(operationId.lastIndexOf('.') + 1);
      (operation as { operationId: string }).operationId = method;
      if (!PUBLIC.has(method)) (operation as { security?: unknown }).security = [{ identity: [] }];
      // An `Empty` input reads a missing body as `{}`, so the body is optional on the wire.
      const body = (operation as { requestBody?: { required?: boolean; content?: unknown } })
        .requestBody;
      const content = body?.content as Record<string, { schema?: unknown }> | undefined;
      if (
        body &&
        JSON.stringify(content?.['application/json']?.schema) === JSON.stringify(schemas.Empty)
      )
        body.required = false;
    }
  }
  const withComponents = document as { components?: Record<string, unknown> };
  withComponents.components = { ...withComponents.components };
  withComponents.components.schemas = {
    ...(withComponents.components.schemas as Record<string, unknown> | undefined),
    ...schemas,
  };
  withComponents.components.securitySchemes = {
    identity: {
      type: 'http',
      scheme: 'bearer',
      description:
        'An identity-server access token for a member of this account, or a tenant API key (`dik_…`). Obtained by the CLI login; never passed as an argument.',
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(JSON.parse(JSON.stringify(document))));
  return path;
}

if (import.meta.main) writeOpenApiSpec();
