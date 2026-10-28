# Design: crash-safe AEAD integrity mode with two-slot units (#200)

| | |
|---|---|
| Issue | #200 (follow-up to #199, refs #138) |
| Roadmap | v0.1 #499, epic E4 #497, lane T08, milestone `#200:design` |
| Status | **Design, revised twice after review on PR #530.** Owner decisions of 2026-10-28, the engineering answers and the decisions taken after the second review are recorded in section 13. No code changes. Implementation waits for this note to merge. |
| Related | #206 (codec 3, absorbs #244; its default flip waits on gate G04 = identity-server#71) |
| Crate | `platform/pglite-encfs`; the Tenant setting (9.1) also touches `platform/platform/src/tenancy` |

All `file:line` references are relative to `platform/pglite-encfs/` unless they start with `platform/platform/`. They were checked against `origin/main` `981fed0`; `platform/pglite-encfs` has not changed since `73cfb85`, which the first version of this note cited. References into `platform/tenant-auth/` start with that path.

## 1. Summary

This note specifies **codec 4**, an integrity mode for whole data directories:

- Each logical 8 KiB unit gets **two physical slots**. Each slot holds `generation ‖ length ‖ nonce ‖ tag ‖ ciphertext`, sealed with XChaCha20-Poly1305 under a per-file key.
- A read returns the **newest slot that authenticates**.
- A write never touches the slot that holds the unit's last durable version. A torn write can then only destroy the version being written, so **every unit write is atomic**, and fsynced data survives any torn write.
- On a cold cache the writer authenticates the pair before it picks a target, so a torn slot that claims a newer generation can never steer a write onto the durable slot (6.3, C13).
- A random 192-bit nonce per slot write keeps nonces unique across crashes and retries.
- Each file carries an authenticated, lazily updated **durable-size watermark** (5.6) in its own 4 KiB page after the header. A unit below it that has no valid slot was erased, and the read fails with `io`. A unit above it may legitimately have no valid slot after an ordinary crash, and it reads as zeros, as an unsynced plaintext extension does.

Codec 4 is a new codec id in the existing header format. It does not change codecs 2 and 3, the #206 rollout, or the G04 flip. A directory is either all XTS (codec 2/3) or all codec 4, and every file in an integrity directory uses two slots (O1). An integrity directory carries a new root marker, so older builds refuse the whole directory before they touch anything. Integrity is switched on by a Tenant setting that the platform renders into the workload's storage: a platform-run init step writes an **integrity reservation marker** into a new, empty directory before the host starts, and encfs initialises an integrity directory only from that marker (O3). No tenant-writable input (environment variable, ConfigMap, Secret) selects the mode. The platform records each storage key's mode from what the init step observes on disk, so the record is authoritative per directory. Existing directories move to codec 4 only through `pg_dump` and restore into a freshly initialised directory, which can be a new storage key of the same Tenant (O4).

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
- **Changing the default** for any deployment. Integrity is chosen per Tenant and applies only to storage keys first recorded after it is set (O3, 9.1).
- **Cross-unit atomicity.** A write that spans units is atomic per unit, not as a whole, as with plaintext pages.

## 4. Assumptions

- **A1 Atomic write units.** Two separate facts, both needed:
  - **Tears happen at the device's atomic unit.** After a power loss, each aligned atomic unit of the device that an in-flight write touches holds either its old or its new contents. That unit is 512 bytes on many devices (common NVMe drives report an atomic write unit of one logical block, AWUPF 0) and 4 KiB on 4Kn devices. This is the model `scripts/lib/tear.ts:1-8` uses at 512 bytes, and the one PostgreSQL relies on for `pg_control`.
  - **Writes are widened to the writeback block.** Linux page-cache writeback sends whole 4 KiB pages to the device. The bytes of such a page that the write did not cover come from the page cache. A widened write can still tear at every device atomic unit inside it; widening does not make the 4 KiB page atomic.

  The design's argument works at any atomic-unit size, and the harness tests 512 bytes and 4 KiB (12.2). Section 7 ("Shared atomic units") shows why codec 4 needs nothing finer.
- **A2 Tears stay inside the touched units.** Device atomic units that no in-flight write (widened as above) touches keep their contents. Bytes of a touched unit that the write does not cover are, by A1, either their on-disk value or the page-cache value written with the widened page. For bytes of a **durable** neighbour, a slot or watermark record that holds a version made durable by a completed sync and not written since (6.2 never targets such a slot), the page cache equals the disk, so the two are identical. For bytes of a **pending** neighbour, written since the last sync, the page cache may differ from the disk, so a tear can expose a mix of that neighbour's own unsynced write. The neighbour then fails authentication and its unit falls back to its durable slot, which C2 already allows for an unsynced version.
- **A3 Honest sync.** When host `sync` or `sync-data` returns success, everything written to the file before it is durable. Two host facts bound this:
  - On macOS, `fsync` does not flush the device cache without `F_FULLFSYNC`. The platform runs on Linux; a macOS development host does not meet A3, and its crash results prove nothing.
  - On Linux, after writeback fails with `EIO`, a later `fsync` can return success for pages that were never written. The design relies on PostgreSQL treating an fsync failure as fatal (`data_sync_retry = off`, the default): it PANICs and recovers from WAL. encfs adds its own fail-stop: after a host `sync` or `sync-data` of a file fails, every later write to that file fails with `io` until the instance restarts (6.6).
- **A4 Single writer.** One encfs instance owns a data directory, the exclusive ownership pglite already requires (`src/component.rs:10-12`). Per-file state may be cached in memory. It is keyed by the file id **and** the host identity of the inode (6.1), because a host-level copy of an encfs file within one volume produces two inodes with the same file id.
- **A5 No ordering between unsynced operations.** The design assumes no order between unsynced writes, extensions or `set_size` calls on the same file, on any filesystem (including ext4 `data=writeback` and delayed allocation). Writeback may persist a later range of an extension before an earlier one, and a size change before or after the data around it. Only a completed sync orders anything (A3). Where the protocol needs an order, it syncs: once per file per instance before its first write (W0), and after every shrink before the next write (6.4).

The first version of this note assumed ordered size updates (old A5). Review showed that this does not exclude interior units without a valid slot after an ordinary crash (C1 of the review), so the assumption is withdrawn. The watermark (5.6) replaces it.

## 5. On-disk format of codec 4

### 5.1 Header and codec id

