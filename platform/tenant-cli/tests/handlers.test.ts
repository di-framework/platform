import { expect, test } from 'bun:test';
import { DeployBundle, Empty } from '../src/api/contracts/api.schemas.ts';
import { OPERATIONS, problem, TenantControllerHandlers } from '../src/api/handlers.ts';

test('every operation answers 501 with problem details until the controller implements it', async () => {
  const handlers = new TenantControllerHandlers();
  for (const name of OPERATIONS) {
    const response = await handlers[name]({}, { transport: 'http', request: {} });
    expect(response.status).toBe(501);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toEqual({
      type: 'about:blank',
      title: 'Not Implemented',
      status: 501,
      detail: `${name} is not implemented in the pilot yet`,
    });
  }
});

test('problem responses carry a detail only when given one', async () => {
  expect(await problem(404, 'Not Found').json()).toEqual({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
  });
});

test('runtime schemas validate their input and expose their JSON schema', () => {
  const bundle = {
    env: 'prod',
    service: 'web',
    component: { reference: 'r', digest: 'd' },
    workload: {},
    bindings: [],
    secrets: [],
  };
  expect(DeployBundle.parse(bundle)).toBe(bundle);
  expect(() => DeployBundle.parse({ env: 'prod' })).toThrow('body.service is required');
  expect(Empty.parse(undefined)).toEqual({});
  expect(Empty.jsonSchema).toEqual({ type: 'object' });
  expect(DeployBundle.jsonSchema).toHaveProperty('required');
});
