#!/usr/bin/env bun
/**
 * Package coverage mapping, LCOV parsing, metric calculation,
 * and Shields.io endpoint badge JSON generation.
 *
 * Badge JSON is the Shields endpoint shape: schemaVersion 1, label
 * "line coverage", a percentage message, and a color.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Public host expected to serve the generated Shields endpoint JSON. */
export const COVERAGE_BADGE_PUBLIC_BASE = 'https://docs.di-framework.dev/coverage';

/** Shields.io endpoint badge URL for a package slug (e.g. "core"). */
export function shieldsEndpointBadgeUrl(slug: string): string {
  const endpoint = `${COVERAGE_BADGE_PUBLIC_BASE}/${slug}.json`;
  return `https://img.shields.io/endpoint?url=${encodeURIComponent(endpoint)}`;
}

export interface PackageInfo {
  name: string; // e.g. "@di-framework/platform"
  slug: string; // e.g. "platform"
  dirName: string; // e.g. "platform"
  relPath: string; // e.g. "platform/platform"
  isMeasured: boolean;
  unmeasuredReason?: string;
}

export interface FileCoverageRecord {
  file: string;
  packageSlug: string | null;
  lf: number;
  lh: number;
  uncoveredLines: number[];
}

export interface PackageMetric {
  name: string;
  slug: string;
  dirName: string;
  relPath: string;
  isMeasured: boolean;
  unmeasuredReason?: string;
  lf: number;
  lh: number;
  percentage: number | null;
  status: string; // e.g. "100%", "N/A"
  badgeColor: string; // "brightgreen", "green", "yellowgreen", "yellow", "red", "lightgrey"
  badgeMessage: string; // "100%", "N/A"
}

export interface ShieldBadgeJson {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

/**
 * Registry of packages that do not contain instrumented TypeScript source files.
 * These are handled explicitly and honestly (labeled N/A) rather than inheriting
 * aggregate coverage from other packages.
 */
export const UNMEASURED_PACKAGES: Record<string, string> = {};

/** Hidden directories (tool caches, local agent state) are skipped as well. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'target']);

let indexedPackages: PackageInfo[] = [];
let indexedRoot = '';

function considerPackage(dir: string, root: string, packages: PackageInfo[]): void {
  const pkgJsonPath = join(dir, 'package.json');
  if (!existsSync(pkgJsonPath)) return;

  try {
    const content = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: unknown };
    if (typeof content.name !== 'string' || !content.name.startsWith('@di-framework/')) return;

    const relPath = relative(root, dir).replace(/\\/g, '/');
    if (!relPath || relPath.startsWith('..')) return;

    const name = content.name;
    packages.push({
      name,
      slug: name.replace('@di-framework/', ''),
      dirName: relPath.slice(relPath.lastIndexOf('/') + 1),
      relPath,
      isMeasured: !(name in UNMEASURED_PACKAGES),
      unmeasuredReason: UNMEASURED_PACKAGES[name],
    });
  } catch {
    // Ignore invalid package.json
  }
}

function collectPackages(dir: string, root: string, packages: PackageInfo[]): void {
  // CI checks out other repositories (for example sqlite-src) beside the packages
  // under test. Those trees have their own .git and must not become badges.
  if (dir !== root && existsSync(join(dir, '.git'))) return;

  considerPackage(dir, root, packages);

  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }
    collectPackages(join(dir, entry.name), root, packages);
  }
}

/**
 * Discovers every @di-framework/* package in the repository.
 * Nested workspace packages are included. node_modules and nested checkouts are not.
 */
export function getWorkspacePackages(rootDir?: string): PackageInfo[] {
  const root = resolve(rootDir ?? process.cwd());
  const packages: PackageInfo[] = [];
  if (existsSync(root)) collectPackages(root, root, packages);
  packages.sort((a, b) => a.name.localeCompare(b.name));
  indexedPackages = packages;
  indexedRoot = root;
  return packages;
}

function repoRelative(filePath: string, root: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === rootNorm) return '';
  if (normalized.startsWith(`${rootNorm}/`)) return normalized.slice(rootNorm.length + 1);
  return normalized.replace(/^\.\//, '');
}

/**
 * Extracts package slug from a file path using the discovered package directories.
 * The slug is the package name with the @di-framework/ prefix removed.
 */
export function getPackageSlugFromPath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/examples/') || normalized.startsWith('examples/')) return null;
  if (indexedPackages.length === 0) getWorkspacePackages();

