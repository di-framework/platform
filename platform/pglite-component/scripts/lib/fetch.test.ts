import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchVerified, sha256File } from './fetch.ts';

const BODY = 'pinned toolchain bytes\n';
const BODY_SHA = new Bun.CryptoHasher('sha256').update(BODY).digest('hex');

let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'df-pglite-fetch.'));
  server = Bun.serve({
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === '/ok'
        ? new Response(BODY)
        : new Response('missing', { status: 404 });
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

describe('sha256File', () => {
  test('matches the digest of the bytes on disk', async () => {
    const path = join(dir, 'digest.txt');
    await Bun.write(path, BODY);
    expect(await sha256File(path)).toBe(BODY_SHA);
  });
});

describe('fetchVerified', () => {
  test('downloads, verifies, and reuses a cached copy', async () => {
    const dest = join(dir, 'ok.bin');
    const messages: string[] = [];
    const log = (message: string) => messages.push(message);
    await fetchVerified(`${server.url}ok`, dest, BODY_SHA, { log });
    expect(await Bun.file(dest).text()).toBe(BODY);
    expect(messages.some((m) => m.startsWith('verified'))).toBe(true);

    await fetchVerified(`${server.url}ok`, dest, BODY_SHA, { log });
    expect(messages.at(-1)).toBe('cached  ok.bin');
  });

  test('rejects a checksum mismatch and leaves nothing behind', async () => {
    const dest = join(dir, 'bad.bin');
    await expect(
      fetchVerified(`${server.url}ok`, dest, 'f'.repeat(64), { attempts: 1 }),
    ).rejects.toThrow('checksum mismatch');
    expect(await Bun.file(dest).exists()).toBe(false);
    expect(await Bun.file(`${dest}.part`).exists()).toBe(false);
  });

  test('reports HTTP failures and refuses unpinned downloads', async () => {
    await expect(
      fetchVerified(`${server.url}missing`, join(dir, 'missing.bin'), BODY_SHA, { attempts: 1 }),
    ).rejects.toThrow('HTTP 404');
    await expect(fetchVerified(`${server.url}ok`, join(dir, 'x.bin'), '')).rejects.toThrow(
      'no pinned checksum',
    );
  });
});
