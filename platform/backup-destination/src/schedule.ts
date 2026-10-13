const PART = /^(\*|(\d+)(-(\d+))?)(\/(\d+))?$/;
/** minute, hour, day of month, month, day of week (0 and 7 are Sunday). */
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
/** A yearly date (29 February) recurs within 8 years, even across a skipped leap year. */
const LOOKBACK_DAYS = 8 * 366;

type Fields = [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];

function parseField(field: string, [min, max]: [number, number]): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = PART.exec(part);
    if (!match) return undefined;
    const star = match[1] === '*';
    const start = star ? min : Number(match[2]);
    const end = match[4] !== undefined ? Number(match[4]) : star ? max : start;
    const step = match[6] === undefined ? 1 : Number(match[6]);
    if (step < 1 || start < min || end > max || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function parse(expression: string): Fields | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const parsed = fields.map((field, index) => parseField(field, RANGES[index] as [number, number]));
  if (parsed.some((set) => set === undefined)) return undefined;
  const sets = parsed as Fields;
  if (sets[4].has(7)) sets[4].add(0);
  return sets;
}

/**
 * Five-field UTC cron: numbers, `*`, ranges, steps, and lists, each value in its field's range.
 * Anything else is invalid and never fires; the status row says `InvalidSchedule`.
 */
export function validCron(expression: string): boolean {
  return parse(expression) !== undefined;
}

function dayMatches(fields: Fields, day: Date): boolean {
  return (
    fields[3].has(day.getUTCMonth() + 1) &&
    fields[2].has(day.getUTCDate()) &&
    fields[4].has(day.getUTCDay())
  );
}

/** Every field must match, including day-of-week. */
export function cronMatches(expression: string, when: Date): boolean {
  const fields = parse(expression);
  if (!fields) return false;
  return (
    fields[0].has(when.getUTCMinutes()) &&
    fields[1].has(when.getUTCHours()) &&
    dayMatches(fields, when)
  );
}

/** The latest minute at or before `now` the schedule fires, within eight years. */
export function previousFire(expression: string, now: Date): Date | undefined {
  const fields = parse(expression);
  if (!fields) return undefined;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let back = 0; back <= LOOKBACK_DAYS; back += 1) {
    const day = new Date(today - back * 86_400_000);
    if (!dayMatches(fields, day)) continue;
    const lastHour = back === 0 ? now.getUTCHours() : 23;
    for (let hour = lastHour; hour >= 0; hour -= 1) {
      if (!fields[1].has(hour)) continue;
      const lastMinute = back === 0 && hour === lastHour ? now.getUTCMinutes() : 59;
      for (let minute = lastMinute; minute >= 0; minute -= 1) {
        if (fields[0].has(minute)) return new Date(day.getTime() + (hour * 60 + minute) * 60_000);
      }
    }
  }
  return undefined;
}

export function isDue(expression: string, lastAttempt: string | undefined, now: Date): boolean {
  const fire = previousFire(expression, now);
  if (!fire) return false;
  if (!lastAttempt) return true;
  const attempted = new Date(lastAttempt);
  if (Number.isNaN(attempted.getTime())) return true;
  return attempted.getTime() < fire.getTime();
}
