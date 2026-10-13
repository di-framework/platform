import { createHash } from 'node:crypto';
import { byName } from './io.ts';
import {
  type AgentIo,
  type AgentRequest,
  type ExecResult,
  finish,
  get,
  objectKey,
  type PipeEnd,
  put,
  pvcPath,
  rcloneEnv,
  remote,
  safeKey,
  type TreeEntry,
} from './run.ts';
import { type TarEntry, TarReader } from './tar.ts';

/**
 * Cold copies of tenant workload volumes (#232). The operator has already scaled the workload
 * to 0 and waited for its instances to go; this process only reads the volume (a read-only
 * hostPath mount) and writes to the destination, or, for a restore, fills a directory the
 * workload is not running on. It never decrypts anything: the bytes are copied as stored, and
 * the only thing read from the encfs marker is its key check value.
 */

export const ENCFS_MARKER = '.di-encfs';
/** The tenant host runs as this uid (platform `workload-storage.ts` HOST_UID). */
export const HOST_UID = 65532;
export const ARCHIVE = 'data.tar';
export const SUMS = 'SHA256SUMS';
export const MANIFEST = 'manifest.json';
/** Same rule as the platform's storage key: a DNS label of at most 50 characters. */
const STORAGE_KEY = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MIB = 1024 * 1024;
/** S3 allows 10,000 parts; leave room for headers and an estimate that runs short. */
const S3_PARTS = 9000;

export interface VolumeFile {
  path: string;
  size: number;
  mode: number;
  sha256: string;
  /** Owner as archived. Absent in manifests from before ownership was recorded. */
  uid?: number;
  gid?: number;
}

export interface VolumeDirectory {
  path: string;
  mode: number;
  uid?: number;
  gid?: number;
}

export interface VolumeManifest {
  apiVersion: 'platform.di-framework.dev/v1alpha1';
  kind: 'WorkloadVolumeManifest';
  workloadName: string;
  storageKey: string;
  /** UTC time the copy was taken. */
  stamp: string;
  image: string | null;
  /** `sha256:…` when the workload image is pinned by digest, else null. */
  imageDigest: string | null;
  fileCount: number;
  directoryCount: number;
  bytes: number;
  /** Hex of bytes 8..24 of `.di-encfs`, or null when the volume has no marker. */
  encfsKcv: string | null;
  /** Entries not owned by the host uid; a restore gives every entry its recorded owner. */
  foreignOwners: number;
  archive: typeof ARCHIVE;
  files: VolumeFile[];
  directories: VolumeDirectory[];
}

class VolumeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The encfs key check value: bytes 8..24 of the marker, hex. */
export function kcvOf(marker: Uint8Array): string {
  if (marker.byteLength < 24) throw new VolumeError('EncfsMarkerInvalid');
  return Buffer.from(marker.subarray(8, 24)).toString('hex');
}

export function imageDigestOf(image: string | undefined): string | null {
  return /@(sha256:[0-9a-f]{64})$/.exec(image ?? '')?.[1] ?? null;
}

/** `sha256sum -c` compatible lines, in manifest order. */
export function sumsText(files: VolumeFile[]): string {
  return files.map((file) => `${file.sha256}  ./${file.path}\n`).join('');
}

