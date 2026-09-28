import { describe, expect, it } from 'bun:test';
import {
  getWorkload,
  getWorkloadComponent,
  getWorkloadService,
  Workload,
  WorkloadComponent,
  WorkloadService,
} from '../src/workload.ts';

describe('workload membership', () => {
  it('records a colocation namespace name', async () => {
    const fetch = Workload('warehouse')(
      WorkloadComponent({ workload: 'warehouse', path: '/sync' })(
        async (_request: Request) => new Response('ok'),
      ),
    );

    expect(getWorkload(fetch)).toEqual({ name: 'warehouse' });
    expect(getWorkloadComponent(fetch)).toEqual({ workload: 'warehouse', path: '/sync' });
    expect(await (await fetch(new Request('http://warehouse/'))).text()).toBe('ok');
  });

  it('records component membership and a required path', async () => {
    const fetch = WorkloadComponent({ workload: 'warehouse', path: '/take' })(
      async () => new Response('take'),
    );

    expect(getWorkload(fetch)).toBeUndefined();
    expect(getWorkloadComponent(fetch)).toEqual({ workload: 'warehouse', path: '/take' });
  });

  it('requires absolute paths on components and services', () => {
    for (const decorate of [WorkloadComponent, WorkloadService]) {
      for (const path of ['', 'relative', '//host', '/bad path']) {
        expect(() => decorate({ path })).toThrow(/path/);
      }
      // @ts-expect-error Exercise JavaScript callers that omit the required field.
      expect(() => decorate({})).toThrow(/path/);
    }
    expect(getWorkloadService(WorkloadService({ path: '/sync' })(async () => {}))).toEqual({
      path: '/sync',
    });
  });

  it('records a service in the same workload, uncoupled from fetch', async () => {
    const run = WorkloadService({ workload: 'warehouse', path: '/sync' })(async () => undefined);

    expect(getWorkloadService(run)).toEqual({ workload: 'warehouse', path: '/sync' });
    expect(getWorkloadComponent(run)).toBeUndefined();
    await run();
  });

  it('rejects empty names', () => {
    expect(() => Workload('')).toThrow(/required/);
    expect(() => WorkloadComponent({ workload: ' ', path: '/take' })).toThrow(/required/);
    expect(() => WorkloadService({ workload: '', path: '/sync' })).toThrow(/required/);
  });
});
