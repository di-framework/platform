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
 * only the encfs marker is read: its form gives the directory's mode and key check value.
 */

export const ENCFS_MARKER = '.di-encfs';
/** encfs writes the marker through this name and a rename (`pglite-encfs/src/marker.rs`). */
export const ENCFS_MARKER_TMP = '.di-encfs.tmp';
export const LOST_AND_FOUND = 'lost+found';
/** `DIPGKEY1 ‖ KCV`: an XTS directory (codec 2/3). */
const XTS_MAGIC = 'DIPGKEY1';
/** `DIPGKEY2 ‖ KCV ‖ flags`: an integrity directory (codec 4, #200). */
const AEAD_MAGIC = 'DIPGKEY2';
const XTS_MARKER_LEN = 24;
const AEAD_MARKER_LEN = 25;
const FLAG_CODEC4 = 0b01;
const FLAG_RESERVATION = 0b10;

/** How encfs encrypts a directory's files; `NotEncfs` is a directory without a marker. */
export type EncfsMode = 'XTS' | 'AEAD' | 'NotEncfs';
const ENCFS_MODES: ReadonlySet<string> = new Set(['XTS', 'AEAD', 'NotEncfs']);

/** What a marker file holds, from its magic, length and flags only (design-200 §9.1). */
export type MarkerForm =
  | { form: 'xts'; kcv: string }
  | { form: 'integrity'; kcv: string }
  | { form: 'reserved' }
  | { form: 'corrupt' };

/**
 * A directory's class, as the platform's `storage-mode` step reports it (design-200 §9.1, §9.4):
 * `empty` has no entry besides a real `lost+found` directory; `reserved` holds a reservation and
 * nothing else; `corrupt` is any other marker form, a reservation beside data, or a link or other
 * non-regular entry at a marker name. A corrupt directory has no mode and fails closed.
 */
export type DirectoryClass = 'empty' | 'unencrypted' | 'xts' | 'integrity' | 'reserved' | 'corrupt';
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
  /** Hex of bytes 8..24 of `.di-encfs`, or null when the volume has no keyed marker. */
  encfsKcv: string | null;
  /** The directory's mode; a restore only goes into a target of the same mode. */
  encfsMode: EncfsMode;
  /** The marker is the platform's reservation: an integrity directory encfs has not keyed yet. */
  encfsReservation: boolean;
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

/**
 * Classify `.di-encfs` bytes the way encfs does (`pglite-encfs/src/marker.rs`): exact lengths,
 * the reservation is `DIPGKEY2`, 16 zero bytes and `0x03`, and unknown flag bits, a reservation
 * with a KCV, or any other magic or length are corrupt.
 */
export function markerForm(marker: Uint8Array): MarkerForm {
  const bytes = Buffer.from(marker);
  const magic = bytes.subarray(0, 8).toString('latin1');
  const kcv = bytes.subarray(8, 24).toString('hex');
  if (bytes.byteLength === XTS_MARKER_LEN && magic === XTS_MAGIC) return { form: 'xts', kcv };
  if (bytes.byteLength !== AEAD_MARKER_LEN || magic !== AEAD_MAGIC) return { form: 'corrupt' };
  const flags = bytes[XTS_MARKER_LEN];
  if (flags === FLAG_CODEC4) return { form: 'integrity', kcv };
  if (flags === (FLAG_CODEC4 | FLAG_RESERVATION) && /^0+$/.test(kcv)) return { form: 'reserved' };
  return { form: 'corrupt' };
}

/** Classify a directory from its entries (only the top level counts) and its marker. */
export async function classifyDirectory(
  entries: Pick<TreeEntry, 'path' | 'type'>[],
  readMarker: () => Promise<Uint8Array>,
): Promise<DirectoryClass> {
  const top = entries.filter((entry) => !entry.path.includes('/'));
  const markers = top.filter(
    (entry) => entry.path === ENCFS_MARKER || entry.path === ENCFS_MARKER_TMP,
  );
  if (markers.some((entry) => entry.type !== 'file')) return 'corrupt';
  const data = top.filter(
    (entry) =>
      entry.path !== ENCFS_MARKER && !(entry.path === LOST_AND_FOUND && entry.type === 'directory'),
  );
  if (!top.some((entry) => entry.path === ENCFS_MARKER)) {
    return data.length === 0 ? 'empty' : 'unencrypted';
  }
  const marker = markerForm(await readMarker());
  if (marker.form === 'reserved') return data.length === 0 ? 'reserved' : 'corrupt';
  return marker.form;
}

/** The mode of a class; a corrupt directory has none. */
export function modeOf(found: DirectoryClass): EncfsMode | undefined {
  if (found === 'xts') return 'XTS';
  if (found === 'integrity' || found === 'reserved') return 'AEAD';
  if (found === 'corrupt') return undefined;
  return 'NotEncfs';
}

interface MarkerState {
  found: DirectoryClass;
  kcv: string | null;
}