- **Header:** unchanged: same 152 bytes, format version 1, **codec byte 4** (`src/header.rs:7-17`). The codec byte stays in the wrap's AAD, so a file cannot be relabelled between codecs without the key (`src/header.rs:315-327`).
- **Layout of a codec-4 file:** `[header page: 4096][watermark page: 4096][pair 0][pair 1]...`. The header page is the same 4 KiB block as today, zero after byte 152. The **watermark page** at bytes 4096..8192 holds the two watermark records (5.6), record 0 at 4096..4160 and record 1 at 6144..6208, each in its own 512-byte sector; the rest of the page is zero and ignored. Pairs start at byte 8192.
- **Why a separate page.** Record writes are routine (one per sync interval per written file, 5.6), while the header is written once and rewritten only by a rare key rotation. With the records in their own page, no record write ever rewrites, widens into or shares a device atomic unit with the header, at 512 bytes or at 4 KiB, so the wrapped DEK is outside the blast radius of every record write (section 7). Rotation writes only bytes 0..152 of the header page (`src/component.rs:590-593`), so it never touches the records. The page costs 4 KiB per file (11).
- **Codec 1 stays retired.** It was the spike's AEAD layout, so reusing it could make leftover spike files parse.
- **DEK:** unchanged: 64 random bytes per file (`src/header.rs:44-45`). Codec 4 derives two 32-byte keys with HKDF-SHA256 (`ikm = DEK`, `salt = "di-framework/encfs/v1"`, the salt the KEK derivation uses, `src/keys.rs:36`, under distinct info strings): `aead_key` with info `"codec4-aead"` for slots, and `wm_key` with info `"codec4-watermark"` for watermark records. The XTS key halves have no meaning in codec 4. HKDF instead of `DEK[..32]` keeps a future Merkle or MAC key (rollback protection) derivable from the same DEK.

### 5.2 Units and slots

- **Unit size 8192** logical bytes, separate from XTS's 4096 (`src/codec.rs:41`). 8 KiB matches PostgreSQL's `BLCKSZ` and `XLOG_BLCKSZ`, so a relation, SLRU or WAL page write is exactly one slot write (Q1).
- **Slot:** a 64-byte slot header followed by an 8192-byte ciphertext area, **8256 bytes** in total. Slots are compact, not padded to sector or page boundaries (Q2, section 7).
- **Pair:** unit `u` owns slot A at `8192 + u × 16512` and slot B at `8192 + u × 16512 + 8256`. A pair is 16512 bytes. The stride is fixed, so the position of every unit is known without reading anything. Because 8192 is a multiple of 4096, the alignment of every slot is the same as it would be after a single 4 KiB header (section 7).

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

**Cost and caching.** The size of a codec-4 file needs the header page and the watermark page (one contiguous 8 KiB read) and the last pair (one read of up to 16512 bytes), plus one more pair read per dropped trailing pair. encfs caches the size in the per-file state (6.1), so `stat` on an open descriptor costs nothing after the first computation. `stat-at` by path has no descriptor and no file id. It first calls the host's `metadata-hash-at` (one host call, already passed through at `src/component.rs:1182-1194`) and looks the size up by host identity (6.1). Only on a miss does it open the file and pay the 8 KiB header-and-watermark read and the last-pair read, then cache the result. Section 11 counts this.

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

**Records.** Two 64-byte records in the watermark page (5.1), record 0 at byte 4096 and record 1 at byte 6144:

| record bytes | field | notes |
|---|---|---|
| 0..8 | `seq`, u64 LE | 0 = never written |
| 8..16 | `durable_units` (`D`), u64 LE | |
| 16..40 | `nonce`, 24 bytes | random per record write |
| 40..56 | `tag`, Poly1305 | XChaCha20-Poly1305 seal of an empty plaintext under `wm_key` |
| 56..64 | reserved, zero | authenticated |

- **AAD** = `"DIPGWM04"` ‖ file id ‖ record index (u8) ‖ record bytes 0..16 ‖ record bytes 56..64. A record cannot be moved to the other position, to another file or into a slot.
- **Selection.** A record is valid if it lies entirely within the host file, `seq ≠ 0`, the reserved bytes are zero and the tag verifies. The watermark is the valid record with the higher `seq`; equal `seq` in two valid records is `io`.
- **Birth.** When encfs seals a codec-4 header, it writes the header page and the watermark page as one 8 KiB block, with record 0 set to `seq = 1, D = 0`, and syncs it before any pair is written, as it does for the 4 KiB header block today (`src/component.rs:351-356`).
- **Interrupted birth.** A crash before that sync may leave the header page without the watermark page, or with record 0 torn (A5 orders nothing before a sync). No pair can exist then, because pairs are written only after the birth sync. So a codec-4 file with a valid header, no valid record and a host size of at most 8192 bytes is an interrupted birth: it reads as empty with `D = 0`, and its first write re-seals record 0 (`seq = 1, D = 0`) in the watermark page and syncs, before any pair, exactly as a birth does. This is the codec-4 analogue of the existing fresh-header rule (`src/header.rs:78-113`).
- **No valid record with a pair present** (host size above 8192) fails the file with `io`. It cannot arise from a crash: the birth sync made record 0 durable before any pair existed, and the record that holds the last durable value is never the target of a write.

**Two-slot rule for records.** Record writes follow the same durable-slot rule as units (6.2), with one file-level `wm_pending` bit: while `wm_pending` is set, a record write overwrites the pending record; when it is clear, it writes the other one. A torn record write fails authentication and the reader falls back to the other record, which holds the last durable watermark. The new `seq` is the winner's `seq + 1`. A record write is one 64-byte `pwrite` into its own 512-byte sector of the watermark page; it never touches the header page or a pair.

**Advancing.** `D` only ever claims units whose data was durable before the claim was written:

1. When a host `sync` or `sync-data` of the file succeeds (6.3 "Sync"), encfs computes a candidate `D'`. It starts at the current `D` and extends over consecutive units `u` that have a valid winner known in the per-file state, are not pending (the sync just cleared them) and lie inside the logical size. The new candidate **replaces** any candidate not yet written; it is never merged with an older one by taking the maximum.
2. A unit above `D` without a `known` valid winner blocks the extension until it is verified. That covers units this instance has not touched, and units it touched whose entry was dropped because they have no valid slot (6.6 (e)). At each successful sync encfs verifies at most 256 such pairs (4 MiB of reads), in order. A verified pair with a valid winner extends `D'`. A pair with no valid slot is a hole, from an earlier crash (C14) or from a failed write (6.6 (e)); it already reads as zeros, so encfs writes a sealed zero unit into it (generation 1, slot A, through the write path). The visible content does not change, and the unit joins `D'` after the next sync. A hole stays a hole, and keeps blocking `D`, only until that fill or a rewrite of the unit is synced.
3. If `D' > D`, encfs writes the new record **lazily**: with the next write to that file, as one extra 64-byte `pwrite` after the unit writes, or, if no write comes first, immediately before the host call of the next `sync` or `sync-data` of that file, which then makes it durable. The record write itself is pending (`wm_pending = true`) until the next successful sync. Nothing is written when a descriptor is closed or the file's state is dropped: a clean file's unwritten candidate is simply discarded with its state, which leaves the older, lower `D` in force and only delays erasure detection for the units of the last sync interval until the file is written or synced again. So the watermark adds no fsync and never leaves a closed, clean file dirty: a record written before a sync is made durable by that same sync.

A crash before the record write, or one that tears it, leaves the previous `D`, which is lower and still true. A record never claims more than was durable, so `D` is safe at every crash point.

**Lowering.** A shrink discards any unwritten candidate `D'`, lowers `D` to the new number of units before it truncates, and syncs before the next write (6.4). A candidate computed before a shrink can therefore never be written after a later re-extension.

