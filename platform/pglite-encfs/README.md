# pglite-encfs: encryption at rest for the pglite component

`pglite-encfs` is a WebAssembly component. It encrypts the PostgreSQL data directory of [`pglite-component`](../pglite-component) without changing the engine.

- It sits between pglite and the host and re-exports the WASI 0.2.9 interfaces pglite imports (`wasi:filesystem`, `wasi:io`, the `wasi:cli` stdio and environment interfaces, and `wasi:clocks/monotonic-clock`).
- Every regular file under a preopened directory is stored as AES-256-XTS ciphertext behind a 4 KiB header.
- Directory names, symlinks and metadata pass through unchanged. The one exception is the root's marker, which pglite can never reach (see "Atomic marker" under [Fail closed](#fail-closed)).

```
guest.wasm ──di-framework:pglite/database──▶ pglite.wasm ──wasi:filesystem, io, cli…──▶ pglite-encfs.wasm ──▶ host (wash / wasmtime)
```

Published as `ghcr.io/di-framework/pglite-encfs@sha256:15e064d1e9eb0941ca1dff4c83943c470c24fef5451c6593c7319b3bb6c5744f`. The publish workflow rewrites this pin after every publish. The moving tags are the commit SHA and the WIT package version (`0.1.0`); only the digest is immutable.

Design and spike: #199. The integrity (AEAD) mode is a follow-up: #200.

## Composition

Plug encfs into the pglite provider first, then plug the result into the guest exactly as before:

```sh
wac plug --plug pglite-encfs.wasm di-framework-pglite.wasm -o pglite-enc.wasm   # encrypted provider
wac plug --plug pglite-enc.wasm guest.wasm -o guest.composed.wasm               # unchanged CLI step
```

Or use `make compose PGLITE=path/to/di-framework-pglite.wasm OUT=pglite-enc.wasm`.

- **Interfaces stay the same.** `pglite-enc.wasm` exports the same `di-framework:pglite/*` interfaces as pglite. It imports only WASI interfaces that pglite already imports.
- **The guest is unaffected.** The guest's own WASI imports still go straight to the host; only pglite sees the encrypted view.
- **Detecting an encrypted provider.** The composed component carries a `di-framework:pglite-encfs` custom section: `format=1 codec=aes-256-xts write-codec=N`. `N` is the codec the build creates new files with (2 by default, 3 for the opt-in `write-codec-3` build). A deploy step can use it to tell that a provider is encrypted, and `write-codec=3` that it creates codec-3 files, which builds before #206 cannot read. **The marker is advisory until a consumer parses it**: identity-server's build only checks that the section exists (follow-up below). See [Codecs and migration](#codecs-and-migration).
- **Exact names.** `wac plug` matches import names exactly, so encfs is built for pglite's exact WASI version (`@0.2.9`; random is `@0.2.3`). `make smoke` fails if a pglite build drifts from it. When pglite moves to a new WASI version, update `wit/world.wit` from `wasm-tools component wit` of the new pglite and republish.

## Keys

| variable | meaning |
|---|---|
| `DI_PGLITE_KEY` | Required. 32 random bytes, base64 (standard or URL-safe, padding optional). |
| `DI_PGLITE_KEY_PREVIOUS` | Only during a rotation: the key being replaced. |

Generate a key with `openssl rand -base64 32`, or with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

- **How the key is read.** The key reaches the component through `wasi:cli/environment`. On the platform that means the workload's app-owned `<workload>-secrets` Secret via `localResources.environment.secretFrom`; `<workload>-control` holds only the CLI's control credentials. encfs reads it once, derives its keys, and wipes the decoded bytes and the environment strings.
- **What the engine sees.** encfs's own `wasi:cli/environment` export filters out both variables, so the PostgreSQL engine never sees them. The guest's environment comes from the host directly, so the guest can see them, just as it sees its other secrets.
- **What is stored.** Neither the key nor anything that decrypts data is written to the volume. Headers and the root marker hold a 16-byte key-check value (KCV), a one-way HKDF output that identifies the key.

