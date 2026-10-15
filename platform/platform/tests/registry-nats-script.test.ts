import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REGISTRY_NATS_CONNECT_MAX_DELAY_SECONDS,
  REGISTRY_NATS_CONNECT_WAIT_SECONDS,
  REGISTRY_NATS_MIGRATION_SCRIPT,
} from '../src/tenancy/registry-nats';

// Runs the migration Job's script against a stubbed `nats` CLI and `sleep` (#388). nats-box runs
// it with busybox sh, so the cases also run under `busybox sh` where the runner has busybox.

const PASSWORD = 'rSENTINELpasswordSENTINELpasswordSENTINEL0000';
const REFUSED = 'nats: error: setup failed: nats: no servers available for connection';

/**
 * A `nats` stub: the first `refusals` connections fail like a pod whose network policy is not
 * programmed yet, then `account info` reports the account the login lands in and the marker
 * says the migration is complete. Every call is logged without its environment.
 */
function stub(dir: string, refusals: number, anonymousAccount = 'TENANT', refusal = REFUSED) {
  writeFileSync(
    join(dir, 'nats'),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
count=$(cat "${dir}/count" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "${dir}/count"
if [ "$count" -le ${refusals} ]; then
  echo "${refusal}" >&2
  exit 1
fi
case "$*" in
  "account info")
    if [ -n "$NATS_USER" ]; then account=REGISTRY; else account=${anonymousAccount}; fi
    echo "Account Information"
    echo "                        Account: $account ($account)"
    ;;
  "stream ls --names") echo KV_di-platform-migrations ;;
  "kv get di-platform-migrations registry-object-store --raw") echo complete ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`,
  );
  writeFileSync(join(dir, 'sleep'), `#!/bin/sh\necho "$1" >> "${dir}/sleeps"\n`);
  chmodSync(join(dir, 'nats'), 0o755);
  chmodSync(join(dir, 'sleep'), 0o755);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DENIED = 'nats: error: setup failed: nats: Authorization Violation';
const busybox = spawnSync('busybox', ['true']).error === undefined;

function run(
  refusals: number,
  anonymousAccount?: string,
  refusal?: string,
  shell: string[] = ['bash', '-c'],
) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-migrate-'));
  dirs.push(dir);
  stub(dir, refusals, anonymousAccount, refusal);
  const child = spawnSync(shell[0] ?? 'bash', [...shell.slice(1), REGISTRY_NATS_MIGRATION_SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      TMPDIR: dir,
      NATS_URL: 'nats://di-nats.di-runtime-alpha.svc.cluster.local:4222',
      REGISTRY_USER: 'registry',
      REGISTRY_PASSWORD: PASSWORD,
    },
  });
  const lines = (file: string) =>
    existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n') : [];
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    calls: lines('calls'),
    sleeps: lines('sleeps').map(Number),
  };
}

describe('registry migration script: first connection (#388)', () => {
  it('retries refused connections with backoff, then runs the checks and the steps', () => {
    const result = run(3);
    expect(result.stderr).toContain('attempt 1 failed (nats: error: setup failed');
    expect(result.stderr).toContain('attempt 3 failed');
    expect(result.stderr).not.toContain('attempt 4 failed');
    expect(result.status).toBe(0);
    expect(result.sleeps).toEqual([1, 2, 4]);
    expect(result.stdout).toContain('registry migration: connected to di-nats on attempt 4');
    expect(result.stdout).toContain('registry migration: already complete');
    // The wait only reads the account; the account checks still run after it.
    expect(result.calls).toEqual([
      'account info',
      'account info',
      'account info',
      'account info',
      'account info',
      'account info',
      'stream ls --names',
      'kv get di-platform-migrations registry-object-store --raw',
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
  });

  it('connects at once without waiting or logging a retry', () => {
    const result = run(0);
    expect(result.status).toBe(0);
    expect(result.sleeps).toEqual([]);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('registry migration: already complete\n');
  });

  it('gives up with a non-zero exit once the wait is spent', () => {
    const result = run(1000);
    expect(result.status).not.toBe(0);
    const waited = result.sleeps.reduce((sum, delay) => sum + delay, 0);
    expect(waited).toBeGreaterThanOrEqual(REGISTRY_NATS_CONNECT_WAIT_SECONDS);
    expect(waited).toBeLessThan(
      REGISTRY_NATS_CONNECT_WAIT_SECONDS + REGISTRY_NATS_CONNECT_MAX_DELAY_SECONDS,
    );
    expect(Math.max(...result.sleeps)).toBe(REGISTRY_NATS_CONNECT_MAX_DELAY_SECONDS);
    expect(result.sleeps).toEqual([1, 2, 4, 8, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(result.calls).toEqual(new Array(result.sleeps.length + 1).fill('account info'));
    expect(result.stderr).toContain(
      `registry migration: could not connect to di-nats as the registry user in 13 attempts over 95s: ${REFUSED}`,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
  });

  it('fails at once on a rejected login without retrying', () => {
    const result = run(1000, undefined, DENIED);
    expect(result.status).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.calls).toEqual(['account info']);
    expect(result.stderr).toContain(`registry migration: the registry login failed: ${DENIED}`);
    expect(result.stderr).not.toContain('retrying');
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
  });

  it.skipIf(!busybox)('retries and then proceeds under busybox sh', () => {
    const result = run(3, undefined, undefined, ['busybox', 'sh', '-c']);
    expect(result.status).toBe(0);
    expect(result.sleeps).toEqual([1, 2, 4]);
    expect(result.stdout).toContain('already complete');
  });

  it.skipIf(!busybox)('fails at once on a rejected login under busybox sh', () => {
    const result = run(1000, undefined, DENIED, ['busybox', 'sh', '-c']);
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(['account info']);
    expect(result.stderr).toContain('the registry login failed');
  });

  it('still refuses a misrendered server after the wait', () => {
    const result = run(2, 'REGISTRY');
    expect(result.status).toBe(1);
    expect(result.sleeps).toEqual([1, 2]);
    expect(result.stderr).toContain(
      'registry migration: the anonymous login is not in the TENANT account',
    );
    expect(result.calls).not.toContain('stream ls --names');
  });

  it('waits before any other step', () => {
    const wait = REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('until dst account info');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('[ "$(account src)"'));
    expect(wait).toBeLessThan(REGISTRY_NATS_MIGRATION_SCRIPT.indexOf('stream ls'));
    expect(REGISTRY_NATS_MIGRATION_SCRIPT).toContain(
      `[ "$waited" -lt ${REGISTRY_NATS_CONNECT_WAIT_SECONDS} ] ||`,
    );
  });
});