**What the watermark costs and leaves out.** 4 KiB of space per file (the watermark page), one 64-byte write per sync interval per written file, and at most 256 pair reads per sync while `D` catches up after a restart. Units written since the last advance are protected against crashes, not against erasure (non-goals). Replaying an older record lowers `D`; that is rollback (Q14).

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
6. **W5, write.** One host `pwrite` per unit, at the target slot's offset, `64 + len` bytes. WASI 0.2 has no `pwritev`, and slots of neighbouring units are not contiguous, so a multi-unit write costs one host call per unit (11). The exception is an extension: the slot-A images of new units and the zero slot-B gaps between them are contiguous and go out as one `pwrite`. This is an optimisation only; nothing depends on the order in which those bytes reach the disk (A5, C14). If a lazy watermark record write is due (5.6 step 3), it is one more 64-byte `pwrite` into the watermark page after the unit writes.
7. **W6, update the state.** Set `winner = target`, `pending = true`, `known = true`, `dirty = true`, and update the size. If W5 failed, follow 6.6 (e) instead.

**Sync.** `sync` and `sync-data` still pass through (`src/component.rs:1041-1043`, `src/component.rs:1087-1089`). If a candidate watermark from the previous sync is still unwritten, encfs first writes its record (5.6 step 3), so this sync makes it durable. When the host call succeeds, encfs clears every `pending` bit of that file, clears `wm_pending` and `dirty`, sets `synced_once`, and computes the next candidate watermark, replacing any older one (5.6). On failure it sets `failed`, changes nothing else, and returns the error (A3).

**Barriers.** Codec 4 adds exactly two kinds of fsync: W0, once per written file per instance, and one after each shrink (6.4). Otherwise it imposes no ordering between writes, and correctness rests on the invariant, the watermark and A1–A4.

### 6.4 Resizes

No resize relies on the filesystem ordering a size change against data (A5).

- **Append inside the last unit:** a single slot write with the larger `len`, so it is atomic (G4).
- **Append that adds units:** write the last unit with `len = 8192`, then the new units. They may reach the disk in any order (C7, C14).
- **Grow with `set_size`:** zero-fill through the write path, as today (`src/file.rs:136-141`).
- **Every shrink** follows three steps:
  1. **Lower the watermark.** Discard any unwritten candidate `D'`. If `D` exceeds the number of units that remain (`k` for a shrink to a unit boundary at `k × 8192`, `k + 1` for a shrink to inside unit `k`), write a record with the lower `D` (5.6, two-slot rule).
  2. **Truncate.** Host `set_size` to the end of the last remaining pair: `8192 + k × 16512` for a unit boundary, `8192 + (k + 1) × 16512` for a shrink inside unit `k`. A truncate to 0 is `set_size(8192)` and keeps the header page and the watermark page, as XTS keeps its header today (`src/header.rs:27-28`).
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
- **(e) W5 fails** (`ENOSPC`, a short write, any host error): the target slot now holds unknown bytes. The host may even have written all of them before it reported the error. encfs does not guess which: it re-reads the pair, re-selects (5.5), and records
  - `winner` = the re-selected winner, and
  - **`pending = (re-selected winner == failed target)`**.

  This holds whether or not the failed write landed, and whichever slot was targeted:
  - The failed target is never the slot that held the durable version (6.2). So if re-selection picks the target, its bytes landed but were never synced, and `pending = true` makes the next write overwrite it, never the durable slot.
  - If re-selection picks the other slot, that slot is the one 6.2 protected. It holds the durable version, or, when `pending` was clear, the unchanged durable winner. `pending = false` is then true, and the next write targets the failed slot again (6.2, "the other slot"), with a fresh nonce.
  - If the target was the pending winner and its version did not land, a read returns the **durable** version, so the last acknowledged unsynced write to that unit disappears in a live instance. That is acceptable: the failed write returned an error, PostgreSQL keeps the page dirty in shared buffers and retries the write with the newest contents, and a failed WAL write PANICs.
  - If re-selection finds **no valid slot** (a new unit whose first write failed), there is nothing durable to protect: the entry is dropped (not `known`), the unit reads as zeros above `D`, and 5.6 step 2 treats it as a hole.
  - If the re-read itself fails, the entry is dropped and `synced_once` is cleared, so the next write to the file runs W0 and syncs before it trusts any bit again.
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
| C8 | write of a fresh file's first unit, header and watermark page synced | header, record 0, plus a torn or absent slot A | an empty file (`D = 0`). The header still follows the fresh/sealed rules (`src/header.rs:78-113`) |
| C8a | birth of a codec-4 file, before its sync | header page present or not; watermark page absent, zero or torn | zero header: fresh. In an integrity directory every file is codec 4, so the "no room for data" bound of `classify` (`src/header.rs:102-104`) is 8192 there instead of 4096. Header without a valid record, size ≤ 8192: an interrupted birth, read as empty with `D = 0`; the first write re-seals record 0 and syncs (5.6) |
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

- Pairs start at byte 8192, a multiple of 4096. The pair stride is 16512 = 32 × 512 + 128 and the slot size 8256 = 16 × 512 + 64. Slot A of unit `u` starts at an offset ≡ 128·u (mod 512) and slot B at ≡ 128·u + 64 (mod 512). Slot A starts on a 512-byte boundary only for `u ≡ 0 (mod 4)`, slot B never; at 4 KiB granularity slot A starts on a boundary only for `u ≡ 0 (mod 32)`.
- So nearly every slot boundary lies inside an atomic unit: slot A of `u` shares one with slot B of `u`, and slot B of `u` shares one with slot A of `u + 1`. A slot write therefore rewrites an atomic unit that also holds the edge of a neighbouring slot, which may belong to another unit and may be that unit's durable slot. With 4 KiB units, the shared unit holds up to 4032 bytes of the neighbour.
- **Under A1 this is safe at any granularity.** A durable neighbour's bytes inside the shared unit are identical in the old and the new image of that unit: the write does not cover them, and the page cache, which supplies them for a widened write, equals the disk for a slot not written since the last sync (A2). Old-or-new of the whole unit therefore leaves a durable neighbour's bytes as they were. A pending neighbour may come back as a mix of its own unsynced write, fails authentication and falls back to its unit's durable slot (A2, C2). The argument does not depend on the size of the atomic unit, only on A1 holding at whatever size it is.
- **If A1 fails** (a unit returns neither its old nor its new contents, for example a device that garbles sectors in flight), the target fails authentication as in C2, **and whatever shares the damaged atomic unit can be damaged too**. The blast radius of each kind of write is:
  - **A slot write:** the neighbouring slots inside its first and last atomic units, or, when writeback widens it (A1), inside its first and last 4 KiB pages. If such a neighbour is a durable slot, its unit has lost its durable version. Codec 4 then reports `io` for it below `D` (or zeros above it) instead of returning wrong data. A slot write never reaches the header page or the watermark page, because pairs start at 8192.
  - **A watermark record write:** the watermark page only. Writeback widens a record write to the whole watermark page (A1), so the other record is in flight too and can be damaged, whatever the device's atomic unit; only a device written without page-cache widening and atomic at 512 bytes keeps it out of reach. With both records invalid and pairs present, the file fails with `io` (5.6): detected, never wrong data. The header, and with it the wrapped DEK, is on a different page and out of reach. The header page is in flight only during a birth or a rotation, not during routine record writes. Recovering such a file (re-sealing record 0 with `D = 0`, which restarts erasure detection) is an explicit operator step for a future repair tool, not something encfs does on its own.
  - **A header write** (birth, rare rotation): the header page only, as today.

  Plaintext and XTS lose the same bytes silently, and PostgreSQL's `pg_control` has the same dependency. This note does not claim more than A1.