async function markerState(io: AgentIo, root: string, entries: TreeEntry[]): Promise<MarkerState> {
  let bytes: Uint8Array = new Uint8Array();
  const found = await classifyDirectory(entries, async () => {
    bytes = await io.readFile(`${root}/${ENCFS_MARKER}`);
    return bytes;
  });
  const marker = markerForm(bytes);
  return { found, kcv: 'kcv' in marker ? marker.kcv : null };
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
  const unsupported = entries.filter(
    (entry) => entry.type !== 'file' && entry.type !== 'directory',
  );
  // A link at a marker name is a marker problem first (design-200 §9.4), then a link.
  if (unsupported.some((entry) => entry.path === ENCFS_MARKER || entry.path === ENCFS_MARKER_TMP)) {
    throw new VolumeError('EncfsMarkerInvalid');
  }
  if (unsupported.length > 0) throw new VolumeError('UnsupportedEntry');
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
  let state: MarkerState;
  try {
    before = await readTree(io, source);
    state = await markerState(io, source, [...before.files, ...before.directories]);
    if (state.found === 'corrupt') throw new VolumeError('EncfsMarkerInvalid');
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
    encfsKcv: state.kcv,
    encfsMode: modeOf(state.found) as EncfsMode,
    encfsReservation: state.found === 'reserved',
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
    encfsMode: manifest.encfsMode,
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
  if (!ENCFS_MODES.has(String(parsed.encfsMode))) return undefined;
  if (typeof parsed.encfsReservation !== 'boolean') return undefined;
  // A keyed directory has a KCV; a reservation (AEAD only) and an unmarked directory have none.
  const keyed = parsed.encfsMode !== 'NotEncfs' && !parsed.encfsReservation;
  if (keyed !== (parsed.encfsKcv !== null)) return undefined;
  if (parsed.encfsReservation && parsed.encfsMode !== 'AEAD') return undefined;
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
  // The extracted marker must have the recorded mode, not only the recorded KCV.
  const state = await markerState(io, root, [...tree.files, ...tree.directories]);
  if (state.found === 'corrupt') return 'EncfsMarkerInvalid';
  if (modeOf(state.found) !== manifest.encfsMode) return 'ModeMismatch';
  if ((state.found === 'reserved') !== manifest.encfsReservation) return 'ModeMismatch';
  if (state.kcv !== manifest.encfsKcv) return 'KcvMismatch';
  return undefined;
}

/** Every restored entry gets the owner the manifest recorded; older manifests mean the host uid. */
async function restoreOwners(io: AgentIo, target: string, manifest: VolumeManifest) {
  await io.chown(target, HOST_UID, HOST_UID);
  for (const entry of [...manifest.directories, ...manifest.files]) {
    await io.chown(`${target}/${entry.path}`, entry.uid ?? HOST_UID, entry.gid ?? HOST_UID);
  }
}

/** Move entries one at a time, in order: a failure stops the rest. */
function moveAll(io: AgentIo, names: string[], from: string, to: string): Promise<void> {
  return names.reduce(
    (moved, name) => moved.then(() => io.rename(`${from}/${name}`, `${to}/${name}`)),
    Promise.resolve(),
  );
}

export async function restoreVolume(io: AgentIo, request: AgentRequest): Promise<number> {
  const fail = (
    error: string,
    extra: { replacedPath?: string; restoringPath?: string; detail?: string } = {},
  ) => finish(io, request.terminationLog, { ok: false, error, ...extra });
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
  // The target's mode decides what it may receive. An empty target, or one holding only the
  // platform's reservation, takes a restore without `force`; the reservation is not a key.
  let prior: MarkerState = { found: 'empty', kcv: null };
  if (existing.length > 0) {
    try {
      prior = await markerState(io, target, await io.scan(target, true));
    } catch {
      return fail('TargetUnreadable');
    }
  }
  if (prior.found === 'corrupt') return fail('EncfsMarkerInvalid');
  const vacant = prior.found === 'empty' || prior.found === 'reserved';
  if (!vacant && !request.force) return fail('TargetNotEmpty');
  const meta = `${request.workdir}/${MANIFEST}`;
  const sums = `${request.workdir}/${SUMS}`;
  if ((await get(io, request, MANIFEST, meta)).code !== 0) return fail('DownloadFailed');
  if ((await get(io, request, SUMS, sums)).code !== 0) return fail('DownloadFailed');
  const manifest = parseManifest(Buffer.from(await io.readFile(meta)).toString('utf8'));
  if (!manifest) return fail('ManifestInvalid');
  if (Buffer.from(await io.readFile(sums)).toString('utf8') !== sumsText(manifest.files)) {
    return fail('ManifestInvalid');
  }
  // A vacant target keeps its `lost+found`, unless the backup brings one: then the target's goes
  // aside like forced data, so the move never collides with it part-way.
  const bringsLostFound = manifest.directories.some((entry) => entry.path === LOST_AND_FOUND);
  const occupied = vacant
    ? existing.filter((name) => name === LOST_AND_FOUND && bringsLostFound)
    : existing;
  // A restore never changes a directory's mode: encfs fixes it when the directory is created.
  const targetMode = modeOf(prior.found) as EncfsMode;
  if (prior.found !== 'empty' && targetMode !== manifest.encfsMode) {
    return fail('ModeMismatch', {
      detail: `backup is ${manifest.encfsMode}, target is ${targetMode}; a restore keeps the mode`,
    });
  }
  if (request.expectedKcv && manifest.encfsKcv !== request.expectedKcv) return fail('KcvMismatch');
  // Replacing data encrypted under one key with data under another would leave the workload
  // unable to open it. Only an explicit expectedKcv may change the key.
  if (prior.kcv && prior.kcv !== manifest.encfsKcv && !request.expectedKcv) {
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
    if (occupied.length > 0) {
      replacedPath = `${root}/${key}.replaced-${stamp}`;
      await io.mkdir(replacedPath);
      await moveAll(io, occupied, target, replacedPath);
    }
    await moveAll(io, await io.list(staging), staging, target);
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
    encfsMode: manifest.encfsMode,
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
