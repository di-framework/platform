import { expect, test } from 'bun:test';
import { useContainer } from '@di-framework/core/container';
import { OPERATIONS, TenantControllerHandlers } from '../src/api/handlers.ts';
import { dispatch, match, ROUTES } from '../src/api/routes.ts';

test('every contract operation has exactly one route', () => {
  expect(ROUTES.map((route) => route.operation).sort()).toEqual([...OPERATIONS].sort());
  expect(match('GET', '/v1/deployments/stats')?.operation).toBe('deploymentStats');
  expect(match('GET', '/v1/services/web/logs')?.operation).toBe('logs');
  expect(match('GET', '/v1/services/web/logs/extra')).toBeUndefined();
  expect(match('POST', '/v1/deployments')).toBeUndefined();
});

test('requests that name no operation are left to the caller', async () => {
  expect(await dispatch(new Request('http://controller.test/v1/unknown'))).toBeUndefined();
});

test('dispatch reaches the handler registered in the container', async () => {
  const response = await dispatch(new Request('http://controller.test/v1/deployments?env=prod'));
  expect(response?.status).toBe(501);
});

test('errors other than validation failures propagate to the caller', async () => {
  const handlers = useContainer().resolve(TenantControllerHandlers);
  const original = handlers.vars;
  handlers.vars = async () => {
    throw new Error('cluster down');
  };
  try {
    await expect(dispatch(new Request('http://controller.test/v1/vars?env=prod'))).rejects.toThrow(
      'cluster down',
    );
  } finally {
    handlers.vars = original;
  }
});