- **Padding does not remove the dependency.** Padding slots to 8704 bytes (17 sectors) would align them only to 512 bytes, which buys nothing where the atomic unit is 4 KiB. Independence there needs slots padded to 12288 bytes, about 3× the data. Neither is adopted (Q2).
- The watermark records live in their own page (5.1), so no record write shares an atomic unit with the header or a slot at either granularity. The records share the watermark page with each other at 4 KiB, and the argument above covers that: a record holding the durable `D` is not written while it is durable, so its bytes are identical in both images.

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

Integrity is per directory and chosen once, when the directory is initialised. The owner decided (O3) that the first implementation switches it on through a **Tenant setting that the platform renders into the pglite workload's storage**, not through a build flag alone. The first revision of this note rendered the setting as an environment variable. The second review showed that tenants can set that variable too, and that the per-Tenant record missed directories that exist on disk (W1 and W2 of the second review), so this section was redesigned.

**Why not an environment variable.** A tenant can put a variable into a guest's environment through paths that go through neither the controller nor tenant-auth:

- The `di-developer` Role can create and update WorkloadDeployments, ConfigMaps (including `di-vars-<env>`) and Secrets (including `<workload>-secrets`) directly (`platform/platform/src/tenancy/resources.ts:1108-1124`). `<workload>-secrets` is written by the app's own tooling (`platform/tenant-auth/README.md:399-400`).
- A WorkloadDeployment may carry inline `localResources.environment.config` variables (`platform/platform/tests/workload-storage.test.ts:82`). tenant-auth's `inject` passes a bundle's `environment` through and replaces only `configFrom` and `secretFrom` (`platform/tenant-auth/src/v1/deploy.ts:237-262`), and the WorkloadDeployment policy constrains only those two references (`platform/platform/src/tenancy/admission.ts:717-728`).

Reserving the name would need a CEL rule for inline config, new policies on `configmaps` and `secrets` in every tenant namespace, a duplicate-variable rule in encfs, and a statement about how wasmCloud merges the three sources. Every new configuration source would reopen the gap. The design instead takes the mode out of the guest's environment altogether. **No environment variable selects the mode.**

**Overview.** The platform reserves, the marker decides, and observation records:

1. **Setting.** `spec.storage.integrity` on the `Tenant` CRD selects the mode for storage keys the platform has not recorded yet.
2. **Reservation.** Before the tenant host starts, a platform-run init step writes an **integrity reservation marker** into each new, empty directory whose key is recorded as `AEAD`.
3. **Decision.** encfs decides from the root marker alone. A reservation in a root without data initialises an integrity directory; every other root decides as today.
4. **Observation.** The same init step classifies every directory of the Tenant on the node, and the controller records each key's actual mode from that.

**Tenant field.** `spec.storage.integrity` (`platform/platform/src/tenancy/resources.ts:47-66` for `TenantSpec`, `platform/platform/src/tenancy/resources.ts:803-830` for the schema):

- enum `Off` | `AEAD`, default `Off`, inside a new `storage` object with `default: {}`, following the style of `deletionPolicy` (`Retain` | `Delete`);
- it applies to the Tenant's workload storage directories (`di-framework.dev/persistent-storage`, `platform/platform/src/tenancy/workload-storage.ts:1-11`), the directories that pglite workloads use for their data;
- it is an operator setting: tenant users have no Role on Tenant objects, and the per-tenant controller may only `get` its own Tenant (`platform/platform/src/tenancy/resources.ts:2140-2142`);
- it may change at any time. A change applies only to keys recorded after it; recorded keys keep their mode (below).

**The init step.** The tenant host pod already runs a platform-rendered init container, `storage-owner`, with a fixed image and every storage directory mounted, before the host container starts (`platform/platform/src/tenancy/workload-storage.ts:106-150`, placed in the host pod at `platform/platform/src/tenancy/resources.ts:1479-1489`). The host pod lives in the tenant's runtime namespace, where tenant users can only read pods and logs and port-forward (`platform/platform/src/tenancy/resources.ts:1139-1151`), so no tenant can change its spec or arguments. A second init container, `storage-mode`, runs after `storage-owner`:

- **Identity.** It uses the same fixed image and runs as the host uid (65532, `HOST_UID`) with no capabilities. `storage-owner` has already handed each directory to that uid; root without `CAP_DAC_OVERRIDE`, which `storage-owner` does not have, could not write into it.
- **Mounts.** The same per-key mounts as `storage-owner`, plus the Tenant's workloads root `<storageRoot>/di-tenants/<tenant uid>/workloads` (`nodeStoragePath`, `platform/platform/src/tenancy/workload-storage.ts:98-100`), mounted read-only. That root covers only this Tenant's directories.
- **Arguments.** The keys to reserve, rendered by the controller: every mounted key whose record selects `AEAD` (below). The list changes only when a key is first mounted, which already changes the host pod's volumes and rolls it.
- **Reservation.** For each key on that list whose directory is empty, ignoring `lost+found` and the marker names as `is_volume_metadata` does (`src/marker.rs:26-28`), it writes the reservation marker to `.di-encfs.tmp`, syncs it and renames it over `.di-encfs`. That is the discipline `write_marker` uses (`src/component.rs:479-497`), so the marker is never partial. The step never writes into a non-empty directory and never changes an existing marker. If a reservation cannot be written, the step exits non-zero and the host does not start, so a key selected as `AEAD` is never handed to a guest unreserved.
- **Observation.** It lists every directory under the workloads root whose name is a valid storage key, plus every mounted key. It classifies each one from the marker's magic, length and flags only, never reading data files or key material: `empty`, `unencrypted` (entries, no marker), `xts`, `aead`, `reserved` (a reservation and nothing else) or `other`. It prints one line per directory and a final `done count=N`.
- **Reporting.** The controller reads that output with `pods/log` once per host pod uid and checks the count. It holds `pods/log get` cluster-wide (`platform/platform/src/tenancy/install.ts:198-202`, `platform/platform/src/tenancy/controller.ts:387-391`) and already lists the tenant's host pods (`platform/platform/src/tenancy/controller.ts:445-458`). Logs have no size limit that matters here, unlike a 4 KiB termination message. The output names only directory names and classes, which tenant users can already read through `di-runtime-viewer`.

A key's directory reaches a guest only through a host pod whose spec mounts it (`platform/platform/src/tenancy/resources.ts:1085`, `platform/platform/src/tenancy/workload-storage.ts:110-150`), and then through the controller's storage patch (`storagePatch`, `platform/platform/src/tenancy/workload-storage.ts:181-214`, applied by `reconcileWorkloadStorage`, `platform/platform/src/tenancy/controller.ts:2255-2272`). So every new directory passes through the init step before any guest can open it. `storagePatch` itself does not change: it renders no variable.

**Records.** `status.storage.directories[]` holds one entry per storage key, `{ key, requested, integrity, observed }`:

- **`requested`** (`Off` | `AEAD`): the controller writes it from `spec.storage.integrity` **before** it renders a host pod that mounts the key (write-ahead). It is absent on an entry created from the listing.
- **`integrity`** (`Off` | `AEAD`): the directory's actual mode, set once from the init step's first report on a mounted key, which the step makes after any reservation: `aead` and `reserved` give `AEAD`; `xts` and `unencrypted` give `Off`; an `empty` directory the step did not reserve gives `Off`, because without a reservation encfs initialises XTS. `other` leaves it unset and raises the condition below. Until the first report it is unset.
- **`observed`**: the latest classification, updated after every host pod start.

A directory found by the listing that has no entry and is not `empty` gets an entry with `integrity` set from its observation. Examples are a key whose workloads were deleted before the writer release, or one deleted since. An empty, unrecorded directory gets no entry; it is free until a workload asks for that key. This is the backfill: it covers every directory on the node, not only those of deployed workloads. At the writer release the host pod template gains `storage-mode`, so every Tenant's host pod rolls once and lists its directories.

**Precedence**, highest first, for what an empty directory becomes:

1. **The directory's contents.** The platform never changes an existing marker or a non-empty directory, and encfs decides from the marker (table below). A non-empty directory keeps its mode whatever a record or the spec says.
2. **The key's recorded `integrity`**, once set.
3. **The key's recorded `requested`**, while `integrity` is unset.
4. **`spec.storage.integrity`**, read only at the moment a key is first recorded.

The init step reserves a key exactly when its directory is empty and the first of `integrity` and `requested` that is set says `AEAD`. Nothing a tenant writes appears on this list. If a guest's environment carries a variable named `DI_PGLITE_INTEGRITY`, encfs logs that the mode is chosen by the platform and ignores it.

**Per-key immutability.** A ValidatingAdmissionPolicy on `tenants/status` protects the records. It gets its own binding, because Tenant is cluster-scoped and the existing tenancy policies bind only tenant namespaces (`platform/platform/src/tenancy/admission.ts:490-510`). On every update, the controller's included, it requires three things:

- every old entry is still present, with the same `key` and `requested`;
- an `integrity` that was set is unchanged;
- a new entry is added only with `requested` or `integrity` set.

Records are therefore never pruned while the Tenant exists. Directories are keyed by the Tenant's uid (`platform/platform/src/tenancy/workload-storage.ts:98-100`), so a recreated Tenant gets new directories and starts with no records. No Tenant-level rule on `spec.storage.integrity` is needed, because a spec change cannot reach a recorded key. The first revision's policy refused any change once a directory existed. That made O4's migration need a whole new Tenant. Per-key records allow migration to a new key of the same Tenant instead (section 10).

**Condition** `StorageIntegrity` on the Tenant:

- `Unknown`, reason `AwaitingObservation`, while the current host pod's listing has not been read, or a mounted key still has `integrity` unset. This is the state from the writer release until the first listing, and after each new key until its host pod start is reported.
- `False`, reason `IntegrityNotApplied`, naming the keys whose `integrity` differs from their own `requested`: the key was requested as `AEAD`, but its directory already held XTS or plaintext data. The directory keeps its mode, and section 10 is the way to migrate it. This replaces the first revision's `IntegrityLocked`.
- `False`, reason `IntegrityMismatch`, naming the keys whose `observed` class contradicts their recorded `integrity`, for example an `AEAD` directory now observed as `xts`, `unencrypted` or `other`, an `Off` directory now observed as `aead`, or a mounted key observed as `other`. Something other than encfs rewrote it (see "What a tenant can do" below).
- `True`, reason `AsRecorded`, otherwise. Keys recorded `Off` under a spec that now says `AEAD`, as after a migration, are expected and are not a condition. `status.storage.directories` lists them.

**What encfs does with the marker.** It reads the root marker once, at the root decision (`src/marker.rs:192-221`). Every row assumes a configured key; without one the root locks as `NoKey`, as today. The rows are disjoint: each root falls into exactly one marker form and one data column.

| root marker (`.di-encfs`) | root has data | decision |
|---|---|---|
| absent | no | initialise an XTS directory, as today |
| absent | yes | `Unencrypted` lock, as today |
| shorter than 24 bytes | no | initialise an XTS directory, as today (`src/marker.rs:203-205`). A reservation is written by rename and is never short |
| shorter than 24 bytes | yes | `CorruptMarker` lock, as today |
| `DIPGKEY1 ‖ KCV`, 24 bytes | either | XTS: the KCV decides `Ready`, `Rotate` or `WrongKey`, as today |
| `DIPGKEY2` reservation: 25 bytes, zero KCV, flags `0b11` | no | initialise an **integrity** directory: replace the reservation with the keyed `DIPGKEY2` marker (temporary file and rename), then proceed |
| `DIPGKEY2` reservation | yes | lock with the new `Lock::ReservedWithData`. Something other than encfs wrote into a reserved directory |
| `DIPGKEY2 ‖ KCV ‖ flags`, 25 bytes, flags `0b01` | either | integrity: the KCV decides `Ready`, `Rotate` or `WrongKey` |
| anything else: another magic or length, `DIPGKEY2` with other flags, or a reservation with a non-zero KCV | either | `CorruptMarker` lock, fail closed |

"Root has data" means any entry other than `lost+found` and the marker names (`src/marker.rs:26-28`, `src/component.rs:469`). The mode is never read from anywhere but the marker, so there is no case in which a request for integrity meets an existing XTS directory, and the first revision's `Lock::IntegrityRequested` is dropped.

**Marker.** XTS directories keep `DIPGKEY1 ‖ KCV`, 24 bytes (`src/marker.rs:16-17`). Integrity directories get `DIPGKEY2 ‖ KCV ‖ flags`, 25 bytes. `flags` is a bit set: bit 0 = codec 4, bit 1 = reservation (the KCV is unset and must be zero); any other bit fails closed (Q4).

- **The reservation** is a constant 25-byte string, `DIPGKEY2`, 16 zero bytes and `0x03`. It carries no key material, so the platform can write it without the Tenant's key.
- **Format constraint: every `DIPGKEY2` marker, the reservation included, must be at least 24 bytes (`MARKER_LEN`) long.** Builds without codec 4 re-initialise a marker shorter than 24 bytes in a root without data (`src/marker.rs:203-205`), which would overwrite the integrity marker. At 24 bytes or more they lock it as `CorruptMarker`, because the magic differs (`src/marker.rs:206-207`). `read_marker` reads at most 25 bytes, so a longer marker is seen as 25 bytes and also locked (`src/component.rs:452-466`).
- **Hidden from pglite.** encfs refuses the marker names to pglite (`src/marker.rs:39-41`), so a guest that runs encfs cannot remove a reservation before encfs reads it. `open_root` runs in `get_directories` before pglite gets a descriptor (`src/component.rs:847-866`).

**Older builds fail closed (G6).** A build without codec 4 locks both an integrity directory and a reservation as `CorruptMarker`, before anything is written (`src/marker.rs:192-221`). No codec-4 file is ever opened by a build that cannot read it, and no build initialises an XTS directory in a reserved one. That differs from codec 3's rollback, which relies on PostgreSQL panicking on the first codec-3 file (README "Codecs and migration"). The lock message says "corrupt", which is misleading, but that cannot be changed for builds already deployed. The codec-4 release's message names the mode instead.

