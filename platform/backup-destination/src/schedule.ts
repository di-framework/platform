const STEP = /^(\*|(\d+)(-(\d+))?)(\/(\d+))?$/;

function fieldMatches(field: string, value: number, min: number): boolean {
  return field.split(',').some((part) => {
    const match = STEP.exec(part);
    if (!match) return false;
    const start = match[1] === '*' ? min : Number(match[2]);
    const end =
      match[4] === undefined
        ? match[1] === '*'
          ? Number.POSITIVE_INFINITY
          : start
        : Number(match[4]);
    const step = match[6] === undefined ? 1 : Number(match[6]);
    if (!Number.isInteger(step) || step <= 0 || !Number.isInteger(start)) return false;
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

/** Five-field UTC cron. Every field must match, including day-of-week. */
export function cronMatches(expression: string, when: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields;
  if (!minute || !hour || !day || !month || !weekday) return false;
  const dow = when.getUTCDay();
  return (
    fieldMatches(minute, when.getUTCMinutes(), 0) &&
    fieldMatches(hour, when.getUTCHours(), 0) &&
    fieldMatches(day, when.getUTCDate(), 1) &&
    fieldMatches(month, when.getUTCMonth() + 1, 1) &&
    (fieldMatches(weekday, dow, 0) || (dow === 0 && fieldMatches(weekday, 7, 0)))
  );
}

export function previousFire(expression: string, now: Date): Date | undefined {
  const cursor = new Date(now);
  cursor.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (cronMatches(expression, cursor)) return new Date(cursor);
    cursor.setUTCMinutes(cursor.getUTCMinutes() - 1);
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
