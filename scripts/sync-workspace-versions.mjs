import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.env.NEXT;
if (!version) {
  console.error('NEXT is not set');
  process.exit(1);
}

const root = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const patterns = Array.isArray(root.workspaces) ? root.workspaces : [];
let updated = 0;

for (const pattern of patterns) {
  const directories = pattern.endsWith('/*')
    ? readdirSync(join(process.cwd(), pattern.slice(0, -2)), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(pattern.slice(0, -2), entry.name))
    : [pattern];

  for (const directory of directories) {
    const pkgPath = join(process.cwd(), directory, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.version === version) continue;
    writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
    updated += 1;
  }
}

console.log(`Set ${updated} workspace package version(s) to ${version}`);
