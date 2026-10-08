import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YAML } from 'bun';
import { openApiSpecFile, writeOpenApiSpec } from '../scripts/generate-openapi.ts';
import { OPERATIONS } from '../src/api/handlers.ts';

type Operation = {
  operationId?: string;
  security?: unknown;
  description?: string;
  responses?: Record<string, unknown>;
};
type Document = {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
};

const document = YAML.parse(readFileSync(openApiSpecFile, 'utf8')) as Document;
const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));

test('the committed document is what the manifests generate', () => {
  const fresh = writeOpenApiSpec(join(tmpdir(), `tenant-openapi-${process.pid}.yaml`));
  expect(readFileSync(fresh, 'utf8')).toBe(readFileSync(openApiSpecFile, 'utf8'));
});

test('every operation of the contract is in the document, versioned under /v1', () => {
  const ids = operations.map((operation) => operation.operationId).sort();
  expect(ids).toEqual([...OPERATIONS].sort());
  expect(Object.keys(document.paths).every((path) => path.startsWith('/v1/'))).toBe(true);
  expect(Object.keys(document.paths).some((path) => path.endsWith('/'))).toBe(false);
});

test('only authInfo is public; everything else takes the identity bearer', () => {
  for (const operation of operations) {
    if (operation.operationId === 'authInfo') expect(operation).not.toHaveProperty('security');
    else expect(operation.security).toEqual([{ identity: [] }]);
  }
  expect(document.components.securitySchemes.identity).toMatchObject({
    type: 'http',
    scheme: 'bearer',
  });
});

test('streaming and error shapes are named in the document', () => {
  const logs = document.paths['/v1/services/{service}/logs']?.get;
  expect(logs?.description).toContain('text/event-stream');
  expect(document.components.schemas).toHaveProperty('Problem');
  expect(document.components.schemas).toHaveProperty('DeployBundle');
  expect(document.openapi.startsWith('3.')).toBe(true);
});