### Fail closed

Before pglite can touch a preopen, encfs checks the `.di-encfs` marker at its root. The marker holds a magic value and the KCV, and is hidden from directory listings.

| state | result |
|---|---|
| marker matches `DI_PGLITE_KEY` | start |
| empty directory (`lost+found` ignored) | write the marker, start |
| empty or short marker, no other data (a crash during the first start) | write the marker again, start |
| marker matches `DI_PGLITE_KEY_PREVIOUS` | rotate (below), start |
| marker matches neither key | **refused** (`access`) |
| `DI_PGLITE_KEY` missing or invalid | **refused** (`access`) |
| data but no marker: an unencrypted directory | **refused** (`io`) |

- **A refusal changes nothing.** It locks the whole preopen before anything is written. pglite surfaces it as `open-failed(...)`, and encfs prints the reason to stderr (for example, `pglite-encfs: the data directory was encrypted with a different key ...`).
- **No partial encryption.** encfs never encrypts an existing plaintext directory in place, and never accepts a mix of plaintext and encrypted files.
- **Per-file checks.** A file wrapped under another key fails with `access`. A file without a header, or a header that does not authenticate, fails with `io`. A plaintext file dropped into an encrypted directory is neither read nor rewritten, with one exception: a file of at most 4096 bytes whose first 152 bytes are all zero is indistinguishable from a file whose creation was cut short by a crash. It is treated as fresh: it reads as empty, and its first write replaces its contents with a new header. Every other plaintext file, of any size, is refused.
- **Stubs without a header.** A file of at most 4096 bytes whose first 152 bytes are neither all zero nor a complete header is refused with `io`. Besides a small plaintext file, a failed header write can leave one: a partial header after `ENOSPC`, or garbage after a crash on ext4 with `data=writeback`, which can make a file's size durable before its contents. Data is only written after a synced header, so such a file holds no encrypted data. encfs logs `<path>: no encryption header; refusing. The file is at most 4096 bytes ...` for each one, with the path relative to the data directory root. Unless you placed a plaintext file there, it is safe to truncate the file to 0 bytes on the volume (`truncate -s 0 <data-dir>/<path>`). Never truncate the `.di-encfs` marker. The next write gives the file a new header. A stub in the data directory also stops a rotation until it is truncated.
- **Atomic marker.** The marker is written to `.di-encfs.tmp`, synced and renamed into place. pglite can reach neither name, from any directory descriptor and through any path. Whenever a path ends in one of the two names, the host resolves the directory that would hold it, following `.`, `..` and every symlink in the path as the operation itself would, and encfs compares that directory's identity (the host's `metadata-hash`, from device and inode) with the root's. If it is the root, or cannot be identified, the operation fails with `access`. This covers open and create, stat, rename (either side), unlink, readlink, and creating or removing a directory. A directory descriptor that names the root again (`.`, `pglite/..`, or a symlink to it anywhere in the path) hides both names from its listing. A symlink whose target contains either name is never created. Other symlinks work as before.

### Key custody: losing the key means losing the data

There is no recovery path. Without `DI_PGLITE_KEY` the database cannot be read by anyone, including you.

- **Back up the key separately from the volume backups.** A backup that holds both the volume and the key defeats the encryption, and a volume backup without the key is useless.
  - Keep the key in a password manager or vault, with any local values file at mode `0600`. Alternatively, seal it to an offline KMS key.
- **Record the key's KCV** (safe to store) next to each backup, so you can tell which key opens which backup. These are bytes 8..24 of `.di-encfs`, or bytes 32..48 of any file header.
- **Never let tooling regenerate the key for an existing volume.** A new key does not decrypt the old data. Deleting the Secret makes the database fail closed: an outage, not data loss, as long as the key still exists somewhere.

### Rotation

A rotation replaces the key-encryption key. Each file's data key is re-wrapped; data is not re-encrypted.