function compact(stamp: string): string {
  return stamp.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

interface Tree {
  files: TreeEntry[];
  directories: TreeEntry[];
}

/** Regular files and directories only: a link or device in a volume is refused, not followed. */
async function readTree(io: AgentIo, root: string): Promise<Tree> {
  const entries = await io.scan(root);
  if (entries.some((entry) => entry.type !== 'file' && entry.type !== 'directory')) {
    throw new VolumeError('UnsupportedEntry');
  }
  return {
    files: entries.filter((entry) => entry.type === 'file'),
    directories: entries.filter((entry) => entry.type === 'directory'),
  };
}

/** What changes when anything writes: content (size, mtime, ctime), identity (ino), or mode. */
function fingerprint(tree: Tree): string {
  return JSON.stringify(
    [...tree.directories, ...tree.files].map((entry) => [
      entry.path,
      entry.type,
      entry.size,
      entry.mtimeMs,
      entry.ctimeMs,
      entry.ino,
      entry.mode,
    ]),
  );
}

function destinationMissing(request: AgentRequest): string | undefined {
  if (request.destinationType === 'pvc') return request.pvcMountPath ? undefined : 'MissingClaim';
  return request.bucket ? undefined : 'MissingBucket';
}

/**
 * A part size that keeps any volume under S3's 10,000-part limit (rclone's 5 MiB default caps an
 * unknown-size stream near 48 GiB). Memory stays predictable: rclone buffers 4 parts.
 */
export function chunkSize(tree: Tree): string {
  const blocks = (size: number) => Math.ceil(size / 512) * 512;
  const estimate =
    tree.files.reduce((total, file) => total + blocks(file.size), 0) +
    (tree.files.length + tree.directories.length + 2) * 2048 +
    10240;
  return `${Math.max(5, Math.ceil(estimate / S3_PARTS / MIB))}Mi`;
}

function tarCreate(source: string): PipeEnd {
  return { argv: ['tar', '--numeric-owner', '-C', source, '-cf', '-', '.'] };
}

/** Archive the source in one read: the bytes are hashed on their way to the destination. */
async function archiveTo(
  io: AgentIo,
  request: AgentRequest,
  source: string,
  reader: TarReader,
  tree: Tree,
): Promise<ExecResult> {
  const inspect = (chunk: Uint8Array) => reader.push(chunk);
  if (request.destinationType === 'pvc') {
    const target = pvcPath(request, ARCHIVE) as string;
    try {
      await io.mkdir(target.slice(0, target.lastIndexOf('/')));
    } catch (error) {
      return { code: 1, stdout: '', stderr: String(error) };
    }
    const made = await io.pipe(tarCreate(source), { file: `${target}.partial` }, inspect);
    if (made.code !== 0) return { ...made, stdout: '' };
    const flushed = await io.exec(['sync', `${target}.partial`]);
    if (flushed.code !== 0) return flushed;
    return io.exec(['mv', '-f', `${target}.partial`, target]);
  }
  const sent = await io.pipe(
    tarCreate(source),
    {
      argv: ['rclone', 'rcat', '--s3-chunk-size', chunkSize(tree), remote(request, ARCHIVE)],
      env: rcloneEnv(request),
    },
    inspect,
  );
  return { ...sent, stdout: '' };
}

/** Leave nothing behind that looks like a backup when this one failed. */
async function discard(io: AgentIo, request: AgentRequest): Promise<void> {
  if (request.destinationType === 'pvc') {
    const target = pvcPath(request, ARCHIVE) as string;
    await io.remove(`${target}.partial`);
    await io.remove(target);
    return;
  }
  await io.exec(['rclone', 'deletefile', remote(request, ARCHIVE)], { env: rcloneEnv(request) });
}

/** The archive holds exactly the scanned tree: same paths, types, and sizes. */
function sameTree(archived: TarEntry[], tree: Tree): boolean {
  const expected = new Map<string, string>([
    ...tree.files.map((file) => [file.path, `file:${file.size}`] as const),
    ...tree.directories.map((entry) => [entry.path, 'directory'] as const),
  ]);
  if (archived.length !== expected.size) return false;
  return archived.every(
    (entry) =>
      expected.get(entry.path) === (entry.type === 'file' ? `file:${entry.size}` : entry.type),
  );
}

export async function backupVolume(io: AgentIo, request: AgentRequest): Promise<number> {
  const fail = (error: string) =>
    finish(io, request.terminationLog, { ok: false, error: error.slice(0, 180) });
  const source = request.sourceDir;
  if (!source) return fail('MissingSource');
  const missing = destinationMissing(request);
  if (missing) return fail(missing);
  if (!safeKey(objectKey(request, ARCHIVE))) return fail('PvcPathInvalid');
  let before: Tree;
  let encfsKcv: string | null;
  try {
    before = await readTree(io, source);
    const marked = before.files.some((file) => file.path === ENCFS_MARKER);
    encfsKcv = marked ? kcvOf(await io.readFile(`${source}/${ENCFS_MARKER}`)) : null;
  } catch (error) {
    return fail(error instanceof VolumeError ? error.code : 'SourceUnreadable');
  }
  const reader = new TarReader(true);
  const archived = await archiveTo(io, request, source, reader, before);
  if (archived.code !== 0) {
    await discard(io, request);
    return fail('UploadFailed');
  }
  let entries: TarEntry[];
  try {
    entries = reader.finish();
  } catch {
    await discard(io, request);
    return fail('ArchiveInvalid');
  }
  // The workload was stopped; a volume that changed during the copy means something still writes.
  const after = await readTree(io, source).catch(() => undefined);
  if (!after || fingerprint(after) !== fingerprint(before) || !sameTree(entries, before)) {
    await discard(io, request);
    return fail('SourceChanged');
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const owner = (path: string) => {
    const entry = byPath.get(path) as TarEntry;
    return { uid: entry.uid, gid: entry.gid };
  };
  const files: VolumeFile[] = before.files.map((file) => ({
    path: file.path,
    size: file.size,
    mode: file.mode,
    sha256: byPath.get(file.path)?.sha256 as string,
    ...owner(file.path),
  }));
  const directories: VolumeDirectory[] = before.directories.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    ...owner(entry.path),
  }));
  const manifest: VolumeManifest = {
    apiVersion: 'platform.di-framework.dev/v1alpha1',
    kind: 'WorkloadVolumeManifest',
    workloadName: request.workloadName ?? '',
    storageKey: request.storageKey ?? '',
    stamp: request.stamp ?? new Date().toISOString(),
    image: request.sourceImage || null,
    imageDigest: imageDigestOf(request.sourceImage),
    fileCount: files.length,
    directoryCount: directories.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    encfsKcv,
    foreignOwners: [...files, ...directories].filter(
      (entry) => entry.uid !== HOST_UID || entry.gid !== HOST_UID,
    ).length,
    archive: ARCHIVE,
    files,
    directories,
  };
  const json = JSON.stringify(manifest);
  const sums = `${request.workdir}/${SUMS}`;
  const meta = `${request.workdir}/${MANIFEST}`;
  await io.writeFile(sums, sumsText(manifest.files));
  await io.writeFile(meta, json);
  // The manifest goes last: its presence marks a complete backup.
  for (const [file, name] of [
    [sums, SUMS],
    [meta, MANIFEST],
  ] as const) {
    if ((await put(io, request, file, name)).code !== 0) {
      await discard(io, request);
      return fail('UploadFailed');
    }
  }
  return finish(io, request.terminationLog, {
    ok: true,
    digest: `sha256:${createHash('sha256').update(json).digest('hex')}`,
    bytes: manifest.bytes,
    objectKey: objectKey(request, ARCHIVE),
    tool: 'tar',
    format: 'workload-volume',
    fileCount: manifest.fileCount,
    ...(manifest.encfsKcv ? { encfsKcv: manifest.encfsKcv } : {}),
    ...(manifest.imageDigest ? { imageDigest: manifest.imageDigest } : {}),
  });
}

