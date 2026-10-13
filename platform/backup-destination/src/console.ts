import {
  type Action,
  BACKUP_NOW,
  type BackupView,
  type DestinationView,
  destinationType,
  jobName,
  NO_SCHEDULE,
  type Retention,
  type SourceStatus,
  VERSION,
  type WorkloadVolumeSource,
  type World,
} from './model.ts';
import { validCron } from './schedule.ts';
import { backupInFlight, requestBackup } from './workload.ts';

const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}

function destinationsOf(world: World): DestinationView[] {
  return world.destinations ?? (world.destination ? [world.destination] : []);
}

function retentionText(retention: Retention | undefined): string {
  const rules = (['keepLast', 'daily', 'weekly', 'monthly', 'failed'] as const).flatMap((rule) =>
    retention?.[rule] ? [`${rule} ${retention[rule]}`] : [],
  );
  return rules.length > 0 ? rules.join(', ') : 'none (every backup is kept)';
}

function downtime(seconds: number | undefined): string {
  return seconds === undefined ? 'never' : `${seconds}s`;
}

function sourceItem(
  destination: DestinationView,
  source: WorkloadVolumeSource,
  row: SourceStatus | undefined,
): string {
  const invalid = row?.scheduleStatus === 'InvalidSchedule' ? ', invalid: it never runs' : '';
  const schedule =
    source.schedule && source.schedule.trim() !== NO_SCHEDULE
      ? `schedule ${escapeHtml(source.schedule)} (UTC)${source.suspend ? ', suspended' : ''}${invalid}`
      : 'no schedule (on demand only)';
  return `<li>${escapeHtml(source.workloadName)}: ${schedule}; retention ${escapeHtml(retentionText(source.retention))}; last ${escapeHtml(row?.lastReason ?? 'none')}; last scale-to-0 ${downtime(row?.lastScaleDownSeconds)}
<form method="post" action="/backups"><input type="hidden" name="destination" value="${escapeHtml(destination.name)}"><input type="hidden" name="workload" value="${escapeHtml(source.workloadName)}"><button type="submit">Back up ${escapeHtml(source.workloadName)} now (stops it)</button></form></li>`;
}

function scheduleLine(destination: DestinationView): string {
  const schedule = destination.spec.schedule?.trim();
  if (!schedule || schedule === NO_SCHEDULE) return 'Schedule: none — on-demand only';
  return validCron(schedule)
    ? `Schedule: ${schedule} (UTC)`
    : `Schedule: ${schedule} is not a valid cron — no scheduled backups run`;
}

function destinationSection(destination: DestinationView): string {
  const ready = destination.status.conditions?.find((condition) => condition.type === 'Ready');
  const services = (destination.status.services ?? [])
    .map(
      (service) =>
        `<li>${escapeHtml(service.name)} (${escapeHtml(service.type)}): ${escapeHtml(service.lastReason ?? 'pending')}</li>`,
    )
    .join('');
  return `<h2>Destination ${escapeHtml(destination.name)} (${destinationType(destination.spec)})</h2>
<p>${escapeHtml(ready?.reason ?? 'Unknown')} ${escapeHtml(ready?.message ?? '')}</p>
<p>${escapeHtml(scheduleLine(destination))}</p>
<p>Skipped ${destination.status.skipped ?? 0}. Enrolled ${destination.status.enrolledServices ?? 0}.</p>
<ul>${services}</ul>
<form method="post" action="/backups"><input type="hidden" name="destination" value="${escapeHtml(destination.name)}"><button type="submit">Backup now</button></form>${
    destination.spec.sources?.length
      ? `\n<h3>Workload volumes</h3>\n<ul>${destination.spec.sources
          .map((source) =>
            sourceItem(
              destination,
              source,
              destination.status.sources?.find((row) => row.workloadName === source.workloadName),
            ),
          )
          .join('')}</ul>`
      : ''
  }`;
}

