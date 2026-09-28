import { afterEach, describe, expect, it } from 'bun:test';
import { Container as CoreContainer } from '@di-framework/core/container';
import { Component, Container } from '@di-framework/core/decorators';
import { KeyValue } from '../src/bindings/keyvalue.ts';
import { Postgres } from '../src/bindings/postgres.ts';
import { WasmCloudBinding } from '../src/decorator.ts';
import { resetGuests, setGuests } from '../src/guests.ts';

describe('DI resolution', () => {
  afterEach(() => {
    resetGuests();
  });

  it('injects binding classes by class identity', () => {
    const container = new CoreContainer();

    @WasmCloudBinding('user-database')
    @Container({ container })
    class UserDatabase extends Postgres {}

    @Container({ container })
    class UserRepository {
      constructor(@Component(UserDatabase) readonly database: UserDatabase) {}
    }

    const repo = container.resolve(UserRepository);
    expect(repo.database).toBeInstanceOf(UserDatabase);
    expect(repo.database.bindingName).toBe('user-database');
  });

  it('allows registerValue overrides for tests', () => {
    const container = new CoreContainer();

    @WasmCloudBinding('user-database')
    @Container({ container })
    class UserDatabase extends Postgres {}

    class FakeUserDatabase extends UserDatabase {
      override query(): Promise<unknown> {
        return Promise.resolve(['ok']);
      }
    }

    container.registerValue(UserDatabase, new FakeUserDatabase());
    expect(container.resolve(UserDatabase).query('select 1')).resolves.toEqual(['ok']);
  });

  it('composes two named key-value bindings in one container', () => {
    const container = new CoreContainer();

    @WasmCloudBinding('sessions')
    @Container({ container })
    class Sessions extends KeyValue {}

    @WasmCloudBinding('cache')
    @Container({ container })
    class Cache extends KeyValue {}

    @Container({ container })
    class ApplicationBindings {
      constructor(
        @Component(Sessions) readonly sessions: Sessions,
        @Component(Cache) readonly cache: Cache,
      ) {}
    }

    const bindings = container.resolve(ApplicationBindings);
    expect(bindings.sessions.bindingName).toBe('sessions');
    expect(bindings.cache.bindingName).toBe('cache');
  });

  it('reads guests installed on globalThis by the generated guests module', async () => {
    const key = Symbol.for('di-framework.wasmcloud.guests');
    (globalThis as Record<symbol, unknown>)[key] = {
      sessions: {
        open: async (identifier: string) => ({ identifier, via: 'global' }),
      },
    };

    @WasmCloudBinding('sessions')
    class Sessions extends KeyValue {}

    const store = new Sessions();
    await expect(store.open('bucket')).resolves.toEqual({ identifier: 'bucket', via: 'global' });
  });

  it('delegates to generated guests without buffering the caller payload', async () => {
    const seen: unknown[] = [];
    setGuests({
      sessions: {
        open: async (identifier: string) => {
          seen.push(identifier);
          return { identifier };
        },
      },
    });

    @WasmCloudBinding('sessions')
    class Sessions extends KeyValue {}

    const store = new Sessions();
    await expect(store.open('bucket')).resolves.toEqual({ identifier: 'bucket' });
    expect(seen).toEqual(['bucket']);
  });

  it('explains a missing guest in unit tests', () => {
    @WasmCloudBinding('sessions')
    class Sessions extends KeyValue {}
    expect(() => new Sessions().open('bucket')).toThrow(/no guest implementation/);
  });
});
