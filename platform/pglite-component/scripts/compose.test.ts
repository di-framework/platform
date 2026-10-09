import { describe, expect, test } from 'bun:test';
import { parseComposeArgs } from './compose.ts';

describe('parseComposeArgs', () => {
  test('resolves paths against the caller cwd and defaults the provider into dist/', () => {
    expect(parseComposeArgs(['app.wasm', 'out.wasm'], '/pkg', '/work')).toEqual({
      help: false,
      app: '/work/app.wasm',
      out: '/work/out.wasm',
      provider: '/pkg/dist/di-framework-pglite.wasm',
    });
    expect(parseComposeArgs(['a', 'b', 'custom.wasm'], '/pkg', '/work')).toMatchObject({
      provider: '/work/custom.wasm',
    });
  });

  test('rejects missing or extra positionals', () => {
    expect(() => parseComposeArgs(['only'], '/pkg')).toThrow('missing <app.wasm>');
    expect(() => parseComposeArgs(['a', 'b', 'c', 'd'], '/pkg')).toThrow('too many arguments');
  });
});