const ownerValid = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);

export function parseManifest(text: string): VolumeManifest | undefined {
  let parsed: Partial<VolumeManifest>;
  try {
    parsed = JSON.parse(text) as Partial<VolumeManifest>;
  } catch {
    return undefined;
  }
  if (parsed?.kind !== 'WorkloadVolumeManifest') return undefined;
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.directories)) return undefined;
  const filesValid = parsed.files.every(
    (file) =>
      typeof file?.path === 'string' &&
      safeKey(file.path) &&
      typeof file.size === 'number' &&
      typeof file.sha256 === 'string' &&
      SHA256.test(file.sha256) &&
      ownerValid(file.uid) &&
      ownerValid(file.gid),
  );
  const directoriesValid = parsed.directories.every(
    (directory) =>
      typeof directory?.path === 'string' &&
      safeKey(directory.path) &&
      ownerValid(directory.uid) &&
      ownerValid(directory.gid),
  );
  if (!filesValid || !directoriesValid) return undefined;
  if (parsed.encfsKcv !== null && !/^[0-9a-f]{32}$/.test(String(parsed.encfsKcv))) return undefined;
  return parsed as VolumeManifest;
}

function archiveSource(request: AgentRequest): PipeEnd {
  if (request.destinationType === 'pvc') return { file: pvcPath(request, ARCHIVE) as string };
  return { argv: ['rclone', 'cat', remote(request, ARCHIVE)], env: rcloneEnv(request) };
}

/**
 * List the archive before anything is extracted. The tenant controls it (bucket or claim), and
 * it is extracted as root into the directory that holds every workload volume of the tenant:
 * refuse any member that is not a regular file or directory the manifest names, with its size.
 */
