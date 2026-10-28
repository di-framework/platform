# Design: crash-safe AEAD integrity mode with two-slot units (#200)

| | |
|---|---|
| Issue | #200 (follow-up to #199, refs #138) |
| Roadmap | v0.1 #499, epic E4 #497, lane T08, milestone `#200:design` |
| Status | **Design, revised after review on PR #530.** Owner decisions of 2026-10-28 and the engineering answers are recorded in section 13. No code changes. Implementation waits for this note to merge. |
| Related | #206 (codec 3, absorbs #244; its default flip waits on gate G04 = identity-server#71) |
| Crate | `platform/pglite-encfs`; the Tenant setting (9.1) also touches `platform/platform/src/tenancy` |

All `file:line` references are relative to `platform/pglite-encfs/` unless they start with `platform/platform/`. They were checked against `origin/main` `981fed0`; `platform/pglite-encfs` has not changed since `73cfb85`, which the first version of this note cited.

## 1. Summary

This note specifies **codec 4**, an integrity mode for whole data directories:

- Each logical 8 KiB unit gets **two physical slots**. Each slot holds `generation ‖ length ‖ nonce ‖ tag ‖ ciphertext`, sealed with XChaCha20-Poly1305 under a per-file key.
- A read returns the **newest slot that authenticates**.
- A write never touches the slot that holds the unit's last durable version. A torn write can then only destroy the version being written, so **every unit write is atomic**, and fsynced data survives any torn write.
- On a cold cache the writer authenticates the pair before it picks a target, so a torn slot that claims a newer generation can never steer a write onto the durable slot (6.3, C13).
- A random 192-bit nonce per slot write keeps nonces unique across crashes and retries.
- Each file carries an authenticated, lazily updated **durable-size watermark** (5.6). A unit below it that has no valid slot was erased, and the read fails with `io`. A unit above it may legitimately have no valid slot after an ordinary crash, and it reads as zeros, as an unsynced plaintext extension does.

Codec 4 is a new codec id in the existing header format. It does not change codecs 2 and 3, the #206 rollout, or the G04 flip. A directory is either all XTS (codec 2/3) or all codec 4, and every file in an integrity directory uses two slots (O1). An integrity directory carries a new root marker, so older builds refuse the whole directory before they touch anything. Integrity is switched on by a Tenant setting that the platform renders into the workload, and only when a directory is initialised empty (O3). Existing directories move to codec 4 only through `pg_dump` and restore into a freshly initialised directory (O4).

## 2. The current on-disk format

### 2.1 Layout

