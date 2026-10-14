import { describe, expect, test } from 'bun:test';
import {
  escapeHtml,
  keys,
  landing,
  logs,
  members,
  message,
  overview,
  page,
  type Who,
} from '../src/html.ts';
import type { ApiKey, IssuedApiKey } from '../src/keys.ts';

const who: Who = { account: 'acme', user: 'ada@example.test', role: 'admin' };

function key(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'k_1',
    name: 'ci-deploy',
    tenant: 'acme',
    user: who.user,
    createdAt: '2026-01-01T10:20:30.123Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('escapeHtml', () => {
  test('escapes markup characters and leaves plain text alone', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(escapeHtml('plain')).toBe('plain');
  });
});

describe('page, landing, message', () => {
  test('page wraps the body and escapes the title', () => {
    const html = page('<t>', '<p>body</p>');
    expect(html).toStartWith('<!doctype html>');
    expect(html).toContain('<title>&lt;t&gt;</title>');
    expect(html).toContain('<body><p>body</p></body>');
  });

  test('landing offers sign-in and shows an escaped error only when given', () => {
    expect(landing('acme')).toContain('href="/login"');
    expect(landing('acme')).not.toContain('banner error');
    const html = landing('acme', '<bad>');
    expect(html).toContain('<p class="banner error">&lt;bad&gt;</p>');
  });

  test('message renders an error variant', () => {
    expect(message('Oops', 'text')).toContain('<p class="banner">text</p>');
    expect(message('Oops', '<x>', true)).toContain('<p class="banner error">&lt;x&gt;</p>');
  });
});

describe('overview', () => {
  test('lists deployments and services, escaping values and linking logs', () => {
    const html = overview(
      who,
      [{ name: 'web<1>', ready: '1/1', message: 'ok', age: '5m' }, { name: 'bare' }],
      [{ name: 'db', class: 'postgres', ready: 'True' }, { name: 'cache' }],
    );
    expect(html).toContain('<a href="/logs/web&lt;1&gt;">web&lt;1&gt;</a>');
    expect(html).toContain('<td>1/1</td>');
    expect(html).toContain('<td>postgres</td>');
    expect(html).toContain('<td>cache</td><td></td><td></td>');
    expect(html).toContain('<strong>Overview</strong>');
    expect(html).toContain('<a href="/keys">API keys</a>');
  });

  test('shows empty states', () => {
    const html = overview(who, [], []);
    expect(html).toContain('No deployments.');
    expect(html).toContain('No backing services.');
  });
});

describe('logs', () => {
  test('renders escaped entries', () => {
    const html = logs(who, 'web', ['a <b>', 'c']);
    expect(html).toContain('<pre>a &lt;b&gt;\nc</pre>');
    expect(html).toContain('Logs · web');
  });

  test('shows an empty state', () => {
    expect(logs(who, 'web', [])).toContain('No projected logs yet.');
  });
});

describe('members', () => {
  test('marks suspended members', () => {
    const html = members(who, [
      { user: 'a@x.test', role: 'admin', suspended: false },
      { user: 'b@x.test', role: 'viewer', suspended: true },
    ]);
    expect(html).toContain('<td class="">active</td>');
    expect(html).toContain('<td class="bad">suspended</td>');
    expect(html).toContain('<strong>Members</strong>');
  });
});

describe('keys', () => {
  test('shows an empty state and the create form', () => {
    const html = keys(who, []);
    expect(html).toContain('No API keys yet.');
    expect(html).toContain('action="/keys"');
    expect(html).not.toContain('Copy this key now');
  });

  test('lists keys, flags expired ones, and formats timestamps', () => {
    const html = keys(who, [
      key(),
      key({ id: 'k_2', name: 'old', expiresAt: '2000-01-01T00:00:00.000Z' }),
    ]);
    expect(html).toContain('2026-01-01 10:20:30Z');
    expect(html).toContain('action="/keys/k_1/revoke"');
    expect(html).toContain('<td class="bad">2000-01-01 00:00:00Z (expired)</td>');
    expect(html.match(/\(expired\)/g)).toHaveLength(1);
  });

  test('shows a freshly issued secret once with the CLI login hint', () => {
    const issued: IssuedApiKey = { ...key(), secret: 'sec<ret>' };
    const html = keys(who, [key()], issued);
    expect(html).toContain('Copy this key now. It is not shown again.');
    expect(html).toContain('<pre>sec&lt;ret&gt;</pre>');
    // The hint currently omits --controller (see tenant-cli usage); pinned as-is, not fixed here.
    expect(html).toContain('login --account acme --api-key &lt;key&gt;');
  });

  test('renders an escaped error', () => {
    expect(keys(who, [], undefined, '<boom>')).toContain(
      '<p class="banner error">&lt;boom&gt;</p>',
    );
  });
});