1. Set the new key in `DI_PGLITE_KEY` and the old one in `DI_PGLITE_KEY_PREVIOUS`, then restart the workload.
2. At start, encfs walks the preopen and re-wraps every file header under the new key, syncing each file. It then flips the root marker. The log says `pglite-encfs: key rotation complete: re-wrapped N file keys; ... DI_PGLITE_KEY_PREVIOUS can be removed`.
3. After that line, remove `DI_PGLITE_KEY_PREVIOUS`. From then on the old key alone is refused. If the line instead says that entries in `lost+found` may still be wrapped under the previous key, keep a copy of that key until those entries are recovered or deleted (below).

Notes:
- **Crashes are safe.** A crash mid-sweep leaves the marker on the old key, and the next start with both keys resumes. Headers already under the new key are skipped.
- **`lost+found` is swept best-effort.** fsck reconnects orphaned inodes into `lost+found` at the root as `#<inode>`. On an encrypted volume those can be encfs files whose directory entry was lost, next to fragments that are not encfs files at all. The sweep re-wraps every file there whose header opens under the previous key and leaves everything else as it was. Nothing there aborts a rotation. Each entry it leaves is logged (`lost+found/#123: left as it was during key rotation: ...`), up to 50 lines; beyond that, one line gives how many more were left. The completion line always counts all of them. An entry may still be under the previous key if its header is under that key but does not authenticate, or is a format this build does not read, or if the entry could not be read (for example a `lost+found` owned by root with mode `0700`). If any entry might be, the completion line does not say the previous key can be removed. It says how many such entries there are instead.
- **Keep both variables set until step 2 has logged success.** Starting with only the old key after a partial sweep fails closed on the re-wrapped files.
- **A rotation does not lock out a compromised old key.** The data keys do not change, so someone who holds the old key and a volume image from before the rotation can still read data written later. After a suspected key compromise, copy the data into a fresh directory under a new key instead. An offline migration tool is tracked in #199 and has not been built yet.

## Format

```
[header: 4096 bytes][unit 0: 4096][unit 1: 4096]...[last unit: 1..4096]
```