**What a tenant can do.** Nothing a tenant writes selects the mode. The platform cannot stop a tenant from running its own code against its own directory: the guest component is the tenant's. A guest built without encfs, or with a modified encfs, can delete a reservation or write any bytes into the directory. That affects only the tenant's own data, and it cannot make the record wrong silently. The next host pod start observes the directory, and the condition reports `IntegrityMismatch`, or `IntegrityNotApplied` for a key whose `integrity` was still unset. A stale encfs pin, older than the reader release, locks a reserved directory instead of initialising XTS there. That holds whether the WorkloadDeployment came through tenant-auth or straight from kubectl, so no deploy-time version check is required. One is still useful for an earlier error message (9.3, Q11).

**Outside the platform** (local development, `make smoke`, other hosts), an integrity directory is created by writing the 25 reservation bytes as `.di-encfs` into an empty directory before the first start. A CLI helper for this is a follow-up in the CLI plugin's repository.

**The codec-4 writer is in the default published build.** Because a Tenant setting can turn integrity on, every published encfs build from the writer release on (9.3) contains the codec-4 writer; there is no `write-codec-4` cargo feature. The build still creates XTS directories unless a reservation asks for integrity, so this changes no default.

**Rotation must keep the mode.** `write_marker` currently encodes only the KCV (`src/component.rs:481-497`). The rotation sweep must rewrite a keyed `DIPGKEY2` marker with its flags. A reservation is never rotated: encfs replaces it at initialisation, before any key could be rotated.

**Inside an integrity directory**, every new file is codec 4, and an XTS file is refused with `io`. A fresh directory has none; they can only be copied in.

**Node-local directories.** Storage directories are hostPaths on the node that runs the single host replica (`platform/platform/src/tenancy/controller.ts:2243-2248` refuses storage for more than one replica). The listing reports that node's directories. If the host pod moves to another node, an empty directory there is reserved according to its key's record, so the record stays consistent. Moving data between nodes is outside this note, as it is for #11 today.

### 9.2 Code that changes when this is implemented

In `platform/pglite-encfs`:

- `src/codec.rs`: `Codec::TwoSlotAead = 4` in `id` and `from_id`. Codec 1 stays rejected.
- `src/header.rs`: parse accepts 4. Update the tests that assert 4 is unsupported (`src/header.rs:282-290`, `src/codec.rs:235-237`). In an integrity directory, `classify`'s "no room for data" bound is 8192 (`src/header.rs:102-104`, C8a).
- `src/file.rs`: it assumes a length-preserving layout throughout (`src/file.rs:3-5`, `src/file.rs:77-90`, `src/file.rs:153-209`). Codec 4 gets its own module (working name `src/slots.rs`) behind a small layout trait, so the XTS path and its fixtures (`src/file.rs:713-811`) stay byte-identical. The watermark page and its records live in the same module.
- `src/component.rs`: `guest_stat`, `stat` and `stat-at` stop deriving the size from the host size for codec-4 files (`src/component.rs:166-181`, `src/component.rs:1096-1106`); the per-file state keyed by (file id, `metadata-hash`) and the host-identity size cache (5.3, 6.1); writing a due watermark record before a sync, clearing pending bits and computing the next candidate after it; the `failed` fail-stop; sealing the 8 KiB header-and-watermark block with record 0 (`src/component.rs:341-364`).
- `src/marker.rs`: the keyed and reservation `DIPGKEY2` forms with their flags byte, `Lock::ReservedWithData`, the reader release's `Lock::IntegrityUnsupported` (9.3), and the table in 9.1. No environment variable is added, so `src/keys.rs` does not change.
- `Cargo.toml`: no new feature; the codec-4 writer is always compiled (9.1).
- `scripts/smoke.ts`: the codec census only accepts 2 and 3 (`scripts/smoke.ts:252-265`).
- `scripts/lib/tear.ts`: tears are cut at XTS page offsets after the header (`scripts/lib/tear.ts:34-81`). For codec 4 they must be cut inside the slot that changed.

**Cross-lane scope (future implementation, coordinate with T03 and T10).** The Tenant setting touches files that other lanes own:

- `platform/platform/src/tenancy/resources.ts`: `TenantSpec.storage.integrity`, the CRD schema, `status.storage.directories` with `{ key, requested, integrity, observed }`, and passing the reserve list and the workloads root into the host pod (`resources.ts:1085`, `resources.ts:1479-1489`);
- `platform/platform/src/tenancy/workload-storage.ts`: `hostStorage` gains the `storage-mode` init container and the read-only workloads-root mount (`workload-storage.ts:106-150`). `storagePatch` is unchanged;
- `platform/platform/src/tenancy/controller.ts`: write-ahead `requested` before a key is mounted, reading the `storage-mode` output per host pod uid, recording `integrity` and `observed`, and the `StorageIntegrity` condition;
- `platform/platform/src/tenancy/admission.ts`: the per-key policy on `tenants/status` with its own binding. No WorkloadDeployment, ConfigMap or Secret rule is needed, because no tenant-writable source carries the mode;
- `platform/tenant-auth`: nothing required. An optional deploy-time warning for a pin that does not advertise `integrity=1` needs the custom-section parser of Q11;
- the platform docs and the CLI plugin examples (including the reservation helper), in follow-up commits in their own repositories.

These changes ship in the writer release (9.3), not in the reader release.

### 9.3 Relation to #206 and G04