- **Physical file.** `[header: 4096][unit 0][unit 1]...`, each unit 4096 bytes of ciphertext except a shorter last one (`src/file.rs:3-5`, `src/codec.rs:41`, `src/header.rs:38-39`). The layout is length-preserving: `logical size = physical size - 4096` (`src/file.rs:77-81`).
- **Header.** 152 used bytes in a 4 KiB block: magic `DIPGENC1`, format version 1, codec byte, random file id, KCV, and the random 64-byte DEK wrapped with XChaCha20-Poly1305. The AAD is bytes 0..32, so the codec byte is authenticated (`src/header.rs:7-24`, `src/header.rs:203-214`). The header is written once as a full 4 KiB block, zero after byte 152, and synced before any data follows it (`src/component.rs:341-364`). `Header::parse` inspects only the first 152 bytes (`src/header.rs:141-154`). Rotation rewrites only the 152 used bytes (`src/component.rs:590-593`, `src/header.rs:26-29`, `src/header.rs:189-201`).
- **Codec ids.** 2 is XTS with ciphertext stealing (v1). 3 is XTS with a length-independent tail keystream (#206). Codec 1 was the AEAD prototype from the #199 spike and is rejected (`src/codec.rs:53-87`, `src/header.rs:19-24`). Unknown codecs fail `Header::parse` as `Unsupported` (`src/header.rs:149-152`). A test pins that 1 and 4 are refused today (`src/header.rs:282-290`, `src/codec.rs:235-237`).
- **New files.** `Codec::NEW_FILES` is codec 2, or codec 3 with the cargo feature `write-codec-3` (`src/codec.rs:62-69`, `Cargo.toml:33-38`). The composed component's custom section advertises it as `write-codec=N` (`src/component.rs:64-75`, README "Composition").
- **Size from `stat`.** The guest's `stat` and `stat-at` derive a regular file's size from the host size alone, without opening it (`src/component.rs:166-181`, `src/component.rs:1096-1106`). Each read and write also stats the host file to find the logical size (`src/file.rs:99-101`, `src/component.rs:247-249`).

### 2.2 Write path

- Each logical write becomes **one** host `pwrite`, after a read-modify-write of a partially covered first or last unit (`src/file.rs:168-209`). Writes that cover whole units skip the read (`src/file.rs:195-196`, test `src/file.rs:389-403`).
- A write past the end zero-fills the gap with encrypted zeros, in chunks of `FILL_CHUNK` = 1 MiB (`src/file.rs:41-43`, `src/file.rs:118-134`).
- `set_size` shrink: rewrite the new tail unit, then truncate (`src/file.rs:136-151`).
- Nothing is cached. `sync` and `sync-data` pass straight through (`src/file.rs:7-10`, `src/component.rs:1041-1043`, `src/component.rs:1087-1089`).

### 2.3 Crash-consistency properties and gaps

What holds today:

- **Torn whole-block writes behave like plaintext.** XTS encrypts each 16-byte block independently and deterministically. A write torn at any sector boundary therefore decrypts to old sectors followed by new ones (`src/codec.rs:6-10`, test `src/codec.rs:408-428`). Durable WAL records keep identical ciphertext when the WAL tail page is rewritten (test `src/codec.rs:430-442`).
- `make smoke` passes the three power-loss tears from the spike: the last WAL write, the rewrite of the WAL page that holds an fsynced commit, and a `pg_control` rewrite (`scripts/smoke.ts:627-660`, tear model `scripts/lib/tear.ts:1-8`).

The gaps this note addresses:

1. **No integrity.** XTS does not detect modification. Changed ciphertext decrypts to garbage, and old ciphertext replayed at the same position decrypts to the old plaintext (`src/codec.rs:32`, README "Threat model").
2. **Malleable tails.** Under codec 3 the last at most 15 bytes of an unaligned file are a deterministic XOR, so anyone who can write the volume can flip chosen plaintext bits there (README "Data units", partial-block leak).
3. **Tail garble on unaligned resizes (#206).** Under codec 2, ciphertext stealing and the sub-block mask make a unit's last full and partial block depend on its length. A crash between the tail rewrite and the size change garbles **up to 31 durable bytes** (`src/codec.rs:25-30`, `src/file.rs:24-27`). Example: `set_size(4001)` on a 4096-byte file garbles bytes 3984..=4000 (`src/file.rs:641-663`). Codec 3 bounds this to **at most 15 bytes**, and to none inside a block (`src/file.rs:16-23`, `src/file.rs:568-612`). The bound is not zero because the shrink and append protocols are two non-atomic steps (`src/file.rs:143-149`). Only codec 3's default flip (#206, after G04) stops new files from getting the 31-byte bound.
4. **A naive AEAD codec is worse than plaintext under tears.** The spike's single-slot AEAD (codec 1) turned any torn unit into an unreadable one. It lost an fsynced commit when the WAL page holding it was torn, and PostgreSQL could not start (`PANIC ... global/pg_control: I/O error`) after a torn `pg_control` rewrite (#200, README "Crash consistency"). PostgreSQL rewrites the WAL tail page in place. It relies on durable sectors coming back unchanged after a tear, and on `pg_control` fitting in one sector.

## 3. Goals and non-goals

### Goals

- **G1 Integrity.** Any modification of a unit's ciphertext, slot metadata, the watermark or the header is detected. A read either fails with `io` or returns a version that encfs itself wrote for that file, unit and slot. Erasing a unit (zeroing or garbling both slots) is detected below the file's durable-size watermark (5.6). See the non-goals for rollback and for the window above the watermark.
- **G2 Durability.** Data covered by a completed `sync` or `sync-data` survives any torn or reordered write that follows. The torn-write matrix of `make smoke` passes, including the two cases the spike's codec failed.
- **G3 Atomic units.** After a crash, every unit reads as exactly one version that was written to it, never a mix, or, if it was first written after the last watermark advance and no slot of it reached the disk intact, as zeros (5.3, C14). This is stronger than plaintext, which tears at sector granularity.
- **G4 No tail garble.** Unaligned appends and shrinks never garble durable bytes, which removes the #206 problem class for codec-4 files.
- **G5 Nonce safety.** No (key, nonce) pair is ever used twice, including after a crash and a retry of the same write.
- **G6 Fail closed on downgrade.** A build that cannot read codec 4 refuses an integrity directory before it writes anything.
- **G7 No regressions.** Codecs 2 and 3, their fixtures, the #206 rollout and the G04 flip are unchanged.
- **G8 No `io` from a crash.** On a disk that saw only crashes (A1–A4), no read and no size computation fails integrity checks. This is the regression the spike hit (12.2).

### Non-goals

- **Rollback and replay protection.** An attacker who saved an older valid slot, an older valid watermark record, or a whole older file is not detected. That needs a Merkle root anchored outside the volume, which gets its own issue (Q14). Falling back to an older slot looks the same as recovering from a torn write; this is by design. Replaying an older watermark record lowers the watermark, which narrows erasure detection to the older durable size; that is rollback too.
- **Truncation.** Pairs past the end of the host file are absent, and a file that ends early reads as a shorter file, whatever the watermark says (5.3). A truncate by a volume writer is not detected.
- **Erasure above the watermark.** A unit first written since the last watermark advance is protected against crashes only. Erasing it is indistinguishable from a crash during its unsynced extension and reads as zeros. The window is one sync interval of the file plus the lazy watermark write (5.6).
- **Binding files to paths.** A whole file moved to another path still opens there (README "Threat model"). Codec 4 binds slots to the file id, not the path.
- **Converting XTS directories in place.** Codec 2/3 files are never re-encrypted in place (README "Codecs and migration"), and a directory never mixes XTS and codec-4 files (O4).
- **Hiding metadata** (names, sizes, access patterns).
- **Changing the default** for any deployment. Integrity is chosen per Tenant and applies only to directories initialised after it is set (O3).
- **Cross-unit atomicity.** A write that spans units is atomic per unit, not as a whole, as with plaintext pages.

## 4. Assumptions

- **A1 Atomic write units.** After a power loss, each aligned atomic write unit of the storage stack that an in-flight write touches holds either its old or its new contents. The unit is the device's atomic write size or the page-cache writeback granularity, whichever is larger: 512 bytes on some devices, 4 KiB on 4Kn devices and for Linux page-cache writeback. A write that covers only part of a unit rewrites the whole unit, with the uncovered bytes unchanged. This is the model `scripts/lib/tear.ts:1-8` uses at 512 bytes, and the one PostgreSQL relies on for `pg_control`. Section 7 ("Shared atomic units") shows why codec 4 needs nothing finer.
- **A2 Tears stay inside the touched units.** Atomic units that no in-flight write touches keep their contents. Bytes of a touched unit that the write does not cover are, by A1, either their old value or the identical value in the new image.
- **A3 Honest sync.** When host `sync` or `sync-data` returns success, everything written to the file before it is durable. Two host facts bound this:
  - On macOS, `fsync` does not flush the device cache without `F_FULLFSYNC`. The platform runs on Linux; a macOS development host does not meet A3, and its crash results prove nothing.
  - On Linux, after writeback fails with `EIO`, a later `fsync` can return success for pages that were never written. The design relies on PostgreSQL treating an fsync failure as fatal (`data_sync_retry = off`, the default): it PANICs and recovers from WAL. encfs adds its own fail-stop: after a host `sync` or `sync-data` of a file fails, every later write to that file fails with `io` until the instance restarts (6.6).
- **A4 Single writer.** One encfs instance owns a data directory, the exclusive ownership pglite already requires (`src/component.rs:10-12`). Per-file state may be cached in memory. It is keyed by the file id **and** the host identity of the inode (6.1), because a host-level copy of an encfs file within one volume produces two inodes with the same file id.
- **A5 No ordering between unsynced operations.** The design assumes no order between unsynced writes, extensions or `set_size` calls on the same file, on any filesystem (including ext4 `data=writeback` and delayed allocation). Writeback may persist a later range of an extension before an earlier one, and a size change before or after the data around it. Only a completed sync orders anything (A3). Where the protocol needs an order, it syncs: once per file per instance before its first write (W0), and after every shrink before the next write (6.4).

The first version of this note assumed ordered size updates (old A5). Review showed that this does not exclude interior units without a valid slot after an ordinary crash (C1 of the review), so the assumption is withdrawn. The watermark (5.6) replaces it.

## 5. On-disk format of codec 4

### 5.1 Header and codec id

- **Header:** unchanged: same 152 bytes, format version 1, **codec byte 4** (`src/header.rs:7-17`). The codec byte stays in the wrap's AAD, so a file cannot be relabelled between codecs without the key (`src/header.rs:315-327`).
- **Header block.** The rest of the 4 KiB header block, unused today, holds the two watermark records (5.6) at bytes 2048..2112 and 3072..3136. Both lie in 512-byte sectors that the header's bytes 0..152 do not use. Rotation writes only bytes 0..152 (`src/component.rs:590-593`), so it never touches them.
- **Codec 1 stays retired.** It was the spike's AEAD layout, so reusing it could make leftover spike files parse.
- **DEK:** unchanged: 64 random bytes per file (`src/header.rs:44-45`). Codec 4 derives two 32-byte keys with HKDF-SHA256 (`ikm = DEK`, `salt = "di-framework/encfs/v1"`, the salt the KEK derivation uses, `src/keys.rs:36`, under distinct info strings): `aead_key` with info `"codec4-aead"` for slots, and `wm_key` with info `"codec4-watermark"` for watermark records. The XTS key halves have no meaning in codec 4. HKDF instead of `DEK[..32]` keeps a future Merkle or MAC key (rollback protection) derivable from the same DEK.

### 5.2 Units and slots

- **Unit size 8192** logical bytes, separate from XTS's 4096 (`src/codec.rs:41`). 8 KiB matches PostgreSQL's `BLCKSZ` and `XLOG_BLCKSZ`, so a relation, SLRU or WAL page write is exactly one slot write (Q1).
- **Slot:** a 64-byte slot header followed by an 8192-byte ciphertext area, **8256 bytes** in total. Slots are compact, not padded to sector or page boundaries (Q2, section 7).
- **Pair:** unit `u` owns slot A at `4096 + u × 16512` and slot B at `4096 + u × 16512 + 8256`. A pair is 16512 bytes. The stride is fixed, so the position of every unit is known without reading anything.

| slot bytes | field | notes |
|---|---|---|
| 0..8 | `generation`, u64 LE | 0 = never written; the first version is 1 |
| 8..12 | `len`, u32 LE | logical bytes in this unit, 1..=8192 |
| 12..16 | reserved, zero | authenticated |
| 16..40 | `nonce`, 24 bytes | random per slot write (5.4) |
| 40..56 | `tag`, Poly1305 | over AAD and ciphertext |
| 56..64 | reserved, zero | authenticated |
| 64..64+len | ciphertext | XChaCha20 of the unit's `len` plaintext bytes |
| 64+len..8256 | padding | not written, not authenticated, ignored (Q16) |

- **AAD** = `"DIPGENC4"` ‖ file id (16) ‖ unit index (u64 LE) ‖ slot (u8: 0 = A, 1 = B) ‖ slot bytes 0..16 ‖ slot bytes 56..64. This binds a slot to its file, unit, position, generation and length. Swapping slots, units or files, or changing a length, fails authentication.
- **Tag placement.** The tag sits in the slot header, before the ciphertext. A reader gets the metadata and the ciphertext in one contiguous read, and a write is one contiguous `pwrite` of `64 + len` bytes. A tear that keeps the new header with old ciphertext, or the reverse, fails authentication like any other tear.
- **Physical size.** A slot that reaches past the end of the host file is "absent". A pair whose slot A starts at or past the end is absent as a whole.
- **Generation limit.** A write that would need generation `u64::MAX + 1` fails with `io`; generations never wrap. The same holds for the watermark's `seq` (5.6).

### 5.3 Logical size

The logical size can no longer be computed from the host size alone (`src/file.rs:77-81`). It is defined by the slots and the watermark `D` (5.6, a count of units):

- Let `n` be the number of pairs that are not absent. Walk back from pair `n-1`:
  - a pair with a valid slot (5.5) ends the walk;
  - a pair `u ≥ D` with no valid slot is a **trailing** pair from an unsynced extension and is dropped, which is equivalent to the extension not having reached that far;
  - a pair `u < D` with no valid slot is **erased**: the size computation fails with `io`, logged with the path and unit, and every operation that needs the size fails with it.
- If `k` is the last remaining pair, `logical size = k × 8192 + len(winner of k)`. A file with no remaining pair is empty.
- An **interior** pair `u < k` reads as follows:
  - with a winner of `len < 8192`: its `len` bytes followed by zeros. This arises when an unsynced append grew a former last unit and a later unit reached the disk first (C7);
  - with no valid slot and `u ≥ D`: 8192 zeros. This arises from an ordinary crash during an unsynced extension whose units reached the disk out of order, or torn (C14), on any filesystem. It matches plaintext and XTS, where such a page reads as zeros and PostgreSQL treats it as a new page;
  - with no valid slot and `u < D`: `io` (8.3).
- Absent pairs are never `io`, whatever `D` says. A host file shorter than `D` units was truncated, which is a non-goal, or a shrink's watermark write and truncate were reordered before the shrink's sync (6.4), which is legitimate.
- Corrupting the trailing pairs of a file therefore shrinks it silently only above `D`. Below `D` it is detected.

**Cost and caching.** The size of a codec-4 file needs the header block (header plus watermark records, one 4 KiB read) and the last pair (one read of up to 16512 bytes), plus one more pair read per dropped trailing pair. encfs caches the size in the per-file state (6.1), so `stat` on an open descriptor costs nothing after the first computation. `stat-at` by path has no descriptor and no file id. It first calls the host's `metadata-hash-at` (one host call, already passed through at `src/component.rs:1182-1194`) and looks the size up by host identity (6.1). Only on a miss does it open the file and pay the header-block read and the last-pair read, then cache the result. Section 11 counts this.

### 5.4 Nonces

The requirement: no two encryptions under one key may share a nonce. With Poly1305, a repeated nonce leaks the XOR of the two plaintexts and enables forgery.

- **Why deterministic nonces fail.** Take `nonce = f(unit, slot, generation)`. A write of generation `g+1` to slot B is torn and fails to authenticate. After restart the newest valid generation is still `g`, so the retry writes generation `g+1` to slot B again, with a different plaintext. The torn first attempt may have left durable sectors under the same nonce. The same happens when a process dies after the write but before it learns that the write landed.
- **Decision: random 192-bit nonces (Q5).** Each slot write and each watermark record write draws 24 bytes from `wasi:random/random.get-random-bytes`, which the component already uses for file ids, DEKs and wrap nonces (`src/component.rs:115-119`, `src/component.rs:349-352`). XChaCha20's 192-bit nonce makes a collision negligible: about 2^-97 after 2^48 writes under one key (birthday bound `q²/2^193`). It needs no persistent state, so crash and retry are safe by construction. The per-instance prefix plus counter variant is not used: it is unsafe if an instance's memory is ever snapshot and resumed twice, which the platform does not prevent.

### 5.5 Slot validity and selection

A slot is **valid** if it lies entirely within the host file, its generation is not 0, its `len` is within 1..=8192, its reserved bytes are zero, and its tag authenticates. The unit's **winner** is the valid slot with the higher generation.

| slot A | slot B | read returns |
|---|---|---|
| valid, gen a | valid, gen b, b > a | B |
| valid, gen a | invalid or absent | A |
| invalid or absent | invalid or absent | unit `≥ D`: trailing pair dropped from the size, interior pair reads as zeros. Unit `< D`: `io`, logged with the path and unit (8.3) |
| valid, gen a | valid, gen a | `io` (cannot happen without tampering) |

The table is symmetric in A and B. "Invalid" covers all-zero bytes, holes, torn bytes and tampered bytes alike: the reader does not try to tell a crash from tampering by what the bytes look like, only by the watermark.

**Selection procedure.** A reader checks the slot with the higher claimed generation first. If it authenticates, the other slot does not need to be decrypted. If it fails, the reader verifies the other slot. A higher generation in the clear proves nothing until its tag verifies; a torn slot usually shows the new generation with the old ciphertext. The writer uses the same procedure on a cold cache (6.3 W1).

### 5.6 Durable-size watermark

Each codec-4 file carries a watermark `D`: a count of units such that every unit `u < D` had a valid slot on disk when a sync of the file last completed before `D` was written. Under the durable-slot invariant (6.2) such a unit keeps a valid slot through any later crash, so a unit below `D` without one was erased.

**Records.** Two 64-byte records in the header block, record 0 at byte 2048 and record 1 at byte 3072:

| record bytes | field | notes |
|---|---|---|
| 0..8 | `seq`, u64 LE | 0 = never written |
| 8..16 | `durable_units` (`D`), u64 LE | |
| 16..40 | `nonce`, 24 bytes | random per record write |
| 40..56 | `tag`, Poly1305 | XChaCha20-Poly1305 seal of an empty plaintext under `wm_key` |
| 56..64 | reserved, zero | authenticated |

- **AAD** = `"DIPGWM04"` ‖ file id ‖ record index (u8) ‖ record bytes 0..16 ‖ record bytes 56..64. A record cannot be moved to the other position, to another file or into a slot.
- **Selection.** A record is valid if `seq ≠ 0`, the reserved bytes are zero and the tag verifies. The watermark is the valid record with the higher `seq`; equal `seq` in two valid records is `io`. **No valid record** fails the file with `io`: it cannot arise from a crash, because every codec-4 file is born with a durable record (below) and the record that holds the last durable value is never the target of a write.
- **Birth.** When encfs seals a codec-4 header, the 4 KiB block it writes and syncs (`src/component.rs:351-356`) also carries record 0 with `seq = 1, D = 0`. A file that has a header therefore always has a durable, valid watermark.

**Two-slot rule for records.** Record writes follow the same durable-slot rule as units (6.2), with one file-level `wm_pending` bit: while `wm_pending` is set, a record write overwrites the pending record; when it is clear, it writes the other one. A torn record write fails authentication and the reader falls back to the other record, which holds the last durable watermark. The new `seq` is the winner's `seq + 1`.

**Advancing.** `D` only ever claims units whose data was durable before the claim was written:

1. When a host `sync` or `sync-data` of the file succeeds (6.3 "Sync"), encfs computes a candidate `D'`. It starts at the current `D` and extends over consecutive units `u` that have a valid winner known in the per-file state, are not pending (the sync just cleared them) and lie inside the logical size.
2. A unit above `D` that this instance has not touched blocks the extension until it is verified. At each successful sync encfs verifies at most 256 such pairs (4 MiB of reads), in order. A verified pair with a valid winner extends `D'`. A pair with no valid slot is a hole from an earlier crash (C14); it already reads as zeros, so encfs writes a sealed zero unit into it (generation 1, slot A). The visible content does not change, and the unit joins `D'` after the next sync.
3. If `D' > D`, encfs writes the new record **lazily**: with the next write to that file, as one extra 64-byte `pwrite`, or when the file's last descriptor is dropped. The record write itself is pending (`wm_pending = true`) until the next successful sync. No fsync is added.

A crash before the record write, or one that tears it, leaves the previous `D`, which is lower and still true. A record never claims more than was durable, so `D` is safe at every crash point.

**Lowering.** A shrink lowers `D` to the new number of units before it truncates, and syncs before the next write (6.4).

**What the watermark costs and leaves out.** One 64-byte write per sync interval per written file, and at most 256 pair reads per sync while `D` catches up after a restart. Units written since the last advance are protected against crashes, not against erasure (non-goals). Replaying an older record lowers `D`; that is rollback (Q14).

## 6. Write protocol

### 6.1 Per-file state

encfs keeps state per file, not per descriptor. PostgreSQL may write through one descriptor and fsync through another. The state is keyed by **(file id, host identity)**: the file id from the header is fixed for the inode's lifetime (`src/header.rs:26-29`), and the host identity is the host's `metadata-hash` of the inode (`src/component.rs:1174-1180` passes it through). wasmtime derives that hash from the device and inode numbers, which do not change on writes; the implementation must confirm this for the pinned host. A second inode that carries a known file id, for example after a host-level `cp` of an encfs file within the volume, then gets its own state, and its reads authenticate against its own slots. Hard links and renames keep the inode, so they share state correctly. An `unlink-at` through encfs drops the state of the inode it removes, so a reused inode number never inherits it.

For each file the state holds:

- a **bitmap of two bits per unit**: `winner` (A or B) and `pending` (the winner was written since the last successful sync of this file), plus a third bit `known` that marks units whose winner this instance has authenticated or written. Generations are not cached: the writer needs the winner's generation only when it writes the unit, and it reads it from the slot header it verifies anyway (W1) or from the write it just made (W6, kept for the unit last written). A fully touched 1 GiB segment (131,072 units) costs about 48 KiB (Q8);
- the cached logical size, the watermark `D`, its winning record and `wm_pending`;
- `synced_once` (W0 has run, or a sync of this file succeeded, in this instance), `dirty` (a write since the last successful sync) and `failed` (a host sync of this file failed, A3).

**Lifetime.** State is kept while the file has a descriptor open **or** is `dirty`. A file whose last descriptor is dropped while it is dirty keeps its state until a later sync of it succeeds, or until encfs drops it under the rule in 6.6, which never relies on a lost `pending` bit.

### 6.2 The durable-slot invariant

> **A write never targets the slot that holds the unit's last durable version.**

The issue's rule, "write to the slot with the older generation", is not enough. Suppose v1 is durable in A, and v2 is written to B and not synced. PostgreSQL then writes the page again, which the WAL writer does for the tail page between commits. Under the issue's rule, v3 goes to A, the older generation. A power loss at that moment can tear A (v3) and lose B (v2, never synced) together. Then nothing valid is left, although v1 was fsynced. The target rule below closes this:

- `pending` is set: overwrite the **pending** slot (the winner). The durable slot keeps the last durable version.
- `pending` is clear: write the **other** slot. The winner is durable.
- No valid slot: write slot A. Either slot may hold torn bytes; nothing durable is lost.

The new generation is always `winner.generation + 1`, or 1 if there is no valid slot. Generations strictly increase per unit for as long as the unit exists, so the newest valid slot is always the latest version that reached the disk. A unit removed by a shrink and later re-created starts again at generation 1; 6.4 shows why that is safe.

The rule needs a correct `pending` bit. 6.6 lists every path that could lose it and how each is closed.

### 6.3 Steps of a write

For `write(offset, data)`, and for zero-fill, which already goes through the same path (`src/file.rs:128-133`):

1. **W0, first write to the file in this instance.** If `synced_once` is clear, call host `sync-data` on the file first, then set it. After a restart encfs cannot know whether the winners on disk are durable: a process crash without power loss leaves them in the host page cache. Syncing once makes them durable, so the invariant holds from the first write. Every write goes through W0, including the slot write of a shrink inside a unit, the sealed zero units of 5.6 step 2 and watermark record writes. Any successful `sync` or `sync-data` of that file in this instance also sets `synced_once` (Q9). If `failed` is set, the write fails with `io` here.
2. **W1, resolve each unit, authenticated.** If the unit is `known`, use the bitmap. Otherwise read the whole pair (one contiguous read of up to 16512 bytes) and run the selection procedure of 5.5: verify the slot with the higher claimed generation, and if it fails, verify the other. Only a slot whose tag verified can be the winner. **This holds for whole-unit writes too**: a whole-unit write skips the plaintext merge, never the authentication. A torn slot that claims a newer generation therefore never decides the target (C13). Record the result as `known`, with `pending = false` (6.6 explains why that is correct for a unit that was not `known`).
3. **W2, build the plaintext.** A partially covered unit is read-modify-write from the winner. A unit with no valid slot has no old plaintext: above `D` it is taken as zeros, as a read would return it; below `D` a partial write fails with `io` (erasure), and a whole-unit write is allowed, so WAL redo can overwrite such a page with a full-page image. The erasure was already logged when W1 found it.
4. **W3, choose the target slot and generation** (6.2).
5. **W4, seal.** Draw a fresh nonce, then encrypt and authenticate to produce `slot header ‖ ciphertext`.
6. **W5, write.** One host `pwrite` per unit, at the target slot's offset, `64 + len` bytes. WASI 0.2 has no `pwritev`, and slots of neighbouring units are not contiguous, so a multi-unit write costs one host call per unit (11). The exception is an extension: the slot-A images of new units and the zero slot-B gaps between them are contiguous and go out as one `pwrite`. This is an optimisation only; nothing depends on the order in which those bytes reach the disk (A5, C14). If a lazy watermark record write is due (5.6 step 3), it is one more 64-byte `pwrite` after the unit writes.
7. **W6, update the state.** Set `winner = target`, `pending = true`, `known = true`, `dirty = true`, and update the size. If W5 failed, follow 6.6 (e) instead.

**Sync.** `sync` and `sync-data` still pass through (`src/component.rs:1041-1043`, `src/component.rs:1087-1089`). When the host call succeeds, encfs clears every `pending` bit of that file, clears `wm_pending` and `dirty`, sets `synced_once`, and computes the candidate watermark (5.6). On failure it sets `failed`, changes nothing else, and returns the error (A3).

**Barriers.** Codec 4 adds exactly two kinds of fsync: W0, once per written file per instance, and one after each shrink (6.4). Otherwise it imposes no ordering between writes, and correctness rests on the invariant, the watermark and A1–A4.

### 6.4 Resizes

No resize relies on the filesystem ordering a size change against data (A5).

- **Append inside the last unit:** a single slot write with the larger `len`, so it is atomic (G4).
- **Append that adds units:** write the last unit with `len = 8192`, then the new units. They may reach the disk in any order (C7, C14).
- **Grow with `set_size`:** zero-fill through the write path, as today (`src/file.rs:136-141`).
- **Every shrink** follows three steps:
  1. **Lower the watermark.** If `D` exceeds the number of units that remain (`k` for a shrink to a unit boundary at `k × 8192`, `k + 1` for a shrink to inside unit `k`), write a record with the lower `D` (5.6, two-slot rule).
  2. **Truncate.** Host `set_size` to the end of the last remaining pair: `4096 + k × 16512` for a unit boundary, `4096 + (k + 1) × 16512` for a shrink inside unit `k`. A truncate to 0 is `set_size(4096)` and keeps the header and its records, as today (`src/header.rs:27-28`).
  3. **Sync.** Host `sync-data` on the file, then clear `pending` and `dirty` as for any sync. The next write to the file, including step 4, waits for it.
  4. **Shrink inside a unit only:** write unit `k` with the new `len` through the write path. Its target follows 6.2 as for any write.

  The state of every removed unit is dropped. PostgreSQL truncates relations in whole 8 KiB blocks and rarely, so the extra fsync is cheap. pglite re-extracts its runtime files with `open(CREATE|TRUNCATE)` at every start (`src/marker.rs:5-7`), which costs one fsync per such file per start; W0 for those files then finds `synced_once` already set.

**Why the shrink is safe without an ordering assumption.** Before step 3 completes, no later write has been issued, so a crash can only mix the old and new record and the truncated and untruncated length. Each mix reads correctly: an untruncated file reads with its old pairs, all of them old valid versions; a truncated file has its removed pairs absent, which is never `io` (5.3), even under an old, higher `D`. After step 3 the truncate is durable (A3), so **no byte of a removed pair exists on disk** when a later write re-extends the file.

**Generations after a shrink.** A unit re-created after a shrink starts at generation 1 in slot A (6.2, no valid slot). This is safe because step 3 has made the removal durable before that write: the re-created pair cannot hold a stale slot B from before the shrink, so no older version can win with a higher or equal generation. The first version of this note had no step 3, and the review showed that a reordered truncate could then let a stale pre-shrink slot win (W1 of the review).

**C9 re-checked.** A shrink inside unit `k`, crash after step 3 and before step 4 is durable: the file holds units up to `k`, with unit `k` still at its old length, which is 8192 because it was interior. The size is the intermediate, unit-aligned `(k + 1) × 8192`, with old, valid bytes. After step 4 reaches the disk, the size is the new one. A torn step 4 leaves the durable slot of unit `k` (6.2). No byte is garbled at any point (G4), and Q7 is answered by step 3 rather than by a journal.

### 6.5 Erasure, failure and fail-stop states

- **Erased unit below `D`** (W1 finds no valid slot): reads and partial writes of that unit fail with `io`; a whole-unit write repairs it (W2). The log line names the path and unit.
- **Watermark records both invalid:** the file fails with `io` (5.6).
- **Failed sync:** `failed` is set; further writes to the file fail with `io` until restart (A3). Reads keep working.

### 6.6 Paths that could lose the `pending` bit

The target rule (6.2) is only as good as `pending`. If it is wrongly clear, a write goes to the other slot, which may be the durable one; if it is wrongly set, a write overwrites the winner, which may be the durable one. When encfs cannot know the bit, it never guesses: it syncs, which makes the true value "clear". Each path below is closed by one rule:

- **(a) Re-selection after a failed verify.** A cached winner that fails verification (8.1) means the volume changed under encfs (A4). The read fails with `io`; the unit's entry is re-selected from disk **keeping its `pending` bit**; and `synced_once` is cleared, so the next write to the file runs W0 and syncs before it trusts any bit again.
- **(b) Entries created by reads.** A read that resolves a unit which is not `known` records it with `pending = false`. That is correct because of (c): a unit without an entry was not written since the last successful sync of this file, so its on-disk winner is either the durable version from that sync or, before W0 has run, a version that W0 will make durable before the first write. A read never overwrites an existing entry.
- **(c) Dropping state.** The bitmap has no per-unit eviction, so a `pending` bit can only disappear with the whole file state. State is kept while the file is `dirty` (6.1). To drop the state of a dirty file, for example under a limit on open files' memory, encfs first calls host `sync-data` on it; if that fails, it keeps the state and sets `failed`. A clean file's state can be dropped freely; if it is recreated, W0 runs again because `synced_once` is part of the dropped state.
- **(d) Last descriptor closed.** Covered by (c): closing does not drop the state of a dirty file.
- **(e) W5 fails** (`ENOSPC`, a short write, any host error): the target slot now holds unknown bytes.
  - If the target was the other slot (`pending` was clear), the winner is unchanged and durable; the state stays as it was.
  - If the target was the pending winner, the pending version is lost on disk. encfs re-reads the pair, re-selects (5.5) and records the result with `pending = false`, which is now true: the remaining valid slot is the durable one, because 6.2 never targeted it. A read then returns the **durable** version, so the last acknowledged unsynced write to that unit disappears in a live instance. That is acceptable: the failed write returned an error, PostgreSQL keeps the page dirty in shared buffers and retries the write with the newest contents, and a failed WAL write PANICs. The retry targets the slot that failed (6.2, `pending` clear means "the other slot"), with a fresh nonce.
- **(f) Shrinks.** Step 3 of 6.4 syncs, so the bits of surviving units are clear and correct; removed units lose their state with their pairs.
- **(g) W0 coverage.** Every write path, including a shrink's slot write, sealed zero units and record writes, runs W0 (6.3 W1).
- **(h) Failed sync.** The bits stay set, and `failed` stops further writes (A3), so no write ever consults a bit whose meaning a failed sync made uncertain.
- **(i) Restart or process crash.** All state is lost; W0 syncs before the first write.
- **(j) Two inodes with one file id.** Keyed apart by host identity (6.1).

## 7. Crash cases

These cases assume A1–A5. "Previous" means the version in the durable slot. `D` is the watermark on disk at the crash.

| # | crash point | on disk | a reader returns |
|---|---|---|---|
| C1 | before W5 reaches the disk | old pair | the old winner |
| C2 | W5 torn: any subset of the target slot's atomic units is new | target fails authentication; the durable slot is untouched (6.2, A2) | **the previous version**. If the target was pending, the version before it, which was never synced, so losing it is allowed |
| C3 | W5 complete, not synced | target valid with a higher generation | the new version (allowed, never required) |
| C4 | only the slot header's units, or only ciphertext units, are new | target fails authentication | as C2 |
| C5 | a write spanning several units, each landed, torn or lost independently | each unit independently | each unit is its old or new version (G3). There is no cross-unit atomicity, as with plaintext pages |
| C6 | append inside the last unit | one slot | old length and contents, or new: **no garble** (G4, compare #206's 31 and 15 bytes) |
| C7 | append that adds units, unsynced, persisted out of order | the last unit old or full; new trailing pairs present, torn or absent | trailing pairs without a valid slot are dropped, so the size is the old one or an intermediate one. A former last unit with `len < 8192` followed by a valid unit reads as zeros up to 8192 (5.3) |
| C8 | write of a fresh file's first unit, header synced | header with record 0, plus a torn or absent slot A | an empty file (`D = 0`). The header still follows the fresh/sealed rules (`src/header.rs:78-113`) |
| C9 | shrink inside a unit, after the shrink's sync and before the slot write is durable | pairs beyond unit `k` gone; unit `k`'s old slot | the unit-aligned size `(k + 1) × 8192`, old valid bytes. After the slot write: the new size (6.4) |
| C10 | rewriting the same unit twice without a sync, torn on the second write | durable slot untouched; the pending slot torn | the last **durable** version. The issue's "older generation" rule would lose it here (6.2) |
| C11 | during a sync | pending slots and a pending record durable or not | per unit, the newest version that reached the disk, never older than the previous sync; `D` old or new, both true. W0 makes the next instance safe |
| C12 | between W0's sync and the first write | nothing new | as C1 |
| C13 | tear, restart, whole-unit rewrite of the same unit, tear again | slot A: durable v1 (gen g). Slot B: torn, claiming gen g+1 | see the walk-through below: **v1 survives** |
| C14 | unsynced extension by units `k+1..m` above `D`, persisted out of order or torn (writeback order, ext4 delalloc, unwritten extents, `data=writeback`) | a later pair valid, an earlier one a hole, zeros, stale bytes or torn | the earlier unit reads as **8192 zeros**, not `io`, because it is above `D`; trailing ones are dropped. As plaintext and XTS would |
| C15 | lazy watermark record write torn or lost | one record torn, the other holds the previous `D` | the previous, lower `D`. Erasure detection lags by one advance, nothing else changes |
| C16 | shrink, before its sync completes | old or new record; truncated or not | old pairs, all valid, or absent pairs, never `io` (6.4) |

**C13, the WAL tail after recovery, walked through.** Before the power loss: slot A holds v1 of the WAL tail page (generation `g`), fsynced, containing commit A. A rewrite to slot B (generation `g+1`) is torn: its header sector carries `g+1`, its ciphertext is partly old.

1. Restart. pglite recovers; the cache is empty.
2. The WAL writer rewrites the tail page with a whole-unit 8 KiB write. W0 syncs the file.
3. W1 finds the unit not `known`, reads the pair and verifies the higher claim first: slot B (`g+1`) fails. It verifies slot A (`g`): valid. Winner A, `pending = false`.
4. W3 targets B with generation `g+1`, a fresh nonce.
5. A second power loss tears that write. Slot A, untouched, still holds v1 and commit A.

The first version of this note let a whole-unit write choose its target from the unverified generations. Step 3 would then have picked B as the winner and targeted A, and step 5 would have destroyed the only copy of commit A: the spike's failure (C2 of the review). The same walk applies to a full-page-image redo write of a relation page. 12.2 and 12.3 test this sequence.

**The spike's failures under codec 4:**

- **Tearing the WAL page that holds an fsynced commit** (`tearFirstRewrite`, `scripts/lib/tear.ts:61-81`) is C2 or C10, and after a restart C13. The durable slot still holds the page with commit A, so commit A survives.
- **Tearing a `pg_control` rewrite** is C2. The previous `pg_control` authenticates and its CRC holds, so PostgreSQL starts from the previous checkpoint, as it does after a lost plaintext write.

Plaintext only promises sector-level old-or-new pages here. Codec 4 is strictly stronger: the whole page is old or new.

**Shared atomic units.** Slots are compact, so their boundaries do not fall on atomic-unit boundaries:

- The pair stride is 16512 = 32 × 512 + 128 and the slot size 8256 = 16 × 512 + 64. Slot A of unit `u` starts at an offset ≡ 128·u (mod 512) and slot B at ≡ 128·u + 64 (mod 512). Slot A starts on a 512-byte boundary only for `u ≡ 0 (mod 4)`, slot B never; at 4 KiB granularity slot A starts on a boundary only for `u ≡ 0 (mod 32)`.
- So nearly every slot boundary lies inside an atomic unit: slot A of `u` shares one with slot B of `u`, and slot B of `u` shares one with slot A of `u + 1`. A slot write therefore rewrites an atomic unit that also holds the edge of a neighbouring slot, which may belong to another unit and may be that unit's durable slot. With 4 KiB units, the shared unit holds up to 4032 bytes of the neighbour.
- **Under A1 this is safe at any granularity.** The bytes of the neighbour inside the shared unit are identical in the old and the new image of that unit, because the write does not cover them and the page cache rewrites them unchanged. Old-or-new of the whole unit therefore leaves the neighbour's bytes as they were. The argument does not depend on the size of the atomic unit, only on A1 holding at whatever size it is.
- **If A1 fails** (a unit returns neither its old nor its new contents, for example a device that garbles sectors in flight), the target fails authentication as in C2, **and the neighbouring slot can be damaged too**. If that neighbour is a durable slot, its unit has lost its durable version. Codec 4 then reports `io` for it below `D` (or zeros above it) instead of returning wrong data. Plaintext and XTS lose the same bytes silently, and PostgreSQL's `pg_control` has the same dependency. This note does not claim more than A1.
- **Padding does not remove the dependency.** Padding slots to 8704 bytes (17 sectors) would align them only to 512 bytes, which buys nothing where the atomic unit is 4 KiB. Independence there needs slots padded to 12288 bytes, about 3× the data. Neither is adopted (Q2).
- The watermark records share the header block's atomic unit at 4 KiB granularity (they use separate 512-byte sectors from the header and from each other). The same argument applies: the header bytes are identical in both images. Header rotation already rewrites bytes inside that unit in place (`src/component.rs:590-593`).

## 8. Read protocol

### 8.1 Reads

- **Size:** from the per-file state, otherwise computed once as in 5.3.
- **Each unit in range:**
  - With a `known` winner, read only that slot (`64 + len` bytes), verify it and decrypt. If verification fails, which cannot happen with a single writer unless the volume changed under encfs, follow 6.6 (a): `io`, re-select keeping `pending`, clear `synced_once`.
  - Otherwise read the whole pair in one call, select (5.5), record the winner as `known` with `pending = false` (6.6 (b)), and decrypt.
  - No valid slot: zeros above `D`, `io` below it (8.3).
- **Multi-unit reads:** one contiguous host read over the pairs when most winners are unknown; per-slot reads when they are known. Either way it is fewer host calls than units, as `read_units` does today (`src/file.rs:153-166`).
- **Integrity failures** map to `ErrorCode::Io` with a log line naming the path and unit, like `FileError::Truncated` today (`src/component.rs:187-198`).

### 8.2 Slot choice

The reader never returns an unauthenticated byte. When both slots are valid it returns the higher generation. Its only fallback is the other authenticated slot, and for a unit above `D` with no valid slot, zeros. The first fallback is how C2, C10 and C13 recover, and it is also why rollback by a volume writer is out of scope (non-goals).

### 8.3 Interior units without a valid slot

The first version of this note said a crash could not leave an interior pair without a valid slot, and proposed `io` for one. Review showed that is wrong: an unsynced extension whose units reach the disk out of order, or torn, leaves exactly that, on ext4 with delayed allocation as on any other filesystem (C14). `io` there would make data unreadable after an ordinary crash: PostgreSQL's `RBM_ZERO_ON_ERROR` does not cover a read `EIO`, so sequential scans and free-space-map lookups would fail.

The decision (O2) separates the two causes by the watermark:

- **Below `D`:** the unit had a valid slot on disk at a completed sync, and the durable-slot invariant keeps one through any crash. No valid slot means erasure or corruption: **`io`**, logged with the path and unit. Reading it as zeros would let a volume writer erase a page without detection, and PostgreSQL reads an all-zero heap page as a valid new page.
- **At or above `D`:** the unit was first written since the last advance and may have been lost in a crash: **zeros** for an interior unit, dropped from the size for a trailing one. This is what plaintext and XTS return in the same situation.

Whole-unit writes over an erased unit still work, so WAL redo can overwrite it with a full-page image without reading it first.

## 9. Mode selection, codec 3, G04 and rollout

### 9.1 Integrity is a Tenant setting (O3)

Integrity is per directory and chosen once, when the directory is initialised. The owner decided (O3) that the first implementation switches it on through a **Tenant setting that the platform renders into the pglite workload**, not through a build flag alone.

**Tenant field.** `spec.storage.integrity` on the `Tenant` CRD (`platform/platform/src/tenancy/resources.ts:47-66` for `TenantSpec`, `platform/platform/src/tenancy/resources.ts:803-830` for the schema):

- enum `Off` | `AEAD`, default `Off`, inside a new `storage` object with `default: {}`, following the style of `deletionPolicy` (`Retain` | `Delete`);
- it applies to the Tenant's workload storage directories (`di-framework.dev/persistent-storage`, `platform/platform/src/tenancy/workload-storage.ts:1-11`), the directories that pglite workloads use for their data.

**Recording which mode each directory got.** The controller records, per workload storage key, the mode it rendered when it first gave a workload that directory: `status.storage.directories[] = { key, integrity }`. The record is written **before** the first storage patch for that key (`storagePatch`, `platform/platform/src/tenancy/workload-storage.ts:181-214`, applied by `reconcileWorkloadStorage`, `platform/platform/src/tenancy/controller.ts:2255-2272`). A guest sees the directory only through that patch's preopen, so encfs can initialise a directory only after its mode is recorded. On upgrade, the controller backfills `integrity: Off` for every key whose workload already carries the controller's storage volume: those directories exist and are XTS (or plaintext).

**Immutability once a directory is initialised.** A ValidatingAdmissionPolicy on `tenants`, next to the existing tenancy policies (`platform/platform/src/tenancy/admission.ts:490-510`, which today bind only tenant namespaces; Tenant is cluster-scoped, so this one needs its own binding), refuses an update that changes `spec.storage.integrity` while `oldObject.status.storage.directories` is non-empty. Message: "spec.storage.integrity cannot change after workload storage exists (keys: …); integrity applies only to new, empty directories. Migrate with pg_dump and restore (design-200 section 10)." Before any directory exists, the field may change freely. A CRD transition rule (`self == oldSelf`) is not used, because it cannot see whether a directory exists.

**Set on a Tenant whose directory already exists.** The admission policy refuses it. If the field changes anyway (the policy not installed, or status lost and backfilled later), the controller:

- keeps rendering the **recorded** mode for every existing key, never the new one;
- sets a Tenant condition `StorageIntegrity` with `status: False`, reason `IntegrityLocked`, and a message naming the keys whose recorded mode differs from the spec and pointing to section 10. With every recorded mode equal to the spec, the condition is `True`, reason `AsSpecified`.

New keys created after the change get the spec's mode. Each directory is homogeneous, which is what G1 needs.

**Rendering into the workload.** For each storage workload whose key is recorded as `AEAD`, `storagePatch` adds `DI_PGLITE_INTEGRITY=1` as an inline variable to the `localResources.environment` of each component; for `Off` it renders nothing. It is a controller-owned field like the volume and the preopen:

- the WorkloadDeployment admission policy refuses a tenant update that adds, removes or changes it, as it does for the controller's volumes (`platform/platform/src/tenancy/admission.ts:240-267`, `platform/platform/src/tenancy/admission.ts:626-727`);
- tenant-auth's deploy and vars APIs reserve the name, so it cannot arrive through `di-vars-<env>` or a tenant Secret (`platform/tenant-auth`).

**What encfs does with the variable.** `DI_PGLITE_INTEGRITY` is hidden from the engine like the key variables (`src/keys.rs:40-44` gains it). It is read once, at the root decision (`src/marker.rs:192-221`):

| root marker | `DI_PGLITE_INTEGRITY` | decision |
|---|---|---|
| absent (or short) in a root without data | `1` | initialise an **integrity** directory: write `DIPGKEY2` |
| absent (or short) in a root without data | absent or `0` | initialise an XTS directory, as today |
| `DIPGKEY1` (XTS directory) | `1` | **refuse**: lock the preopen with a new `Lock::IntegrityRequested` before any mutation, logged as "integrity requested for an existing XTS directory; migrate with pg_dump/restore" |
| `DIPGKEY1` | absent or `0` | XTS, as today |
| `DIPGKEY2` (integrity directory) | any | integrity: the marker decides. A missing variable is logged, not acted on, because reading an integrity directory as such never weakens it |
| any | another value | refuse (lock), fail closed |
| absent, root with data | any | `Unencrypted` lock, as today |

The variable is honoured **only when an empty directory is initialised**; on an existing directory the marker always decides, and the only case it acts on is refusing to proceed when the platform asks for integrity on an XTS directory.

**Marker.** XTS directories keep `DIPGKEY1 ‖ KCV`, 24 bytes (`src/marker.rs:16-17`). Integrity directories get `DIPGKEY2 ‖ KCV ‖ flags`, 25 bytes, where `flags` is a bit set: bit 0 = codec 4; any unknown bit fails closed (Q4). **Format constraint: a `DIPGKEY2` marker must be at least 24 bytes (`MARKER_LEN`) long.** Builds without codec 4 re-initialise a marker shorter than 24 bytes in a root without data (`src/marker.rs:203-205`), which would overwrite the integrity marker. At 24 bytes or more they lock it as `CorruptMarker`, because the magic differs (`src/marker.rs:206-207`), and `read_marker` reads at most 25 bytes, so a longer marker is seen as 25 bytes and also locked (`src/component.rs:452-466`).

**Older builds fail closed on an integrity directory (G6).** `decide` locks the whole preopen before anything is written (`src/marker.rs:192-221`); `open_root` runs in `get_directories` before pglite gets a descriptor (`src/component.rs:847-866`). No codec-4 file is ever opened by a build that cannot read it. That differs from codec 3's rollback, which relies on PostgreSQL panicking on the first codec-3 file (README "Codecs and migration"). The lock message says "corrupt", which is misleading, but that cannot be changed for builds already deployed. The codec-4 release's message names the mode instead.

**The codec-4 writer is in the default published build.** Because a Tenant setting can turn integrity on, every published encfs build from the writer release on (9.3) contains the codec-4 writer; there is no `write-codec-4` cargo feature. The build still creates XTS directories unless the variable asks for integrity at initialisation, so this changes no default. A build older than the reader release ignores the variable and would initialise an XTS directory for an `AEAD` Tenant. Two measures close that:

- the custom section advertises `integrity=1` (9.3), and tenant-auth's deploy path refuses a storage workload for an `AEAD` Tenant whose pglite component does not advertise it (`platform/tenant-auth`; this needs the custom-section parser of Q11);
- `make smoke` checks that an integrity directory's marker is `DIPGKEY2` (12.3).

**Rotation must keep the mode.** `write_marker` currently encodes only the KCV (`src/component.rs:481-497`). The rotation sweep must rewrite `DIPGKEY2` with its flags.

**Inside an integrity directory**, every new file is codec 4, and an XTS file is refused with `io`. A fresh directory has none; they can only be copied in.

### 9.2 Code that changes when this is implemented

In `platform/pglite-encfs`:

- `src/codec.rs`: `Codec::TwoSlotAead = 4` in `id` and `from_id`. Codec 1 stays rejected.
- `src/header.rs`: parse accepts 4. Update the tests that assert 4 is unsupported (`src/header.rs:282-290`, `src/codec.rs:235-237`).
- `src/file.rs`: it assumes a length-preserving layout throughout (`src/file.rs:3-5`, `src/file.rs:77-90`, `src/file.rs:153-209`). Codec 4 gets its own module (working name `src/slots.rs`) behind a small layout trait, so the XTS path and its fixtures (`src/file.rs:713-811`) stay byte-identical. The watermark records live in the same module.
- `src/component.rs`: `guest_stat`, `stat` and `stat-at` stop deriving the size from the host size for codec-4 files (`src/component.rs:166-181`, `src/component.rs:1096-1106`); the per-file state keyed by (file id, `metadata-hash`) and the host-identity size cache (5.3, 6.1); clearing pending bits and advancing the watermark on sync; the `failed` fail-stop; header sealing with record 0 (`src/component.rs:341-364`).
- `src/marker.rs`: the `DIPGKEY2` form with its flags byte, `Lock::IntegrityRequested`, and the table in 9.1.
- `src/keys.rs`: hide `DI_PGLITE_INTEGRITY` (`src/keys.rs:40-44`).
- `Cargo.toml`: no new feature; the codec-4 writer is always compiled (9.1).
- `scripts/smoke.ts`: the codec census only accepts 2 and 3 (`scripts/smoke.ts:252-265`).
- `scripts/lib/tear.ts`: tears are cut at XTS page offsets after the header (`scripts/lib/tear.ts:34-81`). For codec 4 they must be cut inside the slot that changed.

**Cross-lane scope (future implementation, coordinate with T03 and T10).** The Tenant setting touches files that other lanes own:

- `platform/platform/src/tenancy/resources.ts`: `TenantSpec.storage.integrity`, the CRD schema, and `status.storage.directories`;
- `platform/platform/src/tenancy/workload-storage.ts`: `storagePatch` renders `DI_PGLITE_INTEGRITY` from the recorded mode;
- `platform/platform/src/tenancy/controller.ts`: write-ahead recording in `reconcileWorkloadStorage`, the upgrade backfill, and the `StorageIntegrity` condition;
- `platform/platform/src/tenancy/admission.ts`: the Tenant update policy and the WorkloadDeployment rule for the controller-owned variable;
- `platform/tenant-auth`: reserving the variable name in the deploy and vars APIs, and the deploy-time `integrity=` check;
- the platform docs and the CLI plugin examples, in follow-up commits in their own repositories.

These changes ship in the writer release (9.3), not in the reader release.

### 9.3 Relation to #206 and G04

- **#206 does not wait for codec 4, and codec 4 does not wait for G04.**
  - G04 (identity-server#71 parses and enforces `write-codec`, and a reader-capable encfs is deployed everywhere) gates only flipping the XTS default from codec 2 to 3.
  - Codec 4 changes no default and no existing directory. Its rollback story is the marker (9.1), not the custom section.
  - The T08 order stays `#200:design` → #206.
- **Two-step rollout, as in #206:**
  1. **Reader release:** reads codec 4 and the `DIPGKEY2` marker, but cannot create them. If `DI_PGLITE_INTEGRITY=1` reaches it on an empty directory, it refuses (lock) instead of creating an XTS directory.
  2. **Writer release:** the codec-4 writer in the default published build, plus the Tenant field, the controller and admission changes, and the tenant-auth checks (9.2). A Tenant can opt in from this release on.

  An integrity directory must never be opened by a build older than step 1. The marker makes that fail closed.
- **Custom section.** It is a fixed 40-byte `format=1 codec=aes-256-xts write-codec=N` today (`src/component.rs:64-75`). A codec-4-capable build also advertises `read-codecs=2,3,4 integrity=1`, so deploy tooling can refuse a pin that cannot read a directory's mode. identity-server#71 is still open; the decision (Q11) is to ask it now to accept unknown keys and a variable-length section, so codec 4 needs no further gate.
- **Codec 4 removes the #206 problem only for integrity directories.** XTS directories still need codec 3 and its flip.

## 10. Migration and compatibility (O4)

- **Existing files are never converted in place, and directories are never mixed.** An XTS directory moves to integrity mode only by **`pg_dump` from the XTS instance and restore into a new instance whose directory was initialised empty in integrity mode**: a new Tenant created with `spec.storage.integrity: AEAD`, or a new workload storage key of a Tenant that has no storage yet. This is the documented path at ship time.
- **The offline copy tool stays on #199** (README "Rotation" and "Codecs and migration"). Codec 4 does not wait for it.
- **Mixed directories are refused.** An XTS directory never gets codec-4 files for new data (9.1: `DIPGKEY1` with the variable set locks), and an integrity directory refuses XTS files with `io`. A mixed directory could not claim G1.
- **Codec 2/3 fixtures** (`src/testdata/codec2`, `src/file.rs:713-768`) must keep reading and rewriting byte-identically. The XTS code path is not touched.
- **Downgrade:** a build that cannot read codec 4 sees an integrity directory as `CorruptMarker` and locks it (9.1). Rollback after an integrity directory exists means rolling forward to a codec-4 reader, or restoring a pre-migration snapshot of the XTS directory.
- **Key rotation:** unchanged for headers (`src/header.rs:189-201`); it writes only the 152 header bytes, so the watermark records survive. The sweep must rewrite the `DIPGKEY2` marker with its flags.
- **Interface:** the WIT package and the encfs exports are unchanged. The rollout is gated by the release steps, the markers and the Tenant setting.

## 11. Performance and space

These are estimates to be checked against the README benchmark, which the issue's acceptance requires. The README baseline is wasmtime 48, aarch64, ±20% (README "Performance").

**Space.** Every file in an integrity directory uses two slots (O1). The pair stride is fixed (5.2), and an extension writes the slot-A images together with the zero slot-B gaps between them (W5), so every unit but the last occupies a full pair from its **first** write:

- A file of `n` units has `st_size = 4096 + (n − 1) × 16512 + 64 + len(n − 1)` before its last unit's slot B is first written, and `4096 + (n − 1) × 16512 + 8256 + 64 + len(n − 1)` after. Allocated blocks track `st_size`, because the gaps are written, not left as holes.
- **Multi-unit files cost about 2.016× from their first write**, whether or not their pages are ever rewritten. Only the last unit, and therefore a single-unit file, costs about 1× (`4096 + 64 + len`, close to XTS's `4096 + len`) until it is rewritten.
- **WAL segments double at creation.** PostgreSQL pre-zeroes each 16 MiB segment (2048 units), so a segment is `4096 + 2047 × 16512 + 8256 = 33,812,416` bytes (about 32.2 MiB) as soon as it exists, against 16 MiB plus 4 KiB with XTS.
- **README cluster** (1516 files, 32.9 MB plaintext, 40.0 MB with XTS): nearly all of the data sits in multi-unit files, so expect about 2.0 × 32.9 MB of data plus 1516 × 4 KiB = 6.2 MB of headers, less the last-unit savings: **roughly 68–72 MB**, about 1.7–1.8× XTS. The first version's 60 MB lower bound was too low.
- **Sparse gaps** (separate `pwrite`s per new unit, leaving slot-B regions as holes until first written) are not adopted. Only the whole 4 KiB pages inside an 8256-byte gap could be holes, about one per gap, which saves roughly a quarter of the allocation; `st_size` stays the same; and a bulk extension would cost one host call per unit instead of one per extension.
- The alternative of two slots only for in-place-rewritten files was rejected (O1): it would turn crash-torn free-space-map or relation pages into `io`, which `RBM_ZERO_ON_ERROR` does not absorb.

**Host calls.** WASI 0.2 has no `pwritev`, and the slots of neighbouring units are not contiguous. A logical write of `k` whole units, such as a multi-page WAL flush or a bulk relation write, becomes `k` host `pwrite` calls instead of one today; only extensions coalesce (W5). The commit-path and bulk-load estimates below include this. The watermark adds one 64-byte `pwrite` per sync interval per written file.

**Commit path** (an 8 KiB WAL write plus fsync, `+32%` over plaintext with XTS):

- With a warm cache: one `pwrite` of 8256 bytes, one random draw, one AEAD seal of 8 KiB; a multi-page flush adds one `pwrite` per extra page.
- With a cold cache (first write to the unit in the instance), add one 16512-byte read and up to two tag verifications (W1). The tail page is hot, so the cache is nearly always warm.
- The fsync count does not change, apart from one W0 fsync per file per instance and one per shrink.
- Expected: **within noise of XTS**, because fsync dominates.

**`stat` and `stat-at`.** `stat` on a descriptor is free after the first size computation. `stat-at` costs one host `metadata-hash-at` call plus a cache lookup; on a miss it adds an open, the 4 KiB header-block read and the last-pair read, then caches the size (5.3). PostgreSQL stats relation segments often, so `stat-at` on cold and warm caches joins the benchmark list.

**CPU:**

- XTS runs in software AES inside Wasm at about 50 MB/s (README "Performance"). RustCrypto's software AES is fixsliced, so it does not use table lookups; it is slow in Wasm because a bitsliced implementation does a lot of work per block without SIMD.
- XChaCha20-Poly1305 is add-rotate-xor and multiply arithmetic that maps well to Wasm without SIMD. It is commonly 2–4× faster per byte there than software AES; to be measured.
- Expected: **equal or lower crypto cost than XTS**. This is also why the design does not use AES-GCM or AES-GCM-SIV (Q13).

**Bulk load plus checkpoint:**

- Bytes on disk roughly double from the first write (above). Bytes written per page rewrite are the same as XTS plus 64 bytes.
- One host call per unit instead of per logical write.
- XTS measured 6.0–6.7 s against 1.6–2.1 s for plaintext, CPU-bound.
- Expected: **similar to XTS or somewhat higher**, depending on host I/O and host-call overhead.

**Uncached scans** (about 10× today):

- With a cold cache, each unit reads both slots: 2× bytes, but one host call per range.
- With a warm cache: 1× bytes plus a 64-byte header per unit.
- Expected: **1–2× XTS I/O** with cheaper crypto.

**Memory:** the per-file bitmap (6.1), about 48 KiB per fully touched 1 GiB segment.

**Benchmark list** (#200's acceptance criterion): the README table for plaintext, XTS and codec 4 on the same host, plus commit latency with multi-page WAL flushes, bulk load plus checkpoint, cold and warm `stat-at`, and on-disk size (`st_size` and allocated blocks) of the README cluster.

## 12. Test plan

### 12.1 Unit tests (host, `cargo test`)

- **Slot codec:** round trips for every `len` class (1, 15, 16, 8191, 8192); AEAD known answers from an independent reference (libsodium or Node `crypto`), kept with the existing KATs (`src/testdata/xts-kat.txt`); both HKDF derivations pinned.
- **Binding:** swapping slots A and B, moving a slot to another unit or file, and editing `generation`, `len`, the reserved bytes, the nonce, the tag or any ciphertext byte must each fail authentication. The same for watermark records: swapping records 0 and 1, moving a record to another file, editing `seq` or `D`.
- **Selection:** the full table in 5.5, including equal generations, generation 0, a slot past the end of the file, a `len` out of range, and a torn slot claiming the higher generation.
- **Size and watermark:** trailing invalid pairs above `D` dropped; an interior pair without a valid slot reads as zeros above `D` and fails with `io` below it; a trailing invalid pair below `D` fails with `io`; absent pairs below `D` are never `io`; both records invalid fails the file; `D` advances only after a sync and only over verified units; holes above `D` are filled with sealed zero units and then covered.
- **The invariant:** a model test that drives write, write, sync, write sequences, including shrinks, failed writes (6.6 (e)) and dropped state (6.6 (c)), and asserts that the durable slot is never the target.
- **Cold-cache target choice (C13):** a pair with a torn higher-claimed slot and a valid lower one; a whole-unit write must target the torn slot.
- **Markers:** the v1 `decide` (`src/marker.rs:192-221`) fed a 25-byte `DIPGKEY2` marker with `has_data` false and true must return `Locked(CorruptMarker)`; the new `decide` covers every row of the table in 9.1, including unknown flag bits.
- **Plaintext model:** extend `matches_a_plaintext_model_under_random_operations` (`src/file.rs:813-869`) to codec 4 with the existing `XorShift` generator (`src/file.rs:271-283`). No new dependency is needed (Q15).
- **Unchanged XTS behaviour:** the existing codec-2/3 tests and fixtures pass unchanged.

### 12.2 Fault-injection harness

Replace the narrow `Crashing` storage (`src/file.rs:479-498`) with a **recording storage**. It logs every `write_at`, `set_len` and `sync` and keeps two images: the durable one (as of the last sync) and the volatile one. A crash is simulated by building candidate disks from the durable image plus a selection of the operations since the last sync:

1. **Every write boundary:** after each operation, persist an in-order prefix of the unsynced operations.
2. **Every tear,** at two granularities, 512 bytes and 4 KiB (A1): for the operation in flight, every unit cut, new prefix with old suffix and old prefix with new suffix, and for writes of up to 32 units, every subset of units. This includes **extending writes**: an extension can persist a later unit while an earlier one stays a hole, zeros or old bytes, with the file length already advanced. A shared unit takes the neighbour's bytes from the volatile image, which equals the old one (section 7).
3. **Reordering:** every subset of up to 8 unsynced operations, and a random sample beyond that, to model page-cache writeback order, `set_len` included (C5, C7, C14, C16). Nothing is reordered across a sync.
4. **Restart:** reopen with an empty cache, which exercises W0 and W1's authenticated choice, and continue the workload after the crash, then crash again (C13).

The invariants checked on every candidate disk:

- **Durability:** every byte covered by a completed sync reads back as its synced value or a later written value.
- **Atomicity:** every unit equals one version that was written to it, the durable version, or, for a unit at or above the watermark that was first written after the last sync, zeros.
- **No integrity errors (G8):** no `io` from slot or record authentication on a crash-only disk, **without exceptions**. The first version allowed one for zero interior pairs; the watermark removes it.
- **Watermark soundness:** `D` on disk never exceeds the number of units that were durable, with valid slots, at a completed sync.
- **Size:** the size equals some size the file had since the last sync, an intermediate size of an unsynced extension (trailing pairs dropped), or an intermediate unit-aligned size during a shrink inside a unit (C9).
- **Nonce uniqueness:** all nonces sealed in a run, retries after each crash included, are distinct. With the production random source this is trivially true. The harness also runs with a deterministic counter source to check that the protocol never reseals with a reused nonce.
- **Erasure detection:** on a disk derived from a crash-only disk by zeroing or garbling both slots of a unit below `D`, reads of that unit fail with `io`.

Workloads:

- the WAL tail pattern (repeated rewrites of one growing page, fsync on some);
- a `pg_control` rewrite;
- small-file appends and shrinks across unit edges (the #206 cases, `src/file.rs:540-560`), including truncate to 0 and re-extension;
- multi-unit extensions, out of order and torn;
- random sequences.

### 12.3 `make smoke`

- **Integrity directory:** the full pglite suite on a directory initialised with `DI_PGLITE_INTEGRITY=1`, with every file checked to be codec 4 and the marker to be `DIPGKEY2`.
- **Torn-write matrix:** the three existing cases (`scripts/smoke.ts:627-660`), with `tear.ts` taught to cut inside the slot that changed. Add:
  - a fourth case, the WAL tail page rewritten twice without an fsync in between (C10);
  - a fifth, a torn `pg_internal.init` style unaligned append (C6);
  - a sixth, tear, restart, whole-unit rewrite of the same WAL page, tear again (C13);
  - a seventh, a relation extension persisted out of order (C14): the cluster must start and read the hole as a new page.
- **Tamper:**
  - flipping one ciphertext byte of a relation page in a stopped directory fails with `io` on access;
  - zeroing both slots of a relation page below the watermark fails with `io` on access;
  - replacing a slot with an older valid copy returns the older version, which documents the non-goal.
- **Mode selection:** `DI_PGLITE_INTEGRITY=1` on an existing XTS directory locks it, byte-identical; an unknown value locks.
- **Downgrade:** a build without a codec-4 reader, and the published v1, refuse an integrity directory with the marker lock and leave it byte-identical.
- **Coexistence:** an XTS directory opened by the codec-4 build is unchanged (no codec-4 files, codec counts as today).
- **Benchmark:** the list in section 11.

The tenancy changes of 9.1 get their own tests in `platform/platform` when they are implemented: the CRD default, the admission refusal after a directory is recorded, write-ahead recording, the backfill, the condition and the rendered variable.

## 13. Decisions

### 13.1 Owner decisions (2026-10-28)

- **O1 (Q3) Scope: two slots for every file** in an integrity directory. The owner accepts about 2× on-disk size for multi-unit files (11). Single-slot AEAD for relations was rejected because crash-torn FSM or relation pages would become `io`, which `RBM_ZERO_ON_ERROR` does not absorb.
- **O2 (Q6 + Q14) Crash promise: an authenticated, lazily updated durable-size watermark** (5.6). A unit with no valid slot below the watermark fails with `io` (erasure detected); above it, it reads as zeros (crash). Rollback protection stays a separate issue (non-goals).
- **O3 (Q4) Switch: a Tenant/platform setting rendered into the workload, in the first implementation** (9.1): `spec.storage.integrity` (`Off` | `AEAD`), immutable once a workload storage directory is recorded, rendered as `DI_PGLITE_INTEGRITY=1`, honoured only when encfs initialises an empty directory, refused with a lock and the `StorageIntegrity` condition on an existing directory. The codec-4 writer is in the default published build from the writer release on.
- **O4 (Q10) Migration: `pg_dump` and restore** into a freshly initialised integrity directory (10). The offline copy tool stays on #199. Mixed XTS/codec-4 directories are refused.

### 13.2 Engineering decisions

1. **Q1 Unit size: 8 KiB**, PostgreSQL's `BLCKSZ`, one slot write per page write.
2. **Q2 Slot alignment: compact 8256-byte slots**, with A1 stated at the device's atomic write unit (4, section 7). Padding to 512 bytes buys nothing on 4 KiB atomic units, and 4 KiB alignment would cost about 3×.
3. **Q3:** see O1.
4. **Q4:** see O3. The `DIPGKEY2` marker carries a flags bit set, and unknown bits fail closed (9.1).
5. **Q5 Nonces: a random 24-byte draw per slot and record write** (5.4).
6. **Q6:** see O2.
7. **Q7 Shrink inside a unit:** a `sync-data` between the truncate and the slot write (6.4 step 3), which also makes generation restarts safe. No journal.
8. **Q8 Cache bound: a per-file bitmap** (winner, pending, known bits; generation read from the verified slot), about 48 KiB per fully touched 1 GiB segment, with no per-unit eviction (6.1, 6.6).
9. **Q9 W0: a lazy `sync-data` per file on its first write in each instance**; any successful sync of that file in the instance counts (6.3).
10. **Q10:** see O4.
11. **Q11 identity-server#71:** ask on #71 that its custom-section parser accept unknown keys and a variable-length section, and treat `codec=` as informative, so `read-codecs=` and `integrity=` need no further gate. The request is posted by the lane that implements the writer release; it is not posted from this docs-only change.
12. **Q12 `data_checksums`:** out of scope here; tracked as a separate issue, to be filed. It cannot be enabled on existing clusters without an offline `pg_checksums` pass.
13. **Q13 Algorithm: XChaCha20-Poly1305.** Random 192-bit nonces remove the misuse concern that would favour AES-GCM-SIV, at lower CPU cost in Wasm.
14. **Q14:** see O2; rollback protection gets its own issue.
15. **Q15 Property tests: keep the hand-rolled `XorShift` generator**; no `proptest` dependency.
16. **Q16 Slot padding: unauthenticated and unwritten.** Short last units cost only their `len` in crypto.

### 13.3 Settled without change

- Nonce collision bound (about 2^-97 after 2^48 writes per key), the slot AAD (domain ‖ file id ‖ unit ‖ slot ‖ generation ‖ length ‖ reserved) and the per-file HKDF key, with the salt shared with the KEK derivation under distinct info strings, are sufficient against slot, unit and file swapping (5.2, 5.4).
- The `DIPGKEY2` fail-closed claim holds for markers of at least 24 bytes (9.1).