| bytes | header field |
|---|---|
| 0..8 | magic `DIPGENC1` |
| 8 | format version (1) |
| 9 | codec: 2 = AES-256-XTS with ciphertext stealing (v1), 3 = AES-256-XTS with a length-independent tail (#206) |
| 16..32 | random file id |
| 32..48 | KCV of the wrapping key |
| 48..72 | XChaCha20 nonce |
| 72..136 | the file's random 64-byte DEK, wrapped (XChaCha20-Poly1305, AAD = bytes 0..32) |
| 136..152 | Poly1305 tag |

Keys:
- `HKDF-SHA256(salt = "di-framework/encfs/v1", master)` derives the KEK (`info = "kek"`) and the KCV (`info = "key-check-value"`).
- The DEK is random per file, not derived from the path. Renames keep working, and a copied file is re-encrypted under a fresh key.

Header lifecycle:
- An empty file has no header.
- The header is written with the first byte of data and synced before any data follows it. It is never removed: truncating to zero keeps it, so a file id never changes while its inode exists.
- A file no longer than a header (4096 bytes) whose first 152 bytes are all zero holds no data: a crash made its size durable before its header. Only those 152 bytes are checked. It is treated as empty and sealed with a new header on its first write, and rotation skips it. A zero header on a longer file is refused, and so are non-zero bytes that are not a header, at any size (see the stubs under [Fail closed](#fail-closed)).

Data units:
- AES-256-XTS over 4 KiB units with tweak = unit index. The scheme is length-preserving: logical size = physical size − 4096.
- Complete 16-byte blocks are plain XTS under both codecs. A unit's final partial block (`len % 16` bytes, only in the last unit of a file) depends on the codec:
  - **Codec 3** (new files): no ciphertext stealing. The partial bytes are XORed with `AES-256(key2, unit as LE u64 ‖ block index as LE u32 ‖ "TAIL")`, where key2 is the XTS tweak key. The keystream does not depend on the unit's length; the `"TAIL"` constant keeps its inputs apart from XTS tweak inputs (byte 15 zero) and codec-2 masks (byte 15 = `0x81..0x8F`).
  - **Codec 2** (files created by v1): a final partial unit of 16 bytes or more uses ciphertext stealing, and a unit shorter than 16 bytes is XORed with `AES-256(key2, tweak ^ (0x80 | len) << 120)`.
- **Partial-block leak.** The partial block is a deterministic XOR under both codecs (for codec 2, only in units shorter than 16 bytes), so two versions of the same tail block leak the XOR of their plaintexts. Codec 3 extends this from sub-16-byte files to the partial tail block of any file, at most 15 bytes per file, and never in relation or WAL files, which are whole 8 KiB pages. Under XTS, two versions of a complete block already reveal whether the block changed. For codec 3 this has consequences beyond the XOR:
  - **Plaintext recovery.** Known plaintext of any one version at a (file, unit, block) position reveals the keystream, and with it every other version at that position, outright. One cheap way to get known plaintext is a zero-filling `set-size` grow to an unaligned length: the encrypted zeros are the keystream in the clear.
  - **The key outlives truncation.** A file's DEK is fixed while its inode exists and survives truncation to zero, so in-place rewrites of the same file reuse the keystream. Files PostgreSQL rewrites through a temporary file and `rename` get a fresh DEK and do not.
  - **Chosen bit flips (malleability).** Anyone who can write the volume can flip chosen plaintext bits in the last at most 15 bytes of any unaligned file, where XTS would randomize the whole 16-byte block. Under codec 2 that applied only to files under 16 bytes. This is bit-precise tampering, on top of the general "no integrity" statement below.
  - **No leak on append-only growth.** Each keystream byte then only ever covers one plaintext byte.
- Logical sizes are capped at 1 TiB, and one write or `set-size` may zero-fill at most 1 GiB past the end of file (`file-too-large` otherwise).

### Crash consistency

- **Write path.** encfs caches nothing. Each logical write becomes one host `pwrite`, after a read-modify-write of a partial first or last unit, and `sync`/`sync-data` pass straight through. PostgreSQL's fsync ordering is therefore preserved.
- **Torn writes, whole blocks.** XTS encrypts each 16-byte block independently and deterministically. A write of whole 16-byte blocks torn at a sector boundary therefore decrypts to old sectors followed by new sectors, which is exactly what PostgreSQL expects from a plain disk. Relation and WAL I/O is always in whole 8 KiB pages.
  - Already-durable WAL records keep identical ciphertext when the WAL tail page is rewritten.
  - `make smoke` checks three power-loss tears; in each, the fsynced commit survives:
    - the last WAL write in flight
    - a rewrite of the WAL page that already holds an fsynced commit
    - a `pg_control` rewrite
  - An AEAD codec failed the last two cases in the spike: a lost commit, and `PANIC` on `pg_control`. A crash-safe AEAD design is the follow-up #200.
- **Unaligned ends.** A shrink rewrites the new tail and then truncates; an append rewrites the old tail with the new bytes. A crash between that write and the size change leaves the old size with the rewritten bytes.
  - **Codec 3: at most 15 bytes, usually none.** Complete blocks never change their ciphertext with the length, and the bytes already in a partial block are a prefix of the same keystream. A shrink or append inside one block, or to or from a multiple of 16, loses nothing. An append that completes a partial block, or a shrink that splits a complete one, re-encrypts that block's durable partial bytes (at most 15) just before the durable end of file. Pinned by `unaligned_resizes_bound_crash_damage` (#206).
  - **Codec 2: up to 31 bytes.** Ciphertext stealing and the sub-block mask make a unit's last full block and partial block depend on its length, so changing the length of a unit that ends mid-block can garble up to 31 bytes just before the durable end of file. Lengths that are multiples of 16 lose nothing. Pinned by `codec_2_files_keep_their_31_byte_bound`.
- **New files.** The header is synced before the first data write, so a crash leaves either a fresh file (re-sealed on the next write) or a valid header. `make smoke` zeroes and shortens the files of a freshly created table after a crash, and WAL redo rebuilds it.

### Codecs and migration

- **One codec per file, for its lifetime.** The codec byte is written with the header and is part of the wrap's AAD, so it cannot change without the key. Writes to a codec-2 file keep encoding it with codec 2, and rotation keeps the codec. Nothing is re-encrypted in place.
- **New files get codec 2 by default; codec 3 is opt-in (two-step rollout).** Every build reads both codecs. Only a build made with the `write-codec-3` cargo feature (`bun scripts/build.ts` variant `writeCodec3`, used by `make smoke` and the unit tests) creates codec-3 files; its custom section says `write-codec=3`. The published artifact is the default build (`write-codec=2`). Because a codec-2 writer never produces a file that v1 cannot read, rolling back to this release, or to v1, stays possible. The follow-up release flips the default once every reader in the fleet can open codec 3. With the opt-in build, new files include the ones PostgreSQL rewrites through a temporary file and `rename` (most small files), so an existing directory moves to codec 3 file by file. Long-lived codec-2 files (relation segments, `pg_control`) stay codec 2; they are written in whole blocks, where both codecs behave the same.
- **No downgrade of a directory a codec-3 build has written.** A build without codec 3 refuses a codec-3 file with `io` (`unsupported header (format 1, codec 3)`). `make smoke` proves this fails loudly: the published v1 build over a mixed codec-2/3 directory, after a clean shutdown and after an abrupt exit, panics at startup (PostgreSQL cannot read `pg_logical/replorigin_checkpoint`, which the first start of a codec-3 build rewrites) before replaying any WAL, so it does not end recovery early and drop commits. The directory is not damaged by that attempt: this build then reads it and returns every commit. Do not rely on this; never start an older build on a directory a `write-codec=3` build has written.

#### Upgrade and rollback runbook

1. **This release (reads codec 2 and 3, writes codec 2).** Deploy it like any release. Take a snapshot or file-level backup of the data directory first anyway. Rolling back to v1 (`sha256:46863e8...`) is safe, because only codec-2 files exist.
2. **Enabling codec 3 (opt-in, or the follow-up release that makes it the default).** First confirm that every build that can open this directory, including the rollback target and any restore or tooling images, is a reader-capable release. Take a snapshot or file-level backup of the data directory before the first start of a `write-codec=3` build.
3. **Rollback after a codec-3 build has written.** The only rollback is to restore the pre-upgrade snapshot (commits since then are lost) or to roll forward to another reader-capable build. Never start an older build on the directory.
4. **Deploy tooling must refuse a layer whose section lacks a reader-capable `write-codec=` value** once a deployment has moved past v1. Until a consumer checks it, the marker is advisory: identity-server only tests that the section is present, so a pin rolled back to `46863e8...` passes its checks.

The WIT package version stays `0.1.0` because the interface did not change; the rollout is gated by the build feature and the marker instead. The follow-up issue that flips the default is tracked from #206.
- A copy into a fresh directory (the planned offline tool, #199) produces an all-codec-3 tree.

## Threat model

**Protects** table data, catalogs, WAL and configuration at rest. Without the key they are unreadable to:
- someone who steals or re-attaches the node disk or PV
- anyone holding a leaked volume snapshot or backup, including object-store copies of the PVC
- a storage administrator reading the volume
- another workload that mounts the PV

**Does not protect against:**
- **A compromised host, wash process or node.** The key sits in the Kubernetes Secret (protected by etcd encryption at rest only if that is enabled), in the wash process environment, and in memory.
- **Anyone who can read the tenant namespace's Secrets** (`get secret`).
- **A compromised guest.** It sees the plaintext through SQL.
- **Live memory, core dumps, or swap.**
- **Tampering.** XTS has no integrity, so modified ciphertext decrypts to garbage instead of failing. Rollback or replay of old ciphertext is also not detected.
- **Swaps and replay.** Headers are not bound to paths: a whole file (header and data) moved to another path decrypts cleanly there, and an older ciphertext block replayed at the same position of the same file decrypts to the older plaintext. Blocks moved to other positions decrypt to garbage. None of this is detected; the header's AAD binds the file id, not the path. The integrity mode (#200) is where this can be addressed.
- **Metadata.** File names (relfilenode numbers, WAL segment names), file counts, sizes, timestamps and access patterns are visible. Between two snapshots, which 16-byte blocks changed is also visible.
- **Availability.** Deleting the key bricks the database by design.

## Performance

These numbers come from the spike (#199): wasmtime 48.0.1, aarch64 macOS, a loaded 16-core machine, so read them as ±20%.

| measurement | plaintext | pglite-encfs (XTS) |
|---|---|---|
| cold start + initdb | 20.7 s | 23.8 s (+15%) |
| 3000 inserts, 10 per transaction (commit = WAL fsync) | 1.58 s | 2.08 s (+32%) |
| 3000 point selects (cached) | 109 ms | 117 ms |
| bulk load 200k rows (48 MB) + `CHECKPOINT` | 1.6–2.1 s | 6.0–6.7 s |
| full scan of 48 MB through the filesystem | ~80 ms | ~950 ms (~50 MB/s) |
| disk, small cluster (1516 files) | 32.9 MB | 40.0 MB (+4 KiB header per file) |

- **Where the cost goes.** AES runs in software inside Wasm, at about 50 MB/s. Each I/O also costs one extra host `stat` to find the logical size.
- **Small OLTP databases.** A small, mostly cached database such as identity-server's mainly pays the initdb cost and a modest commit-path cost.
- **Large databases.** Scan-heavy databases larger than shared buffers pay about 10x on uncached reads.

The component is about 200 KB.

## Build and test

```sh
make tools    # pinned wasm-tools + wac (shared with ../pglite-component)
make unit     # rustfmt, clippy (host + Wasm), host unit tests
make smoke    # needs wasmtime 48 and ../pglite-component/dist (make -C ../pglite-component build),
              # or PGLITE_ENCFS_PGLITE_WASM=/path/to/di-framework-pglite.wasm
```

**Dependencies.** Every crate is pinned with `=`. Apart from `xts-mode`, the crypto crates (`aes`, `chacha20poly1305`, `hkdf`, `sha2`, `zeroize`) are RustCrypto. `xts-mode` is a small single-maintainer crate: before bumping it, re-run `make unit`. The known answers in `src/testdata/xts-kat.txt` must still pass: the full IEEE 1619 vector 10, codec-2 ciphertext-stealing lengths 16–4096 (an independent IEEE 1619 reference on OpenSSL AES-256-ECB), and codec-3 lengths 1–4096 (an independent reference on Node's AES-256-ECB with hand-written tweak doubling and tail keystream). Cross-check any new length class against such a reference first. `src/testdata/codec2/` holds files written by the v1 build, which must keep reading back exactly.

**Toolchain.** Rust is pinned in `rust-toolchain.toml` (1.97.1, the same as pglite-component). The crate builds for `wasm32-unknown-unknown` and is wrapped with `wasm-tools component new`, so std adds no WASI imports of its own. Crates are pinned with `=`.

**Unit tests** (`src/*.rs`) cover:
- the XTS codecs (all 512 bytes of IEEE 1619 vector 10, independent codec-2 and codec-3 known answers, torn-sector behaviour, tiny tails, length independence of codec-3 ciphertext, keystream domain separation)
- codec-2 fixtures from the v1 build: still read, and stay codec 2 when written
- the crash bounds for unaligned resizes and appends (codec 3: none inside a block, at most 15 bytes when completing or splitting one; codec 2: at most 31), and the size caps
- fresh-file classification after a crash during creation, and refusal of plaintext of any size
- the header layout and authentication
- wrong-key detection
- rotation re-wrapping
- size semantics against a plaintext model under random writes and resizes
- key parsing
- the root-marker decision table, including a partial marker after a crash, and marker and root path normalization
- the marker guard over a symlinked tree: a symlink to the root partway through a path or a chain of them is refused, a link to an ordinary directory is not, and an unidentifiable directory fails closed
- the rotation sweep over an in-memory tree: markers skipped, paths in errors relative to the root, recovered encfs files in `lost+found` re-wrapped, and fragments and unreadable entries there left, counted and kept out of the "can be removed" line
- stub classification of short files without a header

**`make smoke`** plugs encfs into the pglite wasm and the pglite smoke consumer (`../pglite-component/tests/smoke-consumer`) and runs everything under wasmtime with no network (the only download is the pinned v1 build for the codec-2 case; set `PGLITE_ENCFS_V1_WASM` to a local copy to skip it):
- **Interface fit.** encfs's exports are exactly pglite's WASI imports, and the composed provider keeps pglite's imports and exports.
- **The pglite suite, encrypted.** initdb and the full smoke suite, restart, abrupt-exit restart, and 200 marker rows plus a checkpoint.
- **Ciphertext on disk.**
  - Every file carries a header under the key's KCV.
  - No row, catalog or config string, and no key material, appears on disk. A plaintext control run shows each of those strings does appear without encryption.
- **Refusals.** A wrong key, a missing key, an invalid key and a legacy plaintext directory are each refused, with the tree byte-identical afterwards. A plaintext file dropped into the encrypted directory is refused and left unchanged.
- **Crashes during setup.** The first start succeeds over an empty marker. After a table is created and committed and the process dies, its new files are zeroed or shortened (size durable, header not); the next start re-seals them and WAL redo restores the row.
- **Torn writes.** The three power-loss cases above.
- **Rotation.** A stub stops it, and the log names the stub by its path from the root. Every header is re-wrapped, including an encfs file copied into `lost+found`. A fragment there is left byte-identical and reported. An interrupted rotation resumes, and the old key is refused afterwards.
- **Root guard.** A probe component (`tests/root-probe`) plugged onto encfs reopens the root as `.`, `./`, `pglite/..`, `pglite/data/../..` and through a symlink to `.`. In every case the listing hides `.di-encfs`, and stat, open, rename and unlink of it fail with `access`. It then links `pglite/root-probe-up` to `..` and `pglite/root-probe-c1` to the root through a second link, and reaches both marker names through them from the root and from `pglite`, also after `.`, `..` and a second hop. Stat, metadata hash, open, create, rename to and from, unlink, readlink, mkdir, rmdir and symlink there all fail with `access`, and the directories reached through the links hide the marker. Symlinks whose targets name a marker are refused. An ordinary link (`pglite/root-probe-ok` to `data`) still lists and reads `PG_VERSION`, and a marker name below it is just absent. The tree is unchanged afterwards and no link is left behind.
- **Codecs.** The default build writes codec 2 only (a fresh directory and one written to after an abrupt exit), and its section says `write-codec=2`. The `write-codec-3` build writes a fresh directory with codec 3 only. A directory initialized by the published v1 build (all codec 2) is read, restarted after an abrupt exit, and written to by the codec-3 build (commits and a new table); afterwards it holds codec-2 and codec-3 files side by side.
- **Rollback.** The published v1 build over that mixed directory, after a clean shutdown and after an abrupt exit (and after a single codec-3 start plus one abrupt commit), must fail with `unsupported header (format 1, codec 3)` and never start. Both new builds then still report every commit (`check-ab A=1 B=1`, `check-fresh N=1`), and the default build adds no codec-3 files.

Keys are generated per run, passed by inherited environment rather than on a command line, and every log is checked for them.

**Publishing.** `.github/workflows/pglite-encfs-publish.yml` builds and tests on every push to `main` that changes this directory. It then publishes `dist/pglite-encfs.wasm` through `pglite-encfs-publisher` (`build-support/`) and opens the pin PR.