async function inspectArchive(
  io: AgentIo,
  request: AgentRequest,
  manifest: VolumeManifest,
): Promise<string | undefined> {
  const reader = new TarReader(false);
  const read = await io.pipe(archiveSource(request), undefined, (chunk) => reader.push(chunk));
  if (read.code !== 0)
    return read.stderr.includes('ArchiveInvalid') ? 'ArchiveRejected' : 'DownloadFailed';
  let entries: TarEntry[];
  try {
    entries = reader.finish();
  } catch {
    return 'ArchiveRejected';
  }
  const named = new Map<string, string>([
    ...manifest.files.map((file) => [file.path, `file:${file.size}`] as const),
    ...manifest.directories.map((entry) => [entry.path, 'directory'] as const),
  ]);
  const seen = new Set<string>();
  for (const entry of entries) {
    const shape = entry.type === 'file' ? `file:${entry.size}` : entry.type;
    if (named.get(entry.path) !== shape || seen.has(entry.path)) return 'ArchiveRejected';
    seen.add(entry.path);
  }
  return seen.size === named.size ? undefined : 'ArchiveRejected';
}

function extractTo(io: AgentIo, request: AgentRequest, staging: string): Promise<ExecResult> {
  if (request.destinationType === 'pvc') {
    const archive = pvcPath(request, ARCHIVE) as string;
    return io.exec(['tar', '-x', '-p', '--no-same-owner', '-f', archive, '-C', staging]);
  }
  return io.exec(
    [
      'bash',
      '-c',
      'set -o pipefail; rclone cat "$1" | tar -x -p --no-same-owner -f - -C "$2"',
      'volume-restore',
      remote(request, ARCHIVE),
      staging,
    ],
    { env: rcloneEnv(request) },
  );
}

/** Every file and directory the manifest names, nothing else, every hash, and the marker KCV. */
async function verify(
  io: AgentIo,
  root: string,
  manifest: VolumeManifest,
): Promise<string | undefined> {
  const tree = await readTree(io, root).catch((error: unknown) =>
    error instanceof VolumeError ? error.code : 'ContentMismatch',
  );
  if (typeof tree === 'string') return tree;
  const paths = (entries: { path: string }[]) =>
    JSON.stringify(entries.map((entry) => entry.path).sort(byName));
  if (paths(tree.files) !== paths(manifest.files)) return 'ContentMismatch';
  if (paths(tree.directories) !== paths(manifest.directories)) return 'ContentMismatch';
  const sizes = new Map(tree.files.map((file) => [file.path, file.size]));
  for (const file of manifest.files) {
    if (sizes.get(file.path) !== file.size) return 'HashMismatch';
    if ((await io.hash(`${root}/${file.path}`)) !== file.sha256) return 'HashMismatch';
  }
  if (sizes.has(ENCFS_MARKER) !== (manifest.encfsKcv !== null)) return 'KcvMismatch';
  if (manifest.encfsKcv !== null) {
    const kcv = await io
      .readFile(`${root}/${ENCFS_MARKER}`)
      .then(kcvOf)
      .catch(() => undefined);
    if (kcv !== manifest.encfsKcv) return 'KcvMismatch';
  }
  return undefined;
}

async function markerKcv(io: AgentIo, path: string): Promise<string | undefined> {
  return io
    .readFile(path)
    .then(kcvOf)
    .catch(() => undefined);
}

/** Every restored entry gets the owner the manifest recorded; older manifests mean the host uid. */
async function restoreOwners(io: AgentIo, target: string, manifest: VolumeManifest) {
  await io.chown(target, HOST_UID, HOST_UID);
  for (const entry of [...manifest.directories, ...manifest.files]) {
    await io.chown(`${target}/${entry.path}`, entry.uid ?? HOST_UID, entry.gid ?? HOST_UID);
  }
}

