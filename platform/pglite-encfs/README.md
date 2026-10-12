# pglite-encfs: encryption at rest for the pglite component

`pglite-encfs` is a WebAssembly component. It encrypts the PostgreSQL data directory of [`pglite-component`](../pglite-component) without changing the engine.

- It sits between pglite and the host and re-exports the WASI 0.2.9 interfaces pglite imports (`wasi:filesystem`, `wasi:io`, the `wasi:cli` stdio and environment interfaces, and `wasi:clocks/monotonic-clock`).
- Every regular file under a preopened directory is stored as AES-256-XTS ciphertext behind a 4 KiB header.
- Directory names, symlinks and metadata pass through unchanged.

```
guest.wasm ──di-framework:pglite/database──▶ pglite.wasm ──wasi:filesystem, io, cli…──▶ pglite-encfs.wasm ──▶ host (wash / wasmtime)
```

Published as `ghcr.io/di-framework/pglite-encfs@sha256:46863e8bc92be13104f4be1b489f5500ba008f51f4662f382a211f7a78a5d414`. The publish workflow rewrites this pin after every publish. The moving tags are the commit SHA and the WIT package version (`0.1.0`); only the digest is immutable.

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
- **Detecting an encrypted provider.** The composed component carries a `di-framework:pglite-encfs` custom section (`format=1 codec=aes-256-xts`). A deploy step can use it to tell that a provider is encrypted.
- **Exact names.** `wac plug` matches import names exactly, so encfs is built for pglite's exact WASI version (`@0.2.9`; random is `@0.2.3`). `make smoke` fails if a pglite build drifts from it. When pglite moves to a new WASI version, update `wit/world.wit` from `wasm-tools component wit` of the new pglite and republish.

## Keys

| variable | meaning |
|---|---|
| `DI_PGLITE_KEY` | Required. 32 random bytes, base64 (standard or URL-safe, padding optional). |
| `DI_PGLITE_KEY_PREVIOUS` | Only during a rotation: the key being replaced. |

Generate a key with `openssl rand -base64 32`, or with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

- **How the key is read.** The key reaches the component through `wasi:cli/environment`. On the platform that means the workload's `<workload>-control` Secret via `localResources.environment.secretFrom`. encfs reads it once, derives its keys, and wipes the decoded bytes and the environment strings.
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
- **Per-file checks.** A file wrapped under another key fails with `access`. A file without a header, or a header that does not authenticate, fails with `io`. That includes a plaintext file of any size dropped into an encrypted directory: it is neither read nor rewritten.
- **Atomic marker.** The marker is written to `.di-encfs.tmp`, synced and renamed into place. pglite can reach neither name; paths are normalized (`.`, `..`, `//`) before the check.

### Key custody: losing the key means losing the data

There is no recovery path. Without `DI_PGLITE_KEY` the database cannot be read by anyone, including you.

- **Back up the key separately from the volume backups.** A backup that holds both the volume and the key defeats the encryption, and a volume backup without the key is useless.
  - Keep the key in a password manager or vault, with any local values file at mode `0600`. Alternatively, seal it to an offline KMS key.
- **Record the key's KCV** (safe to store) next to each backup, so you can tell which key opens which backup. These are bytes 8..24 of `.di-encfs`, or bytes 32..48 of any file header.
- **Never let tooling regenerate the key for an existing volume.** A new key does not decrypt the old data. Deleting the Secret makes the database fail closed: an outage, not data loss, as long as the key still exists somewhere.

### Rotation

A rotation replaces the key-encryption key. Each file's data key is re-wrapped; data is not re-encrypted.

1. Set the new key in `DI_PGLITE_KEY` and the old one in `DI_PGLITE_KEY_PREVIOUS`, then restart the workload.
2. At start, encfs walks the preopen and re-wraps every file header under the new key, syncing each file. It then flips the root marker. The log says `pglite-encfs: key rotation complete: re-wrapped N file keys`.
3. After that line, remove `DI_PGLITE_KEY_PREVIOUS`. From then on the old key alone is refused.

Notes:
- **Crashes are safe.** A crash mid-sweep leaves the marker on the old key, and the next start with both keys resumes. Headers already under the new key are skipped.
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
| 9 | codec (2 = AES-256-XTS) |
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
- A file no longer than a header whose start is all zero (a crash made its size durable before its header) holds no data. It is treated as empty and sealed with a new header on its first write, and rotation skips it. A zero header on a longer file, or non-zero bytes that are not a header, are refused.

