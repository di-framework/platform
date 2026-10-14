import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Io, run } from '../src/cli.ts';
import { type Credential, readStore, writeStore } from '../src/credentials.ts';
import { dockerConfigPath, loginCommand } from '../src/registry.ts';
import { caPem, readCaFile, trusting } from '../src/trust.ts';
import { fakeFetch, type Recorded } from './support/fake-fetch.ts';

let scratch: string;
let env: NodeJS.ProcessEnv;
const out: string[] = [];
const err: string[] = [];
const execs: { command: string[]; stdin: string }[] = [];
let execCode = 0;

const SECRET = 'dik_registry_secret';
const credential: Credential = {
  account: 'acme',
  user: 'alice',
  role: 'developer',
  via: 'api-key',
  apiKey: SECRET,
  controller: { url: 'https://controller.test' },
};
const registryInfo = {
  url: 'https://registry.acme.test:8443',
  repositoryPrefix: 'acme',
  auth: 'basic-identity',
  username: 'token',
};

function io(fetch?: typeof globalThis.fetch): Io {
  return {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    stdin: () => '',
    open: () => {},
    env,
    cwd: scratch,
    fetch,
    exec: async (command, stdin) => {
      execs.push({ command, stdin });
      return execCode;
    },
  };
}

/** A fake controller and registry: `/v2/` accepts only `token:<SECRET>` as Basic credentials. */
function fakes(info: unknown = registryInfo, status = 200) {
  return fakeFetch({
    'GET /v1/deploy/registry': () => Response.json(info, { status }),
    'GET /v2/': (r: Recorded) =>
      r.headers.authorization === `Basic ${btoa(`token:${SECRET}`)}`
        ? Response.json({})
        : new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic' } }),
  });
}

