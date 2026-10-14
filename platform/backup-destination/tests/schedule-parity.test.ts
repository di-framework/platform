import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { backupReleaseArgs } from '../src/install.ts';
import { validCron } from '../src/schedule.ts';
import { helm } from './support/helm.ts';

/** Exit code of `helm template` with this schedule, on the destination and on a source. */
async function chartAccepts(schedule: string, where: 'destination' | 'source'): Promise<boolean> {
  const values =
    where === 'destination'
      ? ['--set-string', `schedule=${schedule.replaceAll(',', '\\,')}`]
      : [
          '--set-string',
          'schedule=none',
          '--set',
          'type=pvc',
          '--set-string',
          'existingClaimName=c',
          '--set-string',
          'sources[0].workloadName=identity',
          '--set-string',
          `sources[0].schedule=${schedule.replaceAll(',', '\\,')}`,
        ];
  const child = Bun.spawn(
    [
      await helm(),
      'template',
      'backups',
      join(import.meta.dir, '..', 'chart'),
      '--namespace',
      'di-tenant-alpha',
      '--set-string',
      'bucket=b',
      '--set-string',
      'existingSecret=s',
      ...values,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  if (code !== 0) expect(stderr).toContain('must be a five-field UTC cron');
  return code === 0;
}

function installerAccepts(schedule: string, where: 'destination' | 'source'): boolean {
  const base = { tenant: 'alpha', chart: '/chart', type: 'pvc' as const, existingClaimName: 'c' };
  try {
    backupReleaseArgs(
      where === 'destination'
        ? { ...base, schedule }
        : { ...base, schedule: 'none', sources: [{ workloadName: 'identity', schedule }] },
    );
    return true;
  } catch (error) {
    expect(String(error)).toContain('five-field UTC cron');
    return false;
  }
}

describe('#263 S5: the installer and the chart accept the same crons', () => {
  // Accepted forms the operator fires, and forms on the edges of the two rule sets.
  const accepted = [
    '0 2 * * *',
    '05 2 * * *',
    '*/15 0-2 1,15 1-6 1-5',
    '59 23 31 12 0-7/7',
    '*/1 * * * *',
    '0 0 29 2 *',
    '5-5 * * * *',
  ];
  const refused = [
    '005 * * * *',
    '*/01 * * * *',
    '5-1 * * * *',
    '0 2 * 12-1 *',
    '0 2 1,31-1 * *',
    '0 23-0 * * *',
    '0 2 * * 5-1',
    '60 * * * *',
    '*/0 * * * *',
    '0  2 * * *',
    '0 2 * * * *',
  ];

  test('every form is accepted or refused by both, for the destination and for a source', async () => {
    const cases = (['destination', 'source'] as const).flatMap((where) => [
      ...accepted.map((schedule) => ({ schedule, where, expected: true })),
      ...refused.map((schedule) => ({ schedule, where, expected: false })),
    ]);
    // The renders are independent: run them together, as chart.test.ts does.
    const verdicts = await Promise.all(
      cases.map(async ({ schedule, where }) => ({
        schedule,
        where,
        installer: installerAccepts(schedule, where),
        chart: await chartAccepts(schedule, where),
      })),
    );
    expect(verdicts).toEqual(
      cases.map(({ schedule, where, expected }) => ({
        schedule,
        where,
        installer: expected,
        chart: expected,
      })),
    );
    // Whatever both accept, the operator can fire.
    for (const schedule of accepted) expect(validCron(schedule)).toBe(true);
  }, 60_000);
});
