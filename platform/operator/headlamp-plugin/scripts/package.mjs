// Packs the built plugin into a deterministic tarball for Headlamp's plugin manager.
//
// Same layout as `headlamp-plugin package` (0.14.0): one top-level folder holding dist/* and
// package.json. pluginctl extracts it with `strip: 1`, so only the files matter, and the folder is
// named after the plugin. Unlike upstream, which records the build's mtimes, uid/gid and readdir
// order, every entry here has a fixed mtime (0), mode, owner and order, and the gzip header carries
// no timestamp and a fixed OS byte, so the same dist/main.js always gives the same sha256.
//
// Usage: node scripts/package.mjs [outDir]   (default: dist-package/)

import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { create } from 'tar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, process.argv[2] ?? 'dist-package');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pluginName = pkg.name.replace(/@/g, '').replace(/\//g, '-');
const tarballName = `${pluginName}-${pkg.version}.tar.gz`;
const distDir = join(root, 'dist');

if (!existsSync(join(distDir, 'main.js'))) {
  console.error('dist/main.js is missing: run `headlamp-plugin build` first.');
  process.exit(1);
}

const EPOCH = new Date(0);

/** Every file under dir, as sorted paths relative to it (byte order, not locale). */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full).map((p) => join(name, p)));
    } else {
      out.push(name);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const staging = mkdtempSync(join(tmpdir(), 'headlamp-plugin-package-'));
try {
  const top = join(staging, pluginName);
  mkdirSync(top);
  for (const file of walk(distDir)) {
    mkdirSync(dirname(join(top, file)), { recursive: true });
    copyFileSync(join(distDir, file), join(top, file));
  }
  copyFileSync(join(root, 'package.json'), join(top, 'package.json'));

  // Fixed modes and mtimes; the list below fixes the order (directories before their contents).
  const entries = [pluginName];
  for (const file of walk(top)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = join(pluginName, ...parts.slice(0, i));
      if (!entries.includes(d)) entries.push(d);
    }
    entries.push(join(pluginName, file));
  }
  for (const entry of entries) {
    const p = join(staging, entry);
    chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
    utimesSync(p, EPOCH, EPOCH);
  }

  const chunks = [];
  const stream = create(
    { cwd: staging, portable: true, mtime: EPOCH, noDirRecurse: true },
    entries,
  );
  for await (const chunk of stream) chunks.push(chunk);
  const tarBytes = Buffer.concat(chunks);

  const gz = gzipSync(tarBytes, { level: 9 });
  // RFC 1952 header: MTIME (bytes 4-7) is already 0; OS (byte 9) depends on the zlib build, so fix
  // it to 3 (Unix) to keep the archive identical on macOS and Linux.
  gz[9] = 3;

  mkdirSync(outDir, { recursive: true });
  const tarballPath = join(outDir, tarballName);
  writeFileSync(tarballPath, gz);
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const tarSha256 = createHash('sha256').update(tarBytes).digest('hex');
  writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${tarballName}\n`);

  console.log(`Created tarball: "${relative(process.cwd(), tarballPath)}".`);
  console.log(`Entries: ${entries.join(', ')}`);
  console.log(`Size: ${gz.length} bytes`);
  console.log(`Tarball checksum (sha256): ${sha256}`);
  console.log(`Uncompressed tar checksum (sha256): ${tarSha256}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
