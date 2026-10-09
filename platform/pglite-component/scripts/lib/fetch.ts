/** Checksum-verified downloads for the pinned toolchain and engine inputs. */
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { fileExists } from './fs.ts';

/** SHA-256 hex digest of a file, streamed so large archives are never fully buffered. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest('hex');
}

export interface FetchOptions {
  log?: (message: string) => void;
  attempts?: number;
  timeoutMs?: number;
}

/**
 * Download `url` to `dest` (via `dest.part`) and verify its SHA-256.
 * Reuses `dest` when a copy with the expected checksum already exists.
 */
export async function fetchVerified(
  url: string,
  dest: string,
  expectedSha: string,
  { log = () => {}, attempts = 3, timeoutMs = 300_000 }: FetchOptions = {},
): Promise<void> {
  if (!expectedSha) {
    throw new Error(
      `no pinned checksum for ${basename(dest)} on this platform; see scripts/tool-versions.env`,
    );
  }
  await mkdir(dirname(dest), { recursive: true });
  if (await fileExists(dest)) {
    if ((await sha256File(dest)) === expectedSha) {
      log(`cached  ${basename(dest)}`);
      return;
    }
    log('cached copy has wrong checksum; re-downloading');
    await rm(dest, { force: true });
  }

  log(`fetch   ${url}`);
  const part = `${dest}.part`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      await Bun.write(part, response);
      const actual = await sha256File(part);
      if (actual !== expectedSha) {
        throw new Error(`checksum mismatch: expected ${expectedSha}, got ${actual}`);
      }
      await rename(part, dest);
      log(`verified sha256=${expectedSha}`);
      return;
    } catch (error) {
      lastError = error;
      await rm(part, { force: true });
      if (attempt < attempts) log(`attempt ${attempt} failed, retrying`);
    }
  }
  throw new Error(`download failed for ${url}: ${String(lastError)}`);
}