const configFile = () => join(env.DOCKER_CONFIG as string, 'config.json');
const printed = () => [...out, ...err].join('\n');

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tenant-cli-registry-'));
  env = { DI_FRAMEWORK_HOME: join(scratch, 'home'), DOCKER_CONFIG: join(scratch, 'docker') };
  out.length = 0;
  err.length = 0;
  execs.length = 0;
  execCode = 0;
  writeStore({ acme: credential }, env);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('registry info', () => {
  test('prints the URL, login host, and push prefix with the caller bearer, never the key', async () => {
    const { fetch, calls } = fakes();
    expect(await run(['registry'], io(fetch))).toBe(0);
    expect(calls[0]?.url).toBe('https://controller.test/v1/deploy/registry');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(out.join('\n')).toContain('registry.acme.test:8443/acme/<name>:<tag>');
    expect(out.join('\n')).toContain('username token');
    expect(printed()).not.toContain(SECRET);
  });

  test('--json adds the login host', async () => {
    const { fetch } = fakes();
    expect(await run(['registry', 'info', '--json'], io(fetch))).toBe(0);
    expect(JSON.parse(out[0] as string)).toEqual({
      ...registryInfo,
      host: 'registry.acme.test:8443',
    });
  });

  test('a tenant without a registry surfaces the controller 503', async () => {
    const { fetch } = fakes(
      { title: 'x', detail: 'no registry is configured for this tenant' },
      503,
    );
    expect(await run(['registry', 'login'], io(fetch))).toBe(1);
    expect(err[0]).toBe('controller: 503 no registry is configured for this tenant');
    expect(existsSync(configFile())).toBe(false);
  });

  test('unknown subcommands and tools are refused before any call', async () => {
    const { fetch, calls } = fakes();
    expect(await run(['registry', 'push'], io(fetch))).toBe(1);
    expect(await run(['registry', 'login', '--with', 'skopeo'], io(fetch))).toBe(1);
    expect(err).toEqual([
      'usage: registry [info|login|logout]',
      '--with must be one of docker, podman, oras',
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe('registry login', () => {
  test('checks the credential at /v2/ and writes a 0600 docker config entry for the host', async () => {
    const { fetch, calls } = fakes();
    expect(await run(['registry', 'login'], io(fetch))).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([
      'https://controller.test/v1/deploy/registry',
      'https://registry.acme.test:8443/v2/',
    ]);
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    expect(config.auths['registry.acme.test:8443'].auth).toBe(btoa(`token:${SECRET}`));
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(err.join('\n')).toContain(
      'Logged in to registry.acme.test:8443 as alice (developer: push and pull)',
    );
    expect(printed()).not.toContain(SECRET);
    expect(printed()).not.toContain(btoa(`token:${SECRET}`));
  });

  test('keeps other entries and keys; --config picks the file', async () => {
    const path = join(scratch, 'auth.json');
    writeFileSync(
      path,
      JSON.stringify({ auths: { 'ghcr.io': { auth: 'b3RoZXI=' } }, experimental: 'x' }),
    );
    const { fetch } = fakes();
    expect(await run(['registry', 'login', '--config', path], io(fetch))).toBe(0);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    expect(config.experimental).toBe('x');
    expect(Object.keys(config.auths)).toEqual(['ghcr.io', 'registry.acme.test:8443']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(configFile())).toBe(false);
  });

  test('a refused credential writes nothing', async () => {
    writeStore({ acme: { ...credential, apiKey: 'dik_wrong' } }, env);
    const { fetch } = fakes();
    expect(await run(['registry', 'login'], io(fetch))).toBe(1);
    expect(err[0]).toBe(
      'the registry at https://registry.acme.test:8443 refused the credential (401)',
    );
    expect(existsSync(configFile())).toBe(false);
  });

  test('refuses to overwrite a config file that is not JSON', async () => {
    writeFileSync(join(scratch, 'bad.json'), 'not json');
    const { fetch } = fakes();
    expect(await run(['registry', 'login', '--config', join(scratch, 'bad.json')], io(fetch))).toBe(
      1,
    );
    expect(err[0]).toContain('is not a JSON object; refusing to overwrite it');
    expect(readFileSync(join(scratch, 'bad.json'), 'utf8')).toBe('not json');
  });

  test('warns when a credential helper would shadow the entry', async () => {
    const path = join(scratch, 'helper.json');
    writeFileSync(path, JSON.stringify({ credsStore: 'desktop' }));
    const { fetch } = fakes();
    expect(await run(['registry', 'login', '--config', path], io(fetch))).toBe(0);
    expect(err[0]).toContain('credential helper "desktop"');
  });

  test('an identity login refreshes first and says when the password expires', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    writeStore(
      {
        acme: {
          ...credential,
          role: 'viewer',
          via: 'identity',
          apiKey: undefined,
          accessToken: SECRET,
          expiresAt,
        },
      },
      env,
    );
    const { fetch } = fakes();
    expect(await run(['registry', 'login'], io(fetch))).toBe(0);
    expect(err.join('\n')).toContain('(viewer: pull)');
    expect(err.join('\n')).toContain(`expires at ${expiresAt}`);
    expect(printed()).not.toContain(SECRET);
  });

  test('--with pipes the password to the tool on stdin, never in argv', async () => {
    const { fetch, calls } = fakes();
    expect(await run(['registry', 'login', '--with', 'podman'], io(fetch))).toBe(0);
    expect(execs).toEqual([
      {
        command: [
          'podman',
          'login',
          'registry.acme.test:8443',
          '--username',
          'token',
          '--password-stdin',
        ],
        stdin: `${SECRET}\n`,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(existsSync(configFile())).toBe(false);
    expect(printed()).not.toContain(SECRET);
  });

  test('--with on a plain-http origin adds the tool switch; a failing tool fails the login', async () => {
    const { fetch } = fakes({ ...registryInfo, url: 'http://127.0.0.1:5000' });
    execCode = 1;
    expect(await run(['registry', 'login', '--with', 'oras'], io(fetch))).toBe(1);
    expect(execs[0]?.command).toEqual([
      'oras',
      'login',
      '127.0.0.1:5000',
      '--username',
      'token',
      '--password-stdin',
      '--plain-http',
    ]);
    expect(err[0]).toBe('oras login 127.0.0.1:5000 failed (exit 1)');
  });

  test('an unreachable or failing registry writes nothing', async () => {
    const { fetch: controllerOnly } = fakes();
    const unreachable = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/v2/')) throw new TypeError('connection refused');
      return controllerOnly(input, init);
    }) as typeof fetch;
    expect(await run(['registry', 'login'], io(unreachable))).toBe(1);
    expect(err.at(-1)).toBe(
      'cannot reach the registry at https://registry.acme.test:8443: connection refused',
    );
    const failing = fakeFetch({
      'GET /v1/deploy/registry': () => Response.json(registryInfo),
      'GET /v2/': () => new Response(null, { status: 502 }),
    });
    expect(await run(['registry', 'login'], io(failing.fetch))).toBe(1);
    expect(err.at(-1)).toBe('the registry at https://registry.acme.test:8443 answered 502');
    expect(existsSync(configFile())).toBe(false);
  });

  test('--with needs a way to run the tool', async () => {
    const { fetch } = fakes();
    const noExec = { ...io(fetch), exec: undefined };
    expect(await run(['registry', 'login', '--with', 'docker'], noExec)).toBe(1);
    expect(err.at(-1)).toBe('cannot run docker from here');
  });

  test('logout removes only the tenant entry', async () => {
    const { fetch } = fakes();
    expect(await run(['registry', 'login'], io(fetch))).toBe(0);
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    config.auths['ghcr.io'] = { auth: 'b3RoZXI=' };
    writeFileSync(configFile(), JSON.stringify(config));
    expect(await run(['registry', 'logout'], io(fetch))).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).auths).toEqual({
      'ghcr.io': { auth: 'b3RoZXI=' },
    });
    expect(await run(['registry', 'logout'], io(fetch))).toBe(0);
    expect(err.at(-1)).toContain('No registry.acme.test:8443 login');
  });
});

describe('helpers', () => {
  test('dockerConfigPath: --config, then DOCKER_CONFIG, then HOME', () => {
    expect(dockerConfigPath('/x/c.json', { DOCKER_CONFIG: '/d' })).toBe('/x/c.json');
    expect(dockerConfigPath(undefined, { DOCKER_CONFIG: '/d' })).toBe('/d/config.json');
    expect(dockerConfigPath(undefined, { HOME: '/h' })).toBe('/h/.docker/config.json');
  });

  test('loginCommand: docker over http adds nothing (its daemon decides)', () => {
    expect(loginCommand('docker', 'h:1', 'token', true)).toEqual([
      'docker',
      'login',
      'h:1',
      '--username',
      'token',
      '--password-stdin',
    ]);
    expect(loginCommand('podman', 'h:1', 'token', true).at(-1)).toBe('--tls-verify=false');
  });

  test('readCaFile keeps only PEM certificates and refuses anything else', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    writeFileSync(join(scratch, 'ca.pem'), `junk\n${pem}\ntrailer\n`);
    const data = readCaFile(join(scratch, 'ca.pem'));
    expect(caPem({ url: 'x', certificateAuthorityData: data })).toBe(`${pem}\n`);
    writeFileSync(join(scratch, 'key.pem'), '-----BEGIN PRIVATE KEY-----\n');
    expect(() => readCaFile(join(scratch, 'key.pem'))).toThrow('holds no PEM certificate');
    expect(() => readCaFile(join(scratch, 'missing.pem'))).toThrow('--ca-file');
  });

  test('trusting adds the CA to the public roots and is a no-op without one', async () => {
    const seen: RequestInit[] = [];
    const base = (async (_: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response();
    }) as unknown as typeof fetch;
    expect(trusting(base, undefined)).toBe(base);
    await (trusting(base, 'PEM') as typeof fetch)('https://x', { method: 'POST' });
    const ca = (seen[0] as { tls: { ca: string[] } }).tls.ca;
    expect(ca.at(-1)).toBe('PEM');
    expect(ca.length).toBeGreaterThan(1);
    expect(seen[0]?.method).toBe('POST');
  });
});

/**
 * The controller and registry over real TLS on loopback, with a certificate from a throwaway CA,
 * as the tenant's `tenant-controller-ca` signs the controller's. Needs `openssl` to mint the CA.
 */
const hasOpenssl = Bun.which('openssl') !== null;
describe.skipIf(!hasOpenssl)('controller CA trust over TLS', () => {
  let pki: string;
  let server: ReturnType<typeof Bun.serve>;
  let controller: string;

  const openssl = (...args: string[]) => {
    const result = Bun.spawnSync(['openssl', ...args], { cwd: pki, stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];

  beforeAll(() => {
    pki = mkdtempSync(join(tmpdir(), 'tenant-cli-pki-'));
    openssl(
      'req',
      '-x509',
      ...ec,
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '1',
      '-subj',
      '/CN=tenant-controller-ca',
    );
    openssl('req', ...ec, '-keyout', 'tls.key', '-out', 'tls.csr', '-subj', '/CN=127.0.0.1');
    writeFileSync(join(pki, 'san.ext'), 'subjectAltName=IP:127.0.0.1\n');
    openssl(
      'x509',
      '-req',
      '-in',
      'tls.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'tls.crt',
      '-days',
      '1',
      '-extfile',
      'san.ext',
    );
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: {
        cert: readFileSync(join(pki, 'tls.crt'), 'utf8'),
        key: readFileSync(join(pki, 'tls.key'), 'utf8'),
      },
      fetch(request) {
        const path = new URL(request.url).pathname;
        const auth = request.headers.get('authorization');
        if (path === '/v1/auth/info')
          return Response.json({ account: 'acme', issuer: 'https://issuer.test', clientId: 'cli' });
        if (path === '/v2/')
          return auth === `Basic ${btoa(`token:${SECRET}`)}`
            ? Response.json({})
            : new Response(null, { status: 401 });
        if (auth !== `Bearer ${SECRET}`)
          return Response.json({ title: 'Unauthorized' }, { status: 401 });
        if (path === '/v1/auth/whoami')
          return Response.json({
            account: 'acme',
            user: 'alice',
            role: 'developer',
            via: 'api-key',
          });
        if (path === '/v1/deploy/registry')
          return Response.json({ ...registryInfo, url: `https://127.0.0.1:${server.port}` });
        return new Response(null, { status: 404 });
      },
    });
    controller = `https://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    rmSync(pki, { recursive: true, force: true });
  });

  test('without the CA the controller certificate is not trusted', async () => {
    writeStore({}, env);
    const code = await run(['login', '--controller', controller, '--api-key', SECRET], io());
    expect(code).toBe(1);
    expect(err[0]).toContain('login --ca-file <ca.crt>, or NODE_EXTRA_CA_CERTS');
    expect(readStore(env)).toEqual({});
  });

  test('--ca-file trusts the controller, is stored with the credential, and covers the registry', async () => {
    writeStore({}, env);
    const caFile = join(pki, 'ca.crt');
    const login = ['login', '--controller', controller, '--api-key', SECRET, '--ca-file', caFile];
    expect(await run(login, io())).toBe(0);
    const stored = readStore(env).acme as Credential;
    expect(caPem(stored.controller)).toContain('BEGIN CERTIFICATE');
    expect(statSync(join(env.DI_FRAMEWORK_HOME as string, 'credentials.json')).mode & 0o777).toBe(
      0o600,
    );

    expect(await run(['whoami'], io())).toBe(0);
    expect(out.at(-1)).toBe('alice (developer) in acme via api-key');

    expect(await run(['registry', 'login'], io())).toBe(0);
    const config = JSON.parse(readFileSync(configFile(), 'utf8'));
    expect(config.auths[`127.0.0.1:${server.port}`].auth).toBe(btoa(`token:${SECRET}`));

    // The registry check without the CA fails with the trust hint, not as unreachable.
    const store = readStore(env);
    const acme = store.acme as Credential;
    writeStore({ acme: { ...acme, controller: { url: controller } } }, env);
    const unverified = fakeFetch({
      'GET /v1/deploy/registry': () =>
        Response.json({ ...registryInfo, url: `https://127.0.0.1:${server.port}` }),
    });
    const viaFake = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/v2/')
        ? fetch(input, init)
        : unverified.fetch(input, init)) as typeof fetch;
    expect(await run(['registry', 'login'], io(viaFake))).toBe(1);
    expect(err.at(-1)).toContain('tls: ');
    writeStore(store, env);

    // A later login to the same controller keeps the stored CA.
    expect(await run(['login', '--controller', controller, '--api-key', SECRET], io())).toBe(0);
    expect((readStore(env).acme as Credential).controller.certificateAuthorityData).toBe(
      stored.controller.certificateAuthorityData,
    );
    expect(printed()).not.toContain(SECRET);
  });
});
