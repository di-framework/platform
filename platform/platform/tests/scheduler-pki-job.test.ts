import { describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSchedulerPkiScripts } from '../src/scheduler-pki-bootstrap';
import { SCHEDULER_PKI_MODULES } from '../src/tenancy/scheduler-pki';
import {
  InClusterApi,
  main,
  PkiApiError,
  RetryingApi,
  reportFailure,
  transientClass,
} from '../src/tenancy/scheduler-pki-job';

const distTenancy = join(import.meta.dir, '..', 'dist', 'tenancy');

/** Fakes the in-cluster API for one request, as `tests/tenancy-api.test.ts` does for the controller's. */
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
      if (failure === 'timeout') return timeout?.();
      if (failure === 'network') return req.emit('error', new Error('connection refused'));
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

describe('scheduler PKI in-cluster API', () => {
  it('authenticates with the projected token and sends JSON bodies', async () => {
    const t = transport(201, '{"ok":true}');
    try {
      const body = { metadata: { name: 'é' } };
      expect(await new InClusterApi().call('POST', '/api/v1/namespaces/x/secrets', body)).toEqual({
        ok: true,
      });
      expect(t.sent()).toBe(JSON.stringify(body));
      expect(t.options().method).toBe('POST');
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
    const t = transport(200, '');
    try {
      expect(await new InClusterApi().call('GET', '/api/v1')).toBeUndefined();
      expect(t.sent()).toBeUndefined();
      expect(t.options().headers).not.toHaveProperty('Content-Length');
    } finally {
      t.restore();
    }
  });

  it('reports the status only: no response body and no query string', async () => {
    const t = transport(404, 'private-secret-data');
    try {
      const error = (await new InClusterApi()
        .call('GET', '/api/v1/secrets/x?q=private')
        .catch((e: PkiApiError) => e)) as PkiApiError;
      expect(error).toBeInstanceOf(PkiApiError);
      expect(error.code).toBe(404);
      expect(error.message).toBe('GET /api/v1/secrets/x returned 404');
    } finally {
      t.restore();
    }
  });

  it('does not quote a body that is not JSON', async () => {
    const t = transport(200, 'private-secret-data');
    try {
      const error = (await new InClusterApi()
        .call('GET', '/api/v1/x')
        .catch((e: Error) => e)) as Error;
      expect(error.message).toBe('GET /api/v1/x returned a body that is not JSON');
      expect(error.message).not.toContain('private');
    } finally {
      t.restore();
    }
  });

  it('times out and passes network errors on', async () => {
    for (const [failure, message] of [
      ['timeout', 'Kubernetes API request timed out'],
      ['network', 'connection refused'],
    ] as const) {
      const t = transport(200, '', failure);
      try {
        const error = await new InClusterApi().call('GET', '/api/v1').catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(message);
        // A timed-out request carries the code that makes it retryable (#583).
        if (failure === 'timeout') expect(transientClass(error)).toBe('ETIMEDOUT');
      } finally {
        t.restore();
      }
    }
  });

  it('retries a timed-out request until the budget runs out', async () => {
    const t = transport(200, '', 'timeout');
    let now = 0;
    const retries: string[] = [];
    try {
      const api = new RetryingApi(
        new InClusterApi(),
        async (ms) => {
          now += ms;
        },
        () => now,
        (line) => retries.push(line),
      );
      await expect(api.call('GET', '/api/v1/x?q=1')).rejects.toThrow(
        /^GET \/api\/v1\/x still failing with ETIMEDOUT after \d+ s of retries$/,
      );
      expect(retries[0]).toBe('retrying GET /api/v1/x after ETIMEDOUT (attempt 1) in 250 ms');
    } finally {
      t.restore();
    }
  });
});

it('main retries by default: a refused first connection is retried before the run goes on', async () => {
  spyOn(fs, 'readFileSync').mockImplementation((() => 'x') as unknown as typeof fs.readFileSync);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  let requests = 0;
  const request = spyOn(https, 'request').mockImplementation(((
    _opts: https.RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => {
    const n = ++requests;
    const req = Object.assign(new EventEmitter(), {
      setTimeout: () => {},
      end: () => {
        if (n === 1)
          return req.emit(
            'error',
            Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
          );
        // Then a status that is not retried, so the run stops at once.
        const res = Object.assign(new EventEmitter(), { statusCode: 403, setEncoding: () => {} });
        callback(res as unknown as IncomingMessage);
        res.emit('end');
      },
    });
    return req;
  }) as unknown as typeof https.request);
  try {
    const config = JSON.stringify({ installation: 'di', namespace: 'wasmcloud' });
    await expect(main(undefined, config, () => {})).rejects.toMatchObject({ code: 403 });
    expect(requests).toBe(2);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /^retrying GET \S+ after ECONNREFUSED \(attempt 1\) in 250 ms$/,
    );
  } finally {
    (fs.readFileSync as unknown as { mockRestore(): void }).mockRestore();
    log.mockRestore();
    request.mockRestore();
  }
});

it('reports a failed run with its message and exit code 1', () => {
  const status: { exitCode?: number | string | null } = {};
  const lines: string[] = [];
  reportFailure(new Error('refused'), status, (line) => lines.push(line));
  expect(status.exitCode).toBe(1);
  expect(lines).toEqual(['refused']);
});

it('ships a self-contained Job: its modules load from the build with nothing else beside them', () => {
  const scripts = loadSchedulerPkiScripts(distTenancy);
  expect(Object.keys(scripts).sort()).toEqual(SCHEDULER_PKI_MODULES.map((m) => `${m}.js`).sort());
  const dir = fs.mkdtempSync(join(tmpdir(), 'scheduler-pki-job-'));
  try {
    for (const [name, text] of Object.entries(scripts)) fs.writeFileSync(join(dir, name), text);
    // Requiring the entry point loads every module it needs; a missing one throws.
    const loaded = execFileSync(
      'node',
      ['-e', "const m = require('./scheduler-pki-job.js'); console.log(typeof m.main)"],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(loaded.trim()).toBe('function');
    // Run as the Job does, without a config: it fails before any API call, with exit code 1.
    const run = Bun.spawnSync(['node', join(dir, 'scheduler-pki-job.js')], {
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString().trim()).toBe('Missing SCHEDULER_PKI_CONFIG');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