- **#206 does not wait for codec 4, and codec 4 does not wait for G04.**
  - G04 (identity-server#71 parses and enforces `write-codec`, and a reader-capable encfs is deployed everywhere) gates only flipping the XTS default from codec 2 to 3.
  - Codec 4 changes no default and no existing directory. Its rollback story is the marker (9.1), not the custom section.
  - The T08 order stays `#200:design` → #206.
- **Two-step rollout, as in #206:**
  1. **Reader release:** reads codec 4 and the keyed `DIPGKEY2` marker, but cannot create them. On a reservation in a root without data it locks with `Lock::IntegrityUnsupported` instead of creating an XTS directory.
  2. **Writer release:** the codec-4 writer in the default published build, plus the Tenant field, the `storage-mode` init step, the controller and the admission change (9.2). A Tenant can opt in from this release on.

  An integrity directory must never be opened by a build older than step 1. The marker makes that fail closed.
- **Custom section.** It is a fixed 40-byte `format=1 codec=aes-256-xts write-codec=N` today (`src/component.rs:64-75`). A codec-4-capable build also advertises `read-codecs=2,3,4 integrity=1`, so deploy tooling can warn early about a pin that cannot read a directory's mode. Correctness does not depend on it: such a pin locks a reserved or integrity directory (9.1). identity-server#71 is still open; the decision (Q11) is to ask it now to accept unknown keys and a variable-length section, so codec 4 needs no further gate.
- **Codec 4 removes the #206 problem only for integrity directories.** XTS directories still need codec 3 and its flip.

## 10. Migration and compatibility (O4)

- **Existing files are never converted in place, and directories are never mixed.** An XTS directory moves to integrity mode only by **`pg_dump` from the XTS instance and restore into a new instance whose directory was initialised empty in integrity mode**. This is the documented path at ship time. Within one Tenant it runs:
  1. An operator sets `spec.storage.integrity: AEAD` on the Tenant. Recorded keys keep their mode (9.1, per-key records), so nothing existing changes.
  2. The tenant deploys the new instance under a **new storage key**, a `di-framework.dev/workload` label value (or name) not used before (`storageKey`, `platform/platform/src/tenancy/workload-storage.ts:74-80`). The controller records it with `requested: AEAD`, the init step reserves its empty directory, and encfs initialises it as an integrity directory.
  3. `pg_dump` from the old instance, restore into the new one, and move traffic.
  4. Delete the old workload. Its directory and its `Off` record stay. Records are never pruned, and removing node data is outside this note.

  No new Tenant, namespace, API key or membership is needed. A new Tenant created with `AEAD` also works. The spec stays `AEAD` for every later new key unless the operator sets it back; that changes no recorded key.
- **The offline copy tool stays on #199** (README "Rotation" and "Codecs and migration"). Codec 4 does not wait for it.
- **Mixed directories are refused.** An XTS directory never gets codec-4 files for new data (9.1: encfs decides from the marker alone, and the platform reserves only empty directories), and an integrity directory refuses XTS files with `io`. A mixed directory could not claim G1.
- **Codec 2/3 fixtures** (`src/testdata/codec2`, `src/file.rs:713-768`) must keep reading and rewriting byte-identically. The XTS code path is not touched.
- **Downgrade:** a build that cannot read codec 4 sees an integrity directory, or a reservation, as `CorruptMarker` and locks it (9.1). Rollback after an integrity directory exists means rolling forward to a codec-4 reader, or restoring a pre-migration snapshot of the XTS directory.
- **Key rotation:** unchanged for headers (`src/header.rs:189-201`); it writes only the 152 header bytes of the header page, so the watermark page is never touched. The sweep must rewrite a keyed `DIPGKEY2` marker with its flags.
- **Interface:** the WIT package and the encfs exports are unchanged. The rollout is gated by the release steps, the markers, the init step and the Tenant setting.

## 11. Performance and space

These are estimates to be checked against the README benchmark, which the issue's acceptance requires. The README baseline is wasmtime 48, aarch64, ±20% (README "Performance").

**Space.** Every file in an integrity directory uses two slots (O1). The pair stride is fixed (5.2), and an extension writes the slot-A images together with the zero slot-B gaps between them (W5), so every unit but the last occupies a full pair from its **first** write:

- A file of `n` units has `st_size = 8192 + (n − 1) × 16512 + 64 + len(n − 1)` before its last unit's slot B is first written, and `8192 + (n − 1) × 16512 + 8256 + 64 + len(n − 1)` after. The first 8192 bytes are the header page and the watermark page (5.1). Allocated blocks track `st_size`, because the gaps and the watermark page are written, not left as holes.
- **Multi-unit files cost about 2.016× from their first write**, whether or not their pages are ever rewritten. Only the last unit, and therefore a single-unit file, costs about 1× plus the extra 4 KiB page (`8192 + 64 + len`, against XTS's `4096 + len`) until it is rewritten.
- **WAL segments double at creation.** PostgreSQL pre-zeroes each 16 MiB segment (2048 units), so a segment is `8192 + 2047 × 16512 + 8256 = 33,816,512` bytes (about 32.25 MiB) as soon as it exists, against 16 MiB plus 4 KiB with XTS.
- **README cluster** (1516 files, 32.9 MB plaintext, 40.0 MB with XTS): nearly all of the data sits in multi-unit files, so expect about 2.0 × 32.9 MB of data plus 1516 × 8 KiB = 12.4 MB of header and watermark pages, less the last-unit savings: **roughly 74–78 MB**, about 1.85–1.95× XTS. The separate watermark page adds about 6.2 MB of that (1516 × 4 KiB). The first version's 60 MB lower bound was too low.
- **Sparse gaps** (separate `pwrite`s per new unit, leaving slot-B regions as holes until first written) are not adopted. Only the whole 4 KiB pages inside an 8256-byte gap could be holes, about one per gap, which saves roughly a quarter of the allocation; `st_size` stays the same; and a bulk extension would cost one host call per unit instead of one per extension.
- The alternative of two slots only for in-place-rewritten files was rejected (O1): it would turn crash-torn free-space-map or relation pages into `io`, which `RBM_ZERO_ON_ERROR` does not absorb.

**Host calls.** WASI 0.2 has no `pwritev`, and the slots of neighbouring units are not contiguous. A logical write of `k` whole units, such as a multi-page WAL flush or a bulk relation write, becomes `k` host `pwrite` calls instead of one today; only extensions coalesce (W5). The commit-path and bulk-load estimates below include this. The watermark adds one 64-byte `pwrite` per sync interval per written file, into the watermark page.

**Commit path** (an 8 KiB WAL write plus fsync, `+32%` over plaintext with XTS):

- With a warm cache: one `pwrite` of 8256 bytes, one random draw, one AEAD seal of 8 KiB; a multi-page flush adds one `pwrite` per extra page.
- With a cold cache (first write to the unit in the instance), add one 16512-byte read and up to two tag verifications (W1). The tail page is hot, so the cache is nearly always warm.
- The fsync count does not change, apart from one W0 fsync per file per instance and one per shrink.
- Expected: **within noise of XTS**, because fsync dominates.

**`stat` and `stat-at`.** `stat` on a descriptor is free after the first size computation. `stat-at` costs one host `metadata-hash-at` call plus a cache lookup; on a miss it adds an open, the 8 KiB header-and-watermark read and the last-pair read, then caches the size (5.3). PostgreSQL stats relation segments often, so `stat-at` on cold and warm caches joins the benchmark list.

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
- **Size and watermark:** trailing invalid pairs above `D` dropped; an interior pair without a valid slot reads as zeros above `D` and fails with `io` below it; a trailing invalid pair below `D` fails with `io`; absent pairs below `D` are never `io`; both records invalid fails the file when a pair is present, and an interrupted birth (valid header, no valid record, size ≤ 8192) reads as empty and is re-sealed on the first write (C8a); `D` advances only after a sync and only over verified units; a new candidate replaces an unwritten one, and a shrink discards it; a due record is written with the next write or before the next sync, never at close; holes above `D`, including a unit whose first write failed (6.6 (e)), are filled with sealed zero units and then covered.
- **The invariant:** a model test that drives write, write, sync, write sequences, including shrinks, failed writes (6.6 (e)) and dropped state (6.6 (c)), and asserts that the durable slot is never the target. Failed writes are injected both as "nothing landed" and as "all bytes landed, error reported", for a pending and for a clean unit, and the test checks `pending = (re-selected winner == failed target)`.
- **Cold-cache target choice (C13):** a pair with a torn higher-claimed slot and a valid lower one; a whole-unit write must target the torn slot.
- **Markers:** the v1 `decide` (`src/marker.rs:192-221`) fed a 25-byte keyed `DIPGKEY2` marker, and the 25-byte reservation, with `has_data` false and true must return `Locked(CorruptMarker)`; the new `decide` covers every row of the table in 9.1, including unknown flag bits, a reservation with a non-zero KCV, and a reservation in a root with data.
- **Layout:** pairs start at 8192; a record write touches only its 64 bytes of the watermark page; header rotation leaves the watermark page byte-identical.
- **Plaintext model:** extend `matches_a_plaintext_model_under_random_operations` (`src/file.rs:813-869`) to codec 4 with the existing `XorShift` generator (`src/file.rs:271-283`). No new dependency is needed (Q15).
- **Unchanged XTS behaviour:** the existing codec-2/3 tests and fixtures pass unchanged.

### 12.2 Fault-injection harness

Replace the narrow `Crashing` storage (`src/file.rs:479-498`) with a **recording storage**. It logs every `write_at`, `set_len` and `sync` and keeps two images: the durable one (as of the last sync) and the volatile one. A crash is simulated by building candidate disks from the durable image plus a selection of the operations since the last sync:

1. **Every write boundary:** after each operation, persist an in-order prefix of the unsynced operations.
2. **Every tear,** at 512-byte and 4 KiB atomic units, and for writes widened to whole 4 KiB pages that tear at 512 bytes (A1): for the operation in flight, every unit cut, new prefix with old suffix and old prefix with new suffix, and for writes of up to 32 units, every subset of units. This includes **extending writes**: an extension can persist a later unit while an earlier one stays a hole, zeros or old bytes, with the file length already advanced. A shared unit takes the neighbour's bytes from the volatile (page-cache) image. For a durable neighbour that equals the on-disk image (A2). For a pending neighbour it may differ, so the harness enumerates both the neighbour's on-disk bytes and its volatile bytes in each shared unit, and expects the neighbour's unit to read as its durable version or as the pending one (C2).
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

- **Integrity directory:** the full pglite suite on a directory initialised from a reservation marker (9.1), with every file checked to be codec 4 and the marker to be the keyed `DIPGKEY2`.
- **Torn-write matrix:** the three existing cases (`scripts/smoke.ts:627-660`), with `tear.ts` taught to cut inside the slot that changed. Add:
  - a fourth case, the WAL tail page rewritten twice without an fsync in between (C10);
  - a fifth, a torn `pg_internal.init` style unaligned append (C6);
  - a sixth, tear, restart, whole-unit rewrite of the same WAL page, tear again (C13);
  - a seventh, a relation extension persisted out of order (C14): the cluster must start and read the hole as a new page.
- **Tamper:**
  - flipping one ciphertext byte of a relation page in a stopped directory fails with `io` on access;
  - zeroing both slots of a relation page below the watermark fails with `io` on access;
  - replacing a slot with an older valid copy returns the older version, which documents the non-goal.
- **Mode selection:** a reservation in a root with data locks it (`ReservedWithData`), byte-identical; a `DIPGKEY2` marker with an unknown flag bit or a reservation with a non-zero KCV locks; a `DI_PGLITE_INTEGRITY` variable in the environment changes nothing (an empty root still becomes XTS, and is only logged).
- **Downgrade:** a build without a codec-4 reader, and the published v1, refuse an integrity directory with the marker lock and leave it byte-identical.
- **Coexistence:** an XTS directory opened by the codec-4 build is unchanged (no codec-4 files, codec counts as today).
- **Benchmark:** the list in section 11.

The tenancy changes of 9.1 get their own tests in `platform/platform` when they are implemented:

- the CRD default;
- write-ahead `requested` before a key is mounted;
- the rendered `storage-mode` init container (identity, mounts, reserve list) and its classification script against fixture directories: empty, `lost+found` only, unencrypted, XTS, keyed, reserved, reserved with data, and corrupt;
- recording `integrity` from the report, including directories found only by the listing (the backfill), and the `done count` check;
- the per-key `tenants/status` policy: removing an entry, changing `requested`, or changing a set `integrity` is refused, the controller's requests included;
- a spec change after keys are recorded, which leaves them unchanged and applies to a new key (the section 10 migration);
- each `StorageIntegrity` reason.

## 13. Decisions

### 13.1 Owner decisions (2026-10-28)

- **O1 (Q3) Scope: two slots for every file** in an integrity directory. The owner accepts about 2× on-disk size for multi-unit files (11). Single-slot AEAD for relations was rejected because crash-torn FSM or relation pages would become `io`, which `RBM_ZERO_ON_ERROR` does not absorb.
- **O2 (Q6 + Q14) Crash promise: an authenticated, lazily updated durable-size watermark** (5.6). A unit with no valid slot below the watermark fails with `io` (erasure detected); above it, it reads as zeros (crash). Rollback protection stays a separate issue (non-goals).
- **O3 (Q4) Switch: a Tenant/platform setting rendered into the workload, in the first implementation** (9.1): `spec.storage.integrity` (`Off` | `AEAD`). The codec-4 writer is in the default published build from the writer release on. The mechanism was revised after the second review (13.4): the platform renders the setting as a reservation marker that a platform-run init step writes into new, empty directories, not as an environment variable. Each storage key's mode is recorded from observation and immutable per key, so the spec selects the mode only for keys recorded after it changes.
- **O4 (Q10) Migration: `pg_dump` and restore** into a freshly initialised integrity directory (10). With per-key records that directory can be a new storage key of the same Tenant (13.4). The offline copy tool stays on #199. Mixed XTS/codec-4 directories are refused.

### 13.2 Engineering decisions

1. **Q1 Unit size: 8 KiB**, PostgreSQL's `BLCKSZ`, one slot write per page write.
2. **Q2 Slot alignment: compact 8256-byte slots**, with A1 stated at the device's atomic write unit (4, section 7). Padding to 512 bytes buys nothing on 4 KiB atomic units, and 4 KiB alignment would cost about 3×.
3. **Q3:** see O1.
4. **Q4:** see O3. The `DIPGKEY2` marker carries a flags bit set (bit 0 codec 4, bit 1 reservation), and unknown bits fail closed (9.1).
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
- The `DIPGKEY2` fail-closed claim holds for markers of at least 24 bytes, the 25-byte reservation included (9.1).

### 13.4 Decisions after the second review

- **Mode source (W1).** The mode is not carried in any environment variable. A platform-run init step (`storage-mode`) in the tenant host pod writes a 25-byte `DIPGKEY2` reservation into a new, empty directory whose key is recorded as `AEAD`. encfs decides from the root marker alone. This was chosen over reserving a variable in every tenant-writable source, an admission rule per source, because that needs rules on WorkloadDeployments, ConfigMaps and Secrets plus a stated wasmCloud merge order, and every future source would reopen the gap. Precedence is explicit in 9.1: directory contents, then recorded `integrity`, then recorded `requested`, then the spec at first recording. A tenant can still run its own non-encfs code against its own directory; observation reports that as `IntegrityMismatch` or `IntegrityNotApplied`, and stale encfs pins lock instead of initialising XTS.
- **Recording and backfill (W2).** The init step lists the Tenant's whole workloads root on the node read-only and classifies every directory by its marker. The controller reads the result from the init container's log and records each key's actual mode, including directories of deleted workloads. Records are per key, write-ahead for `requested`, set once for `integrity`, never pruned while the Tenant exists, and protected by a per-key policy on `tenants/status`. `spec.storage.integrity` may change at any time and applies only to keys recorded later. That allows the O4 migration into a new key of the same Tenant, which resolves the conflict with O4.
- **Watermark placement (W3).** The records move to their own 4 KiB watermark page (bytes 4096..8192, records at 4096 and 6144). Pairs start at 8192, which costs about 4 KiB per file (about 6.2 MB on the README cluster). No record write can reach the header and its wrapped DEK. Under an A1 failure, a record write can damage only the other record, which makes the file fail with `io`, never return wrong data (section 7).