Data units:
- AES-256-XTS over 4 KiB units with tweak = unit index. The scheme is length-preserving: logical size = physical size − 4096.
- A final partial unit of 16 bytes or more uses ciphertext stealing.
- A final unit shorter than 16 bytes is XORed with an AES block keyed by the tweak key. This only happens in tiny files such as `PG_VERSION`, and two versions of such a tail with the same length leak their XOR.
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
- **Unaligned ends: up to 31 bytes.** Ciphertext stealing and the sub-block mask make the encryption of a unit's last full block and partial block depend on the unit's length. Changing the length of a unit that ends mid-block (a shrink to, or an append at, an offset that is not a multiple of 16) re-encrypts those durable bytes. A crash between that rewrite and the size change can garble up to 31 bytes just before the durable end of file. Lengths that are multiples of 16 lose nothing. The bound is pinned by `unaligned_resizes_bound_crash_damage`; a length-independent tail encoding is tracked in #206.
- **New files.** The header is synced before the first data write, so a crash leaves either a fresh file (re-sealed on the next write) or a valid header. `make smoke` zeroes and shortens the files of a freshly created table after a crash, and WAL redo rebuilds it.

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

**Dependencies.** Every crate is pinned with `=`. Apart from `xts-mode`, the crypto crates (`aes`, `chacha20poly1305`, `hkdf`, `sha2`, `zeroize`) are RustCrypto. `xts-mode` is a small single-maintainer crate: before bumping it, re-run `make unit`. The known answers in `src/testdata/xts-kat.txt` (the full IEEE 1619 vector 10 and ciphertext-stealing lengths 16–4096, generated by an independent IEEE 1619 reference on OpenSSL AES-256-ECB) must still pass, and any new length class should be cross-checked against that reference first.

**Toolchain.** Rust is pinned in `rust-toolchain.toml` (1.97.1, the same as pglite-component). The crate builds for `wasm32-unknown-unknown` and is wrapped with `wasm-tools component new`, so std adds no WASI imports of its own. Crates are pinned with `=`.

**Unit tests** (`src/*.rs`) cover:
- the XTS codec (all 512 bytes of IEEE 1619 vector 10, independent ciphertext-stealing known answers, torn-sector behaviour, tiny tails)
- the crash bound for unaligned resizes and appends, and the size caps
- fresh-file classification after a crash during creation, and refusal of plaintext of any size
- the header layout and authentication
- wrong-key detection
- rotation re-wrapping
- size semantics against a plaintext model under random writes and resizes
- key parsing
- the root-marker decision table, including a partial marker after a crash, and marker path normalization

**`make smoke`** plugs encfs into the pglite wasm and the pglite smoke consumer (`../pglite-component/tests/smoke-consumer`) and runs everything under wasmtime with no network:
- **Interface fit.** encfs's exports are exactly pglite's WASI imports, and the composed provider keeps pglite's imports and exports.
- **The pglite suite, encrypted.** initdb and the full smoke suite, restart, abrupt-exit restart, and 200 marker rows plus a checkpoint.
- **Ciphertext on disk.**
  - Every file carries a header under the key's KCV.
  - No row, catalog or config string, and no key material, appears on disk. A plaintext control run shows each of those strings does appear without encryption.
- **Refusals.** A wrong key, a missing key, an invalid key and a legacy plaintext directory are each refused, with the tree byte-identical afterwards. A plaintext file dropped into the encrypted directory is refused and left unchanged.
- **Crashes during setup.** The first start succeeds over an empty marker. After a table is created and committed and the process dies, its new files are zeroed or shortened (size durable, header not); the next start re-seals them and WAL redo restores the row.
- **Torn writes.** The three power-loss cases above.
- **Rotation.** Every header is re-wrapped, an interrupted rotation resumes, and the old key is refused afterwards.

Keys are generated per run, passed by inherited environment rather than on a command line, and every log is checked for them.

**Publishing.** `.github/workflows/pglite-encfs-publish.yml` builds and tests on every push to `main` that changes this directory. It then publishes `dist/pglite-encfs.wasm` through `pglite-encfs-publisher` (`build-support/`) and opens the pin PR.