export async function restoreVolume(io: AgentIo, request: AgentRequest): Promise<number> {
  const fail = (error: string, paths: { replacedPath?: string; restoringPath?: string } = {}) =>
    finish(io, request.terminationLog, { ok: false, error, ...paths });
  const key = request.storageKey ?? '';
  const root = request.targetRoot;
  if (!root || key.length > 50 || !STORAGE_KEY.test(key)) return fail('MissingTarget');
  const missing = destinationMissing(request);
  if (missing) return fail(missing);
  if (!safeKey(objectKey(request, ARCHIVE))) return fail('PvcPathInvalid');
  const stamp = compact(request.stamp ?? new Date().toISOString());
  const target = `${root}/${key}`;
  let existing: string[];
  try {
    existing = await io.list(target);
  } catch (error) {
    // Only a target that does not exist is empty. Any other error must not read as "empty":
    // that would skip the non-empty check and overwrite live data.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return fail('TargetUnreadable');
    await io.mkdir(target);
    existing = [];
  }
  if (existing.length > 0 && !request.force) return fail('TargetNotEmpty');
  const meta = `${request.workdir}/${MANIFEST}`;
  const sums = `${request.workdir}/${SUMS}`;
  if ((await get(io, request, MANIFEST, meta)).code !== 0) return fail('DownloadFailed');
  if ((await get(io, request, SUMS, sums)).code !== 0) return fail('DownloadFailed');
  const manifest = parseManifest(Buffer.from(await io.readFile(meta)).toString('utf8'));
  if (!manifest) return fail('ManifestInvalid');
  if (Buffer.from(await io.readFile(sums)).toString('utf8') !== sumsText(manifest.files)) {
    return fail('ManifestInvalid');
  }
  if (request.expectedKcv && manifest.encfsKcv !== request.expectedKcv) return fail('KcvMismatch');
  // Replacing data encrypted under one key with data under another would leave the workload
  // unable to open it. Only an explicit expectedKcv may change the key.
  const previous = existing.includes(ENCFS_MARKER)
    ? await markerKcv(io, `${target}/${ENCFS_MARKER}`)
    : undefined;
  if (previous && previous !== manifest.encfsKcv && !request.expectedKcv) {
    return fail('KcvMismatch');
  }
  const rejected = await inspectArchive(io, request, manifest);
  if (rejected) return fail(rejected);
  const staging = `${root}/${key}.restoring-${stamp}`;
  await io.remove(staging);
  await io.mkdir(staging);
  if ((await extractTo(io, request, staging)).code !== 0) {
    await io.remove(staging);
    return fail('DownloadFailed');
  }
  const invalid = await verify(io, staging, manifest);
  if (invalid) {
    await io.remove(staging);
    return fail(invalid);
  }
  let replacedPath: string | undefined;
  const relative = (path: string | undefined) => path?.slice(root.length + 1);
  try {
    // Entries move, not the directory: the tenant host pod has `<key>` itself bind-mounted.
    if (existing.length > 0) {
      replacedPath = `${root}/${key}.replaced-${stamp}`;
      await io.mkdir(replacedPath);
      for (const name of existing) await io.rename(`${target}/${name}`, `${replacedPath}/${name}`);
    }
    for (const name of await io.list(staging)) {
      await io.rename(`${staging}/${name}`, `${target}/${name}`);
    }
    await io.remove(staging);
  } catch {
    // Part-way: say where everything is. Nothing is deleted; the README says how to clean up.
    return fail('RestoreFailed', {
      ...(replacedPath ? { replacedPath: relative(replacedPath) } : {}),
      restoringPath: relative(staging),
    });
  }
  try {
    await restoreOwners(io, target, manifest);
  } catch {
    return fail('OwnershipFailed', replacedPath ? { replacedPath: relative(replacedPath) } : {});
  }
  return finish(io, request.terminationLog, {
    ok: true,
    tool: 'tar',
    format: 'workload-volume',
    fileCount: manifest.fileCount,
    ...(manifest.encfsKcv ? { encfsKcv: manifest.encfsKcv } : {}),
    ...(replacedPath ? { replacedPath: relative(replacedPath) } : {}),
  });
}

/**
 * Run on the volume's node before anything is stopped: the hostPath and the destination claim
 * mounted, and they are directories. A pod that cannot schedule or mount never gets here, and
 * the operator gives up at its start deadline, with no downtime.
 */
export async function probePlacement(io: AgentIo, request: AgentRequest): Promise<number> {
  const paths = (request.probePaths ?? '').split(':').filter(Boolean);
  if (paths.length === 0) {
    return finish(io, request.terminationLog, { ok: false, error: 'PlacementInvalid' });
  }
  for (const path of paths) {
    if (!(await io.isDirectory(path))) {
      return finish(io, request.terminationLog, { ok: false, error: 'PlacementInvalid' });
    }
  }
  return finish(io, request.terminationLog, { ok: true, tool: 'probe', format: 'placement' });
}
