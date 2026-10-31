import { describe, expect, it } from 'bun:test';
import { ACCOUNTS_KEY, SCHEDULER_NATS_ACCOUNTS } from '../src/tenancy/scheduler-nats';
import { AccountsPropagation } from '../src/tenancy/scheduler-propagation';
import { TENANT_OPERATOR_PROPAGATION_MS } from '../src/tenancy/tenant-operator';

// #541 m6e-E: a user counts as propagated once the written accounts file has named it for the wait.

const path = `/api/v1/namespaces/wasmcloud/configmaps/${SCHEDULER_NATS_ACCOUNTS}`;
const T0 = new Date('2026-10-31T00:00:00Z');

/** The accounts ConfigMap, or a failure with `code`. */
function api(state: { text?: string; code?: number }) {
  return {
    async call<T>(method: string, at: string): Promise<T> {
      expect(`${method} ${at}`).toBe(`GET ${path}`);
      if (state.code) throw Object.assign(new Error('failed'), { code: state.code });
      if (state.text === undefined) throw Object.assign(new Error('not found'), { code: 404 });
      return { data: { [ACCOUNTS_KEY]: state.text } } as T;
    },
  };
}
const line = (user: string) => `      { user: "${user}" }\n`;

describe('AccountsPropagation (#541 m6e-E)', () => {
  it('counts a user as propagated once the written file has named it for the wait', async () => {
    const clock = { now: T0 };
    const state: { text?: string } = {};
    const propagation = new AccountsPropagation(api(state), 'wasmcloud', () => clock.now);
    // No file yet.
    expect((await propagation.read())('a')).toBe(false);
    state.text = line('a');
    expect((await propagation.read())('a')).toBe(false);
    clock.now = new Date(T0.getTime() + TENANT_OPERATOR_PROPAGATION_MS - 1);
    expect((await propagation.read())('a')).toBe(false);
    clock.now = new Date(T0.getTime() + TENANT_OPERATOR_PROPAGATION_MS);
    const loaded = await propagation.read();
    expect(loaded('a')).toBe(true);
    // A user the file does not name never counts, and is never timed.
    expect(loaded('b')).toBe(false);
  });

  it('restarts the wait of a user the file stopped naming, and keeps a fresh process waiting', async () => {
    const clock = { now: T0 };
    const state: { text?: string } = { text: line('a') };
    const propagation = new AccountsPropagation(api(state), 'wasmcloud', () => clock.now);
    expect((await propagation.read())('a')).toBe(false);
    state.text = '';
    clock.now = new Date(T0.getTime() + TENANT_OPERATOR_PROPAGATION_MS);
    expect((await propagation.read())('a')).toBe(false);
    state.text = line('a');
    expect((await propagation.read())('a')).toBe(false);
    clock.now = new Date(clock.now.getTime() + TENANT_OPERATOR_PROPAGATION_MS);
    expect((await propagation.read())('a')).toBe(true);
    // A restarted controller starts the clock again.
    const restarted = new AccountsPropagation(api(state), 'wasmcloud', () => clock.now);
    expect((await restarted.read())('a')).toBe(false);
  });

  it('raises a failed read other than a missing file', async () => {
    const propagation = new AccountsPropagation(api({ code: 500 }), 'wasmcloud', () => T0);
    await expect(propagation.read()).rejects.toThrow('failed');
  });

  it('reads a file without the accounts key as naming nobody', async () => {
    const propagation = new AccountsPropagation(
      { call: async <T>() => ({ data: {} }) as T },
      'wasmcloud',
      () => T0,
    );
    expect((await propagation.read())('a')).toBe(false);
  });
});
