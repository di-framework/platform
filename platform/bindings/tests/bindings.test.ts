import { describe, expect, it } from 'bun:test';
import { Blobstore } from '../src/bindings/blobstore.ts';
import { Config } from '../src/bindings/config.ts';
import { Messaging } from '../src/bindings/messaging.ts';
import { OutgoingHttp } from '../src/bindings/outgoing-http.ts';
import { Postgres } from '../src/bindings/postgres.ts';
import { Secrets } from '../src/bindings/secrets.ts';

describe('binding wrappers', () => {
  it('forwards postgres, blobstore, messaging, config, secrets, and http calls', async () => {
    const postgres = new Postgres({
      query: async (sql) => sql,
      queryBatch: async (sql) => sql,
    });
    await expect(postgres.query('select 1')).resolves.toBe('select 1');
    await expect(postgres.queryBatch('select 2')).resolves.toBe('select 2');

    const blobs = new Blobstore({
      createContainer: async (name) => name,
      getContainer: async (name) => name,
    });
    await expect(blobs.createContainer('media')).resolves.toBe('media');
    await expect(blobs.getContainer('media')).resolves.toBe('media');

    async function* body(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
    }
    const messaging = new Messaging({
      publish: async (message) => message,
      request: async (subject, stream) => ({ subject, stream }),
    });
    const stream = body();
    await expect(messaging.publish({ subject: 'a' })).resolves.toEqual({ subject: 'a' });
    const request = await messaging.request('orders', stream, 1000);
    expect(request).toEqual({ subject: 'orders', stream });

    const config = new Config({
      get: (key) => key,
      getAll: () => [['a', 'b']],
    });
    expect(config.get('region')).toBe('region');
    expect(config.getAll()).toEqual([['a', 'b']]);

    const secrets = new Secrets({
      get: async (key) => key,
      reveal: async (secret) => secret,
    });
    await expect(secrets.get('api')).resolves.toBe('api');
    await expect(secrets.reveal('handle')).resolves.toBe('handle');

    const http = new OutgoingHttp({
      send: async (request) => request,
    });
    await expect(http.send({ path: '/' })).resolves.toEqual({ path: '/' });
  });

  it('uses catalog default binding names when undecorated', () => {
    expect(new Postgres().bindingName).toBe('postgres');
    expect(new Config().bindingName).toBe('config');
    expect(new OutgoingHttp().bindingName).toBe('outgoing-http');
    expect(new Messaging().bindingName).toBe('messaging');
    expect(new Secrets().bindingName).toBe('secrets');
    expect(new Blobstore().bindingName).toBe('blobstore');
  });
});
