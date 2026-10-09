import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import {
  inClusterCredentials,
  KubeClient,
  KubeError,
  loadKubeconfig,
  PLATFORM_GROUP,
  PLATFORM_VERSION,
} from '../src/kube.ts';
import { type FakeServer, json, serve } from './support/servers.ts';

const CA = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n';

describe('inClusterCredentials', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sa-'));
    writeFileSync(join(dir, 'token'), 'projected-token\n');
    writeFileSync(join(dir, 'ca.crt'), CA);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads the projected ServiceAccount files', () => {
    const credentials = inClusterCredentials(dir, {
      KUBERNETES_SERVICE_HOST: '10.0.0.1',
      KUBERNETES_SERVICE_PORT_HTTPS: '6443',
    });
    expect(credentials).toEqual({
      server: 'https://10.0.0.1:6443',
      ca: CA,
      tokenFile: join(dir, 'token'),
    });
    expect(inClusterCredentials(dir, { KUBERNETES_SERVICE_HOST: 'h' }).server).toBe(
      'https://h:443',
    );
  });
  test('refuses outside a cluster', () => {
    expect(() => inClusterCredentials(dir, {})).toThrow('not running inside a cluster');
    expect(() =>
      inClusterCredentials(join(dir, 'missing'), { KUBERNETES_SERVICE_HOST: 'h' }),
    ).toThrow('not running inside a cluster');
  });
});

