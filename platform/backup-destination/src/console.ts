import { type Action, BACKUP_NOW, VERSION, type World } from './model.ts';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}

export function render(world: World): string {
  const destination = world.destination;
  const ready = destination?.status.conditions?.find((condition) => condition.type === 'Ready');
  const services = (destination?.status.services ?? [])
    .map(
      (service) =>
        `<li>${escapeHtml(service.name)} (${escapeHtml(service.type)}): ${escapeHtml(service.lastReason ?? 'pending')}</li>`,
    )
    .join('');
  const backups = world.backups
    .map(
      (backup) =>
        `<li>${escapeHtml(backup.name)} ${escapeHtml(backup.phase ?? 'Running')} ${escapeHtml(backup.objectKey ?? '')}</li>`,
    )
    .join('');
  const succeeded = world.backups.filter((backup) => backup.phase === 'Succeeded');
  const options = succeeded
    .map(
      (backup) => `<option value="${escapeHtml(backup.name)}">${escapeHtml(backup.name)}</option>`,
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Backups</title></head>
<body>
<h1>Backups</h1>
<p>Namespace ${escapeHtml(world.tenantNamespace)}. Runtime ${escapeHtml(world.runtimeNamespace)}.</p>
<p>Destination ${escapeHtml(destination?.name ?? 'none')}: ${escapeHtml(ready?.reason ?? 'Unknown')} ${escapeHtml(ready?.message ?? '')}</p>
<p>Skipped ${destination?.status.skipped ?? 0}. Enrolled ${destination?.status.enrolledServices ?? 0}.</p>
<ul>${services}</ul>
<h2>History</h2>
<ul>${backups}</ul>
<form method="post" action="/backups"><button type="submit">Backup now</button></form>
<form method="post" action="/restores">
<label>Backup <select name="source">${options}</select></label>
<label>Empty target <input name="target" required></label>
<button type="submit">Restore</button>
</form>
</body>
</html>`;
}

function formValue(body: string, key: string): string {
  return new URLSearchParams(body).get(key)?.trim() ?? '';
}

export function handle(
  method: string,
  path: string,
  body: string,
  world: World,
): { status: number; html: string; actions: Action[] } {
  const actions: Action[] = [];
  if (method === 'POST' && path === '/backups' && world.destination) {
    actions.push({
      type: 'annotate',
      name: world.destination.name,
      key: BACKUP_NOW,
      value: world.now,
    });
  }
  if (method === 'POST' && path === '/restores') {
    const source = formValue(body, 'source');
    const target = formValue(body, 'target');
    const backup = world.backups.find((item) => item.name === source && item.phase === 'Succeeded');
    if (!backup || !target || target === backup.serviceName) {
      return { status: 400, html: render(world), actions };
    }
    const name = `restore-${target}`.slice(0, 63);
    actions.push({
      type: 'create-restore',
      body: {
        apiVersion: VERSION,
        kind: 'BackupRestore',
        metadata: { name, namespace: world.tenantNamespace },
        spec: { sourceBackupName: source, targetServiceName: target },
      },
    });
  }
  if (method !== 'GET' && method !== 'POST') return { status: 405, html: render(world), actions };
  if (path !== '/' && path !== '/backups' && path !== '/restores') {
    return { status: 404, html: render(world), actions };
  }
  return { status: 200, html: render(world), actions };
}
