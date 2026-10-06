import { describe, expect, it } from 'bun:test';
import { parseWranglerBindings } from '../src/wrangler.ts';

const sample = {
  kv_namespaces: [{ binding: 'SESSIONS', id: 'kv1' }, { binding: '  ' }, { id: 'missing' }],
  d1_databases: [{ binding: 'ORDERS', database_name: 'orders' }],
  r2_buckets: [{ binding: 'MEDIA' }],
  durable_objects: { bindings: [{ name: 'COUNTER', class_name: 'Counter' }, { class_name: 'No' }] },
  queues: {
    producers: [{ binding: 'JOBS', queue: 'jobs' }],
    consumers: [{ queue: 'jobs' }],
  },
  services: [{ binding: 'AUTH', service: 'auth' }],
  vectorize: [{ binding: 'VECTORS' }],
  analytics_engine_datasets: [{ binding: 'METRICS' }],
  hyperdrive: [{ binding: 'PG', id: 'hd1' }],
  ratelimits: [{ name: 'LIMIT', namespace_id: '1' }],
  workflows: [{ binding: 'FLOW', class_name: 'Flow' }],
  send_email: [{ name: 'MAIL' }],
  pipelines: [{ binding: 'STREAM' }],
  dispatch_namespaces: [{ binding: 'DISPATCH', namespace: 'prod' }],
  secrets_store_secrets: [{ binding: 'STORE', secret_name: 'token' }],
  mtls_certificates: [{ binding: 'CERT' }],
  ai: { binding: 'AI' },
  browser: { binding: 'BROWSER' },
  images: { binding: 'IMAGES' },
  assets: { binding: 'ASSETS' },
  vars: { API_HOST: 'https://example.com', '': 'skip' },
};

describe('parseWranglerBindings', () => {
  it('reads binding declarations and keeps the first name', () => {
    const declarations = parseWranglerBindings(sample);
    const byName = Object.fromEntries(declarations.map((entry) => [entry.name, entry.kind]));
    expect(byName).toEqual({
      SESSIONS: 'kv',
      ORDERS: 'd1',
      MEDIA: 'r2',
      COUNTER: 'durable-object',
      JOBS: 'queue',
      AUTH: 'service',
      VECTORS: 'vectorize',
      METRICS: 'analytics',
      PG: 'hyperdrive',
      LIMIT: 'ratelimit',
      FLOW: 'workflow',
      MAIL: 'email',
      STREAM: 'pipeline',
      DISPATCH: 'dispatch-namespace',
      STORE: 'secrets-store',
      CERT: 'mtls',
      AI: 'ai',
      BROWSER: 'browser',
      IMAGES: 'images',
      ASSETS: 'assets',
      API_HOST: 'var',
    });
    expect(declarations.find((entry) => entry.name === 'SESSIONS')?.config.id).toBe('kv1');
    expect(declarations.find((entry) => entry.name === 'API_HOST')?.config.value).toBe(
      'https://example.com',
    );
  });

  it('accepts vectorize_indexes, workflow names, and JSON text', () => {
    const declarations = parseWranglerBindings(
      JSON.stringify({
        vectorize_indexes: [{ binding: 'VECTORS' }],
        workflows: [{ name: 'FLOW' }],
        ratelimits: [{ binding: 'LIMIT' }],
        send_email: [{ binding: 'MAIL' }],
        durable_objects: { bindings: [{ binding: 'COUNTER' }] },
        queues: { producers: [{ name: 'JOBS' }] },
      }),
    );
    expect(declarations.map((entry) => `${entry.name}:${entry.kind}`).sort()).toEqual([
      'COUNTER:durable-object',
      'FLOW:workflow',
      'JOBS:queue',
      'LIMIT:ratelimit',
      'MAIL:email',
      'VECTORS:vectorize',
    ]);
  });

  it('ignores invalid config and duplicate names', () => {
    expect(parseWranglerBindings(undefined)).toEqual([]);
    expect(parseWranglerBindings(null)).toEqual([]);
    expect(parseWranglerBindings('')).toEqual([]);
    expect(parseWranglerBindings('not-json')).toEqual([]);
    expect(parseWranglerBindings('[]')).toEqual([]);
    expect(parseWranglerBindings({ kv_namespaces: { binding: 'NOPE' } })).toEqual([]);
    expect(parseWranglerBindings({ ai: {}, assets: { binding: '   ' }, vars: {} })).toEqual([]);
    expect(parseWranglerBindings({ durable_objects: {}, queues: {} })).toEqual([]);

    const declarations = parseWranglerBindings({
      kv_namespaces: [{ binding: 'SHARED' }],
      d1_databases: [{ binding: 'SHARED' }],
    });
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.kind).toBe('kv');
  });
});