describe('loadKubeconfig', () => {
  let dir: string;
  const b64 = (value: string) => Buffer.from(value).toString('base64');
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kubeconfig-'));
    writeFileSync(join(dir, 'ca.pem'), 'file-ca');
    writeFileSync(join(dir, 'client.crt'), 'file-cert');
    writeFileSync(join(dir, 'client.key'), 'file-key');
    writeFileSync(
      join(dir, 'inline.yaml'),
      dump({
        'current-context': 'admin',
        contexts: [
          { name: 'admin', context: { cluster: 'c', user: 'u' } },
          { name: 'broken', context: { cluster: 'nope', user: 'u' } },
        ],
        clusters: [
          {
            name: 'c',
            cluster: { server: 'https://k8s:6443', 'certificate-authority-data': b64(CA) },
          },
        ],
        users: [
          {
            name: 'u',
            user: { 'client-certificate-data': b64('cert'), 'client-key-data': b64('key') },
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'files.yaml'),
      dump({
        contexts: [{ name: 'tok', context: { cluster: 'c', user: 'u' } }],
        clusters: [
          { name: 'c', cluster: { server: 'https://k8s', 'certificate-authority': 'ca.pem' } },
        ],
        users: [
          {
            name: 'u',
            user: { token: 't', 'client-certificate': 'client.crt', 'client-key': 'client.key' },
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'bare.yaml'),
      dump({
        'current-context': 'x',
        contexts: [{ name: 'x', context: { cluster: 'c', user: 'u' } }],
        clusters: [{ name: 'c', cluster: { server: 'https://k8s' } }],
        users: [{ name: 'u', user: { token: 't' } }],
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('decodes inline data for the current context', () => {
    expect(loadKubeconfig(join(dir, 'inline.yaml'))).toEqual({
      server: 'https://k8s:6443',
      ca: CA,
      token: undefined,
      cert: 'cert',
      key: 'key',
    });
  });
  test('reads file references relative to the kubeconfig', () => {
    expect(loadKubeconfig(join(dir, 'files.yaml'), 'tok')).toEqual({
      server: 'https://k8s',
      ca: 'file-ca',
      token: 't',
      cert: 'file-cert',
      key: 'file-key',
    });
  });
  test('leaves absent material undefined', () => {
    expect(loadKubeconfig(join(dir, 'bare.yaml'))).toEqual({
      server: 'https://k8s',
      ca: undefined,
      token: 't',
      cert: undefined,
      key: undefined,
    });
  });
  test('reports a missing or incomplete context', () => {
    expect(() => loadKubeconfig(join(dir, 'inline.yaml'), 'other')).toThrow('no context other');
    expect(() => loadKubeconfig(join(dir, 'files.yaml'))).toThrow('no context (current)');
    expect(() => loadKubeconfig(join(dir, 'inline.yaml'), 'broken')).toThrow('is incomplete');
  });
});

describe('KubeClient', () => {
  let api: FakeServer;
  let dir: string;
  const users = `/apis/${PLATFORM_GROUP}/${PLATFORM_VERSION}/users`;
  const tenants = `/apis/${PLATFORM_GROUP}/${PLATFORM_VERSION}/tenants`;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'token-'));
    writeFileSync(join(dir, 'token'), 'from-file\n');
    api = serve((request) => {
      if (request.path === `${users}/alice`)
        return json({ metadata: { name: 'alice' }, spec: { memberships: [] } });
      if (request.path === `${users}/missing`)
        return json({ kind: 'Status', message: 'users "missing" not found' }, 404);
      if (request.path === `${users}/broken`)
        return new Response('upstream exploded', { status: 500 });
      if (request.path === users) return json({ items: [] });
      if (request.path === `${tenants}/acme`) return json({ metadata: { name: 'acme' }, spec: {} });
      if (request.path === '/api/v1/namespaces/wasmcloud/serviceaccounts/di-user-alice/token')
        return json({ status: { token: 'sa-token', expirationTimestamp: '2030-01-01T00:00:00Z' } });
      if (request.path.startsWith('/api/v1/namespaces/ns/secrets')) {
        if (request.method === 'DELETE') return new Response(null, { status: 200 });
        if (request.method === 'POST') return json(JSON.parse(request.body), 201);
        return json({ items: [{ metadata: { name: 's' } }] });
      }
      return json({ message: 'nope' }, 400);
    });
  });
  afterAll(() => {
    api.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('exposes the server and certificate authority', () => {
    const client = new KubeClient({ server: api.url, ca: CA, token: 't' }, 'wasmcloud');
    expect(client.server).toBe(api.url);
    expect(client.ca).toBe(CA);
  });
  test('sends a static token, or re-reads a projected token file', async () => {
    await new KubeClient({ server: api.url, token: 'static' }, 'wasmcloud').getUser('alice');
    await new KubeClient({ server: api.url, tokenFile: join(dir, 'token') }, 'wasmcloud').getUser(
      'alice',
    );
    const sent = api.requests.slice(-2).map((r) => r.headers.get('authorization'));
    expect(sent).toEqual(['Bearer static', 'Bearer from-file']);
  });
  test('turns 404 into undefined and keeps other failures as KubeError', async () => {
    const client = new KubeClient({ server: api.url, cert: 'c', key: 'k' }, 'wasmcloud');
    expect(await client.getUser('missing')).toBeUndefined();
    const error = await client.getUser('broken').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KubeError);
    expect((error as KubeError).status).toBe(500);
    expect((error as KubeError).message).toBe(`GET ${users}/broken returned 500`);
    await expect(client.call('GET', '/other')).rejects.toThrow('nope');
  });
  test('wraps the tenancy and secret endpoints', async () => {
    const client = new KubeClient({ server: api.url, token: 't' }, 'wasmcloud');
    expect((await client.listUsers()).items).toEqual([]);
    expect((await client.getTenant('acme'))?.metadata.name).toBe('acme');
    expect(await client.mintServiceAccountToken('di-user-alice', 600)).toEqual({
      token: 'sa-token',
      expirationTimestamp: '2030-01-01T00:00:00Z',
    });
    const mint = api.requests.at(-1);
    expect(JSON.parse(mint?.body ?? '')).toMatchObject({
      kind: 'TokenRequest',
      spec: { expirationSeconds: 600 },
    });
    expect(mint?.headers.get('content-type')).toBe('application/json');
    expect((await client.listSecrets('ns', 'a=b,c=d')).items).toHaveLength(1);
    expect(api.requests.at(-1)?.path).toBe(
      '/api/v1/namespaces/ns/secrets?labelSelector=a%3Db%2Cc%3Dd',
    );
    expect(await client.getSecret('ns', 'x')).toBeDefined();
    const created = await client.createSecret('ns', {
      metadata: { name: 'k' },
      stringData: { v: '1' },
    });
    expect(created).toMatchObject({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'k' } });
    expect(await client.deleteSecret('ns', 'k')).toBeUndefined();
  });
});
