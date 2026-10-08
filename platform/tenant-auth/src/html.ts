/** Server-rendered pages for the prototype console. A PatternFly client would replace these. */
import type { ApiKey, IssuedApiKey } from './keys.ts';

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
const e = escapeHtml;

const styles = `
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 0; padding: 24px 16px; max-width: 960px; margin-inline: auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 24px 0 8px; }
  nav a { margin-right: 16px; }
  .muted { opacity: .7; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid rgba(128,128,128,.3); vertical-align: top; }
  form.inline { display: inline; }
  fieldset { border: 1px solid rgba(128,128,128,.4); border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
  label { display: block; margin: 8px 0 2px; }
  input, select, button { font: inherit; padding: 6px 8px; }
  button { cursor: pointer; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  pre { padding: 12px; border-radius: 8px; background: rgba(128,128,128,.12); overflow-x: auto; max-height: 60vh; }
  .banner { border: 1px solid #c9a227; background: rgba(201,162,39,.12); padding: 12px 16px; border-radius: 8px; }
  .error { border-color: #c0392b; background: rgba(192,57,43,.12); }
  .bad { color: #c0392b; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>${styles}</style></head><body>${body}</body></html>`;
}

export interface Who {
  account: string;
  user: string;
  role: string;
}
function chrome(who: Who, active: string, body: string): string {
  const link = (href: string, label: string) =>
    href === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`;
  return `<h1>${e(who.account)}</h1>
  <p class="muted">Signed in as <strong>${e(who.user)}</strong> (${e(who.role)}) · <a href="/logout">Sign out</a></p>
  <nav>${link('/', 'Overview')} ${link('/keys', 'API keys')} ${link('/members', 'Members')}</nav>
  ${body}`;
}

export function landing(account: string, error?: string): string {
  return page(
    `${account} console`,
    `<h1>${e(account)}</h1><p class="muted">Tenant console. Sign in with your identity to continue.</p>
    ${error ? `<p class="banner error">${e(error)}</p>` : ''}
    <p><a href="/login"><button type="button">Sign in</button></a></p>`,
  );
}

export function message(title: string, text: string, error = false): string {
  return page(
    title,
    `<h1>${e(title)}</h1><p class="banner${error ? ' error' : ''}">${e(text)}</p>`,
  );
}

export interface Deployment {
  name: string;
  ready?: string;
  message?: string;
  age?: string;
}
export interface Service {
  name: string;
  class?: string;
  ready?: string;
}
export function overview(who: Who, deployments: Deployment[], services: Service[]): string {
  const rows = deployments
    .map(
      (d) =>
        `<tr><td><a href="/logs/${e(d.name)}">${e(d.name)}</a></td><td>${e(d.ready ?? '')}</td><td class="muted">${e(d.message ?? '')}</td><td>${e(d.age ?? '')}</td></tr>`,
    )
    .join('');
  const svc = services
    .map(
      (s) =>
        `<tr><td>${e(s.name)}</td><td>${e(s.class ?? '')}</td><td>${e(s.ready ?? '')}</td></tr>`,
    )
    .join('');
  return page(
    `${who.account} · overview`,
    chrome(
      who,
      '/',
      `<h2>Deployments</h2>
      ${rows ? `<table><thead><tr><th>Name</th><th>Ready</th><th>Status</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No deployments. Run <code>di-framework platform deploy</code>.</p>'}
      <h2>Backing services</h2>
      ${svc ? `<table><thead><tr><th>Name</th><th>Class</th><th>Ready</th></tr></thead><tbody>${svc}</tbody></table>` : '<p class="muted">No backing services.</p>'}`,
    ),
  );
}

export function logs(who: Who, app: string, entries: string[]): string {
  return page(
    `${who.account} · ${app} logs`,
    chrome(
      who,
      '/',
      `<h2>Logs · ${e(app)}</h2>${entries.length ? `<pre>${e(entries.join('\n'))}</pre>` : '<p class="muted">No projected logs yet.</p>'}`,
    ),
  );
}

export function members(
  who: Who,
  list: { user: string; role: string; suspended: boolean }[],
): string {
  const rows = list
    .map(
      (m) =>
        `<tr><td>${e(m.user)}</td><td>${e(m.role)}</td><td class="${m.suspended ? 'bad' : ''}">${m.suspended ? 'suspended' : 'active'}</td></tr>`,
    )
    .join('');
  return page(
    `${who.account} · members`,
    chrome(
      who,
      '/members',
      `<h2>Members</h2><table><thead><tr><th>User</th><th>Role</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted">Membership is managed by the platform operator; roles map to the tenant's Kubernetes roles.</p>`,
    ),
  );
}

const when = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

export function keys(who: Who, list: ApiKey[], issued?: IssuedApiKey, error?: string): string {
  const now = Date.now();
  const rows = list
    .map((key) => {
      const expired = new Date(key.expiresAt).getTime() <= now;
      return `<tr><td>${e(key.name)}</td><td><code>${e(key.id)}</code></td><td>${when(key.createdAt)}</td><td class="${expired ? 'bad' : ''}">${when(key.expiresAt)}${expired ? ' (expired)' : ''}</td>
      <td><form class="inline" method="post" action="/keys/${e(key.id)}/revoke"><button type="submit">Revoke</button></form></td></tr>`;
    })
    .join('');
  const banner = issued
    ? `<div class="banner"><strong>Copy this key now. It is not shown again.</strong>
      <pre>${e(issued.secret)}</pre>
      <p class="muted">Use it with <code>login --account ${e(who.account)} --api-key &lt;key&gt;</code>. It acts as you, only in this account.</p></div>`
    : '';
  return page(
    `${who.account} · API keys`,
    chrome(
      who,
      '/keys',
      `${error ? `<p class="banner error">${e(error)}</p>` : ''}${banner}
      <h2>API keys</h2>
      ${rows ? `<table><thead><tr><th>Name</th><th>Id</th><th>Created</th><th>Expires</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No API keys yet.</p>'}
      <form method="post" action="/keys"><fieldset><legend>Create an API key</legend>
        <label for="name">Name</label><input id="name" name="name" required maxlength="64" placeholder="ci-deploy">
        <label for="days">Expires in</label>
        <select id="days" name="days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="90">90 days</option></select>
        <p><button type="submit">Create key</button></p>
        <p class="muted">Keys stop working when they expire, when you revoke them, or when your membership is removed.</p>
      </fieldset></form>`,
    ),
  );
}
