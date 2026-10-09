/** `scripts/tool-versions.env`: the single pin file for every tool this package downloads. */
import { join } from 'node:path';

export type Pins = Record<string, string>;

/** Parse `KEY=VALUE` lines; `#` comments and blank lines are skipped. */
export function parseVersions(text: string): Pins {
  const pins: Pins = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) pins[key] = value;
  }
  return pins;
}

export function requiredPin(pins: Pins, name: string): string {
  const value = pins[name];
  if (!value) throw new Error(`missing pin ${name} in scripts/tool-versions.env`);
  return value;
}

export async function loadPins(pkgDir: string): Promise<Pins> {
  return parseVersions(await Bun.file(join(pkgDir, 'scripts', 'tool-versions.env')).text());
}
