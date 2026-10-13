import { createHash } from 'node:crypto';
import {
  type AgentIo,
  type AgentRequest,
  type ExecResult,
  finish,
  get,
  objectKey,
  put,
  pvcPath,
  rcloneEnv,
  remote,
  safeKey,
  type TreeEntry,
} from './run.ts';

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

export interface VolumeFile {
  path: string;
  size: number;
  mode: number;
  sha256: string;
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
  archive: typeof ARCHIVE;
  files: VolumeFile[];
  directories: { path: string; mode: number }[];
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

function fingerprint(tree: Tree): string {
  return JSON.stringify(
    [...tree.directories, ...tree.files].map((entry) => [
      entry.path,
      entry.type,
      entry.size,
      entry.mtimeMs,
    ]),
  );
}

function destinationMissing(request: AgentRequest): string | undefined {
  if (request.destinationType === 'pvc') return request.pvcMountPath ? undefined : 'MissingClaim';
  return request.bucket ? undefined : 'MissingBucket';
}

function archiveTo(io: AgentIo, request: AgentRequest, source: string): Promise<ExecResult> {
  if (request.destinationType === 'pvc') {
    const target = pvcPath(request, ARCHIVE) as string;
    return io
      .mkdir(target.slice(0, target.lastIndexOf('/')))
      .then(() =>
        io.exec(['tar', '--numeric-owner', '-C', source, '-cf', `${target}.partial`, '.']),
      )
      .then((made) => (made.code === 0 ? io.exec(['mv', '-f', `${target}.partial`, target]) : made))
      .catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error) }));
  }
  // Streamed, so the Job needs no scratch space the size of the volume.
  return io.exec(
    [
      'bash',
      '-c',
      'set -o pipefail; tar --numeric-owner -C "$1" -cf - . | rclone rcat "$2"',
      'volume-backup',
      source,
      remote(request, ARCHIVE),
    ],
    { env: rcloneEnv(request) },
  );
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

export async function backupVolume(io: AgentIo, request: AgentRequest): Promise<number> {
  const fail = (error: string) =>
    finish(io, request.terminationLog, { ok: false, error: error.slice(0, 180) });
  const source = request.sourceDir;
  if (!source) return fail('MissingSource');
  const missing = destinationMissing(request);
  if (missing) return fail(missing);
  if (!safeKey(objectKey(request, ARCHIVE))) return fail('PvcPathInvalid');
  let before: Tree;
  let manifest: VolumeManifest;
  try {
    before = await readTree(io, source);
    const files: VolumeFile[] = [];
    for (const file of before.files) {
      const sha256 = await io.hash(`${source}/${file.path}`);
      files.push({ path: file.path, size: file.size, mode: file.mode, sha256 });
    }
    const marked = before.files.some((file) => file.path === ENCFS_MARKER);
    const encfsKcv = marked ? kcvOf(await io.readFile(`${source}/${ENCFS_MARKER}`)) : null;
    manifest = {
      apiVersion: 'platform.di-framework.dev/v1alpha1',
      kind: 'WorkloadVolumeManifest',
      workloadName: request.workloadName ?? '',
      storageKey: request.storageKey ?? '',
      stamp: request.stamp ?? new Date().toISOString(),
      image: request.sourceImage || null,
      imageDigest: imageDigestOf(request.sourceImage),
      fileCount: files.length,
      directoryCount: before.directories.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      encfsKcv,
      archive: ARCHIVE,
      files,
      directories: before.directories.map((entry) => ({ path: entry.path, mode: entry.mode })),
    };
  } catch (error) {
    return fail(error instanceof VolumeError ? error.code : 'SourceUnreadable');
  }
  const archived = await archiveTo(io, request, source);
  if (archived.code !== 0) {
    await discard(io, request);
    return fail('UploadFailed');
  }
  // The workload was stopped; a volume that changed during the copy means something still writes.
  const after = await readTree(io, source).catch(() => undefined);
  if (!after || fingerprint(after) !== fingerprint(before)) {
    await discard(io, request);
    return fail('SourceChanged');
  }
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
      SHA256.test(file.sha256),
  );
  const directoriesValid = parsed.directories.every(
    (directory) => typeof directory?.path === 'string' && safeKey(directory.path),
  );
  if (!filesValid || !directoriesValid) return undefined;
  if (parsed.encfsKcv !== null && !/^[0-9a-f]{32}$/.test(String(parsed.encfsKcv))) return undefined;
  return parsed as VolumeManifest;
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
    JSON.stringify(entries.map((entry) => entry.path).sort());
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

export async function restoreVolume(io: AgentIo, request: AgentRequest): Promise<number> {
  const fail = (error: string) => finish(io, request.terminationLog, { ok: false, error });
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
  } catch {
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
    return fail('RestoreFailed');
  }
  const owned = await io.exec(['chown', '-R', `${HOST_UID}:${HOST_UID}`, target]);
  if (owned.code !== 0) return fail('OwnershipFailed');
  return finish(io, request.terminationLog, {
    ok: true,
    tool: 'tar',
    format: 'workload-volume',
    fileCount: manifest.fileCount,
    ...(manifest.encfsKcv ? { encfsKcv: manifest.encfsKcv } : {}),
    ...(replacedPath ? { replacedPath: replacedPath.slice(root.length + 1) } : {}),
  });
}