function historyItem(backup: BackupView): string {
  const volume = backup.source
    ? ` workload-volume ${escapeHtml(backup.source.workloadName)}${
        backup.volume?.scaleDownSeconds === undefined
          ? ''
          : ` scale-to-0 ${backup.volume.scaleDownSeconds}s`
      }`
    : '';
  return `<li>${escapeHtml(backup.name)} ${escapeHtml(backup.phase ?? 'Requested')} ${escapeHtml(backup.reason ?? '')} ${escapeHtml(backup.destinationName)}${volume} ${escapeHtml(backup.objectKey ?? '')}</li>`;
}

function optionList(backups: BackupView[]): string {
  return backups
    .map(
      (backup) => `<option value="${escapeHtml(backup.name)}">${escapeHtml(backup.name)}</option>`,
    )
    .join('');
}

export function render(world: World): string {
  const destinations = destinationsOf(world);
  const sections =
    destinations.length > 0
      ? destinations.map(destinationSection).join('\n')
      : '<p>Destination none.</p>';
  const backups = world.backups.map(historyItem).join('');
  const succeeded = world.backups.filter((backup) => backup.phase === 'Succeeded');
  const options = optionList(succeeded.filter((backup) => !backup.source));
  const volumes = optionList(succeeded.filter((backup) => backup.source));
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Backups</title></head>
<body>
<h1>Backups</h1>
<p>Namespace ${escapeHtml(world.tenantNamespace)}. Runtime ${escapeHtml(world.runtimeNamespace)}.</p>
${sections}
<h2>History</h2>
<ul>${backups}</ul>
<form method="post" action="/restores">
<label>Backup <select name="source">${options}</select></label>
<label>Empty target <input name="target" required></label>
<button type="submit">Restore</button>
</form>
<form method="post" action="/restores">
<label>Workload volume backup <select name="source">${volumes}</select></label>
<label>Target WorkloadDeployment (stopped while restoring) <input name="workload" required></label>
<label><input type="checkbox" name="force"> Replace existing data (kept as &lt;dir&gt;.replaced-&lt;stamp&gt;)</label>
<label>Expected encfs KCV (optional) <input name="kcv"></label>
<button type="submit">Restore volume</button>
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
  if (method === 'POST' && path === '/backups') {
    const destinations = destinationsOf(world);
    const wanted = formValue(body, 'destination');
    const destination = wanted
      ? destinations.find((item) => item.name === wanted)
      : destinations[0];
    if (wanted && !destination) return { status: 400, html: render(world), actions };
    const workload = formValue(body, 'workload');
    if (workload) {
      // Only a configured source: an on-demand copy stops the workload, so it is opted in.
      if (!destination?.spec.sources?.some((source) => source.workloadName === workload)) {
        return { status: 400, html: render(world), actions };
      }
      // One queued or running copy per source: a second request would stop it twice.
      if (backupInFlight(world, workload)) return { status: 409, html: render(world), actions };
      actions.push(requestBackup(world, destination, workload));
    } else if (destination) {
      actions.push({ type: 'annotate', name: destination.name, key: BACKUP_NOW, value: world.now });
    }
  }
  if (method === 'POST' && path === '/restores' && formValue(body, 'workload')) {
    const source = formValue(body, 'source');
    const workload = formValue(body, 'workload');
    const kcv = formValue(body, 'kcv').toLowerCase();
    const backup = world.backups.find(
      (item) => item.name === source && item.phase === 'Succeeded' && item.source,
    );
    if (
      !backup ||
      !NAME.test(workload) ||
      workload.length > 63 ||
      (kcv && !/^[0-9a-f]{32}$/.test(kcv))
    ) {
      return { status: 400, html: render(world), actions };
    }
    const unix = Math.floor(new Date(world.now).getTime() / 1000);
    actions.push({
      type: 'create-restore',
      body: {
        apiVersion: VERSION,
        kind: 'BackupRestore',
        metadata: {
          name: jobName('restore-volume', workload, unix),
          namespace: world.tenantNamespace,
        },
        spec: {
          sourceBackupName: source,
          targetWorkloadName: workload,
          ...(formValue(body, 'force') ? { force: true } : {}),
          ...(kcv ? { expectedKcv: kcv } : {}),
        },
      },
    });
  } else if (method === 'POST' && path === '/restores') {
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