  const relativePath = repoRelative(normalized, indexedRoot);
  let match: PackageInfo | null = null;
  for (const pkg of indexedPackages) {
    if (relativePath === pkg.relPath || relativePath.startsWith(`${pkg.relPath}/`)) {
      if (!match || pkg.relPath.length > match.relPath.length) match = pkg;
    }
  }
  return match?.slug ?? null;
}

/**
 * Checks if a file path is a valid production source file for line coverage.
 */
export function isSourceFile(filePath: string): boolean {
  const sf = filePath.replace(/\\/g, '/');
  if (getPackageSlugFromPath(sf) === null) return false;
  if (sf.includes('/tests/') || sf.includes('/test/')) return false;
  if (sf.includes('/dist/')) return false;
  if (sf.endsWith('.test.ts') || sf.endsWith('.test.js') || sf.endsWith('.test.tsx')) return false;
  if (sf.endsWith('.spec.ts') || sf.endsWith('.spec.js') || sf.endsWith('.spec.tsx')) return false;
  if (sf.includes('preload-wasm-mock')) return false;
  if (sf.includes('/scripts/') || sf.startsWith('scripts/')) return false;
  return sf.endsWith('.ts') || sf.endsWith('.js') || sf.endsWith('.tsx');
}

/**
 * Parses LCOV string content into per-file records.
 */
export function parseLcov(lcovContent: string): FileCoverageRecord[] {
  const records: FileCoverageRecord[] = [];
  for (const block of lcovContent.split('end_of_record')) {
    const lines = block.split('\n');
    const sfLine = lines.find((line) => line.startsWith('SF:'));
    if (!sfLine) continue;

    const file = sfLine.slice(3).trim();
    if (!isSourceFile(file)) continue;

    const packageSlug = getPackageSlugFromPath(file);
    const uncoveredLines: number[] = [];
    let hitsCount = 0;
    let totalCount = 0;

    for (const line of lines) {
      if (line.startsWith('DA:')) {
        const parts = line.slice(3).split(',');
        const lineno = Number(parts[0]);
        const hits = Number(parts[1]);
        totalCount++;
        if (hits > 0) {
          hitsCount++;
        } else {
          uncoveredLines.push(lineno);
        }
      }
    }

    records.push({
      file,
      packageSlug,
      lf: totalCount,
      lh: hitsCount,
      uncoveredLines,
    });
  }
  return records;
}

/**
 * Calculates per-package metrics given workspace packages and parsed LCOV records.
 */
export function calculatePackageMetrics(
  packages: PackageInfo[],
  records: FileCoverageRecord[],
): PackageMetric[] {
  return packages.map((pkg) => {
    if (!pkg.isMeasured) {
      return {
        ...pkg,
        lf: 0,
        lh: 0,
        percentage: null,
        status: 'N/A',
        badgeColor: 'lightgrey',
        badgeMessage: 'N/A',
      };
    }

    const pkgRecords = records.filter((record) => record.packageSlug === pkg.slug);
    const lf = pkgRecords.reduce((acc, record) => acc + record.lf, 0);
    const lh = pkgRecords.reduce((acc, record) => acc + record.lh, 0);

    if (lf === 0) {
      return {
        ...pkg,
        lf: 0,
        lh: 0,
        percentage: null,
        status: 'N/A',
        badgeColor: 'lightgrey',
        badgeMessage: 'N/A',
      };
    }

    const rawPct = (lh / lf) * 100;
    const pct = Number(rawPct.toFixed(1));
    const pctStr = pct === 100 ? '100%' : `${pct}%`;
    let color = 'brightgreen';
    if (pct < 60) color = 'red';
    else if (pct < 80) color = 'yellow';
    else if (pct < 95) color = 'yellowgreen';
    else if (pct < 100) color = 'green';

    return {
      ...pkg,
      lf,
      lh,
      percentage: pct,
      status: pctStr,
      badgeColor: color,
      badgeMessage: pctStr,
    };
  });
}

/**
 * Generates Shields.io endpoint badge JSON object.
 */
export function generateShieldBadgeJson(metric: PackageMetric): ShieldBadgeJson {
  return {
    schemaVersion: 1,
    label: 'line coverage',
    message: metric.badgeMessage,
    color: metric.badgeColor,
  };
}

/**
 * Writes one Shields endpoint JSON file per package under outDir/{slug}.json.
 */
export function writeShieldBadgeFiles(metrics: PackageMetric[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const metric of metrics) {
    const filePath = join(outDir, `${metric.slug}.json`);
    writeFileSync(filePath, `${JSON.stringify(generateShieldBadgeJson(metric))}\n`);
    written.push(filePath);
  }
  return written;
}
