import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { type Api, ApiError, KubernetesApi, main, reportFatal } from '../src/tenancy/controller';

const originalConfig = process.env.PLATFORM_CONFIG;
afterEach(() => {
  if (originalConfig === undefined) delete process.env.PLATFORM_CONFIG;
  else process.env.PLATFORM_CONFIG = originalConfig;
});

function transport(status: number, response: string, failure?: 'timeout' | 'network') {
  const reads: string[] = [];
  const read = spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor) => {
    reads.push(String(path));
    return String(path).endsWith('/token') ? 'projected-token\n' : Buffer.from('cluster-ca');
  }) as typeof fs.readFileSync);
  let options: https.RequestOptions = {};
  let sent: unknown;
  let timeout: (() => void) | undefined;
  const req = new EventEmitter() as EventEmitter & {
    setTimeout(ms: number, callback: () => void): void;
    destroy(error: Error): void;
    end(data: unknown): void;
  };
  req.setTimeout = (ms, callback) => {
    expect(ms).toBe(15000);
    timeout = callback;
  };
  req.destroy = (error) => {
    req.emit('error', error);
  };
  const request = spyOn(https, 'request').mockImplementation(((
    opts: https.RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => {
    options = opts;
    req.end = (data) => {
      sent = data;
      if (failure === 'timeout') {
        timeout?.();
        return;
      }
      if (failure === 'network') {
        req.emit('error', new Error('connection refused'));
        return;
      }
      const res = Object.assign(new EventEmitter(), { statusCode: status, setEncoding: () => {} });
      callback(res as unknown as IncomingMessage);
      res.emit('data', response.slice(0, 3));
      res.emit('data', response.slice(3));
      res.emit('end');
    };
    return req;
  }) as typeof https.request);
  return {
    reads,
    options: () => options,
    sent: () => sent,
    restore: () => {
      read.mockRestore();
      request.mockRestore();
    },
  };
}

describe('Kubernetes API transport', () => {
  it('uses projected credentials and preserves DELETE JSON bodies and byte lengths', async () => {
    const t = transport(200, '{"ok":true}');
    try {
      const body = { preconditions: { uid: 'tenant-uid' }, note: 'é' };
      expect(
        await new KubernetesApi().call<{ ok: boolean }>('DELETE', '/api/v1/namespaces/alpha', body),
      ).toEqual({
        ok: true,
      });
      expect(t.sent()).toBe(JSON.stringify(body));
      expect(t.options().hostname).toBe(process.env.KUBERNETES_SERVICE_HOST);
      expect(t.options().ca).toEqual(Buffer.from('cluster-ca'));
      expect(t.options().headers).toMatchObject({
        Authorization: 'Bearer projected-token',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(body)),
      });
      expect(t.reads).toEqual([
        '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
        '/var/run/secrets/kubernetes.io/serviceaccount/token',
      ]);
    } finally {
      t.restore();
    }
  });

  it('accepts an empty success response without a request body', async () => {
    const t = transport(204, '');
    try {
      expect(await new KubernetesApi().call('GET', '/api/v1')).toBeUndefined();
      expect(t.sent()).toBeUndefined();
      expect(t.options().headers).not.toHaveProperty('Content-Length');
    } finally {
      t.restore();
    }
  });

  it('does not expose Secret response bodies or query strings in API errors', async () => {
    const t = transport(403, 'private-secret-data');
    try {
      const error = await new KubernetesApi()
        .call('GET', '/api/v1/secrets?private=query')
        .catch((e) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(403);
      expect((error as ApiError).message).toBe('GET /api/v1/secrets returned 403');
    } finally {
      t.restore();
    }
  });

  it('rejects malformed response JSON', async () => {
    const t = transport(200, 'not-json');
    try {
      await expect(new KubernetesApi().call('GET', '/api/v1')).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      t.restore();
    }
  });

  for (const failure of ['timeout', 'network'] as const) {
    it(`rejects a ${failure} failure`, async () => {
      const t = transport(200, '', failure);
      try {
        await expect(new KubernetesApi().call('GET', '/api/v1')).rejects.toThrow(
          failure === 'timeout' ? 'timed out' : 'connection refused',
        );
      } finally {
        t.restore();
      }
    });
  }
});

describe('controller process lifecycle', () => {
  it('fails startup without platform configuration and reports fatal failures', async () => {
    delete process.env.PLATFORM_CONFIG;
    await expect(main()).rejects.toThrow('Missing PLATFORM_CONFIG');
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const status = { exitCode: 0 };
      reportFatal(new Error('invalid configuration'), status);
      expect(log).toHaveBeenCalledWith('invalid configuration');
      expect(status.exitCode).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it('retries API failures and removes its SIGTERM listener on shutdown', async () => {
    process.env.PLATFORM_CONFIG = JSON.stringify({
      installation: 'test',
      namespace: 'wasmcloud',
      hostImage: 'wash:test',
      schedulerNatsUrl: 'nats://nats:4222',
    });
    const listeners = process.listeners('SIGTERM');
    let calls = 0;
    const api: Api = {
      async call() {
        calls++;
        throw new Error('API offline');
      },
    };
    const log = spyOn(console, 'error').mockImplementation(() => {});
    let pauses = 0;
    try {
      await main(api, async (ms) => {
        expect(ms).toBe(3000);
        if (++pauses === 2) {
          // Invoke only the controller's new listener; leave other test listeners alone.
          const stop = process
            .listeners('SIGTERM')
            .find((listener) => !listeners.includes(listener));
          expect(stop).toBeDefined();
          stop?.('SIGTERM');
        }
      });
      expect(calls).toBe(2);
      expect(log).toHaveBeenCalledWith('API offline');
      expect(process.listeners('SIGTERM')).toEqual(listeners);
    } finally {
      log.mockRestore();
    }
  });
});
