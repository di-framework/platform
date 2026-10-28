# Design: crash-safe AEAD integrity mode with two-slot units (#200)

| | |
|---|---|
| Issue | #200 (follow-up to #199, refs #138) |
| Roadmap | v0.1 #499, epic E4 #497, lane T08, milestone `#200:design` |
| Status | **Design for review.** No code changes. Implementation waits for this review. |
| Related | #206 (codec 3, absorbs #244; its default flip waits on gate G04 = identity-server#71) |
| Crate | `platform/pglite-encfs` |

All `file:line` references are relative to `platform/pglite-encfs/` at the commit this note was written on (`origin/main` `73cfb85`).

## 1. Summary

This note proposes **codec 4**, an opt-in integrity mode for whole data directories:

- Each logical 8 KiB unit gets **two physical slots**. Each slot holds `generation ‖ length ‖ nonce ‖ tag ‖ ciphertext`, sealed with XChaCha20-Poly1305 under a per-file key.
- A read returns the **newest slot that authenticates**.
- A write never touches the slot that holds the unit's last durable version. A torn write can then only destroy the version being written, so **every unit write is atomic**, and fsynced data survives any torn write.
- A random 192-bit nonce per slot write keeps nonces unique across crashes and retries.

Codec 4 is a new codec id in the existing header format. It does not change codecs 2 and 3, the #206 rollout, or the G04 flip. A directory is either all XTS (codec 2/3) or all codec 4. An integrity directory carries a new root marker, so older builds refuse the whole directory before they touch anything. Existing directories move to codec 4 only by copying them into a fresh directory.

## 2. The current on-disk format

### 2.1 Layout

- **Physical file.** `[header: 4096][unit 0][unit 1]...`, each unit 4096 bytes of ciphertext except a shorter last one (`src/file.rs:3-5`, `src/codec.rs:41`, `src/header.rs:38-39`). The layout is length-preserving: `logical size = physical size - 4096` (`src/file.rs:77-81`).
- **Header.** 152 used bytes in a 4 KiB block: magic `DIPGENC1`, format version 1, codec byte, random file id, KCV, and the random 64-byte DEK wrapped with XChaCha20-Poly1305. The AAD is bytes 0..32, so the codec byte is authenticated (`src/header.rs:7-24`, `src/header.rs:203-214`). The header is written once and synced before any data follows it (`src/component.rs:341-364`). Rotation rewrites only the wrap (`src/header.rs:26-29`, `src/header.rs:189-201`).
- **Codec ids.** 2 is XTS with ciphertext stealing (v1). 3 is XTS with a length-independent tail keystream (#206). Codec 1 was the AEAD prototype from the #199 spike and is rejected (`src/codec.rs:53-87`, `src/header.rs:19-24`). Unknown codecs fail `Header::parse` as `Unsupported` (`src/header.rs:149-152`). A test pins that 1 and 4 are refused today (`src/header.rs:282-290`, `src/codec.rs:235-237`).
- **New files.** `Codec::NEW_FILES` is codec 2, or codec 3 with the cargo feature `write-codec-3` (`src/codec.rs:62-69`, `Cargo.toml:36-38`). The composed component's custom section advertises it as `write-codec=N` (`src/component.rs:64-75`, README "Composition").
- **Size from `stat`.** The guest's `stat` and `stat-at` derive a regular file's size from the host size alone, without opening it (`src/component.rs:166-181`, `src/component.rs:1096-1105`). Each read and write also stats the host file to find the logical size (`src/file.rs:99-101`, `src/component.rs:247-249`).

### 2.2 Write path

- Each logical write becomes **one** host `pwrite`, after a read-modify-write of a partially covered first or last unit (`src/file.rs:168-209`). Writes that cover whole units skip the read (`src/file.rs:195-196`, test `src/file.rs:389-403`).
- A write past the end zero-fills the gap with encrypted zeros, in 1 MiB chunks (`src/file.rs:11-12`, `src/file.rs:118-134`).
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

- **G1 Integrity.** Any modification of a unit's ciphertext, slot metadata or header is detected. The read either fails with `io` or returns a version that encfs itself wrote for that file, unit and slot. See the non-goals for rollback.
- **G2 Durability.** Data covered by a completed `sync` or `sync-data` survives any torn or reordered write that follows. The torn-write matrix of `make smoke` passes, including the two cases the spike's codec failed.
- **G3 Atomic units.** After a crash, every unit reads as exactly one version that was written to it, never a mix. This is stronger than plaintext, which tears at sector granularity.
- **G4 No tail garble.** Unaligned appends and shrinks never garble durable bytes, which removes the #206 problem class for codec-4 files.
- **G5 Nonce safety.** No (key, nonce) pair is ever used twice, including after a crash and a retry of the same write.
- **G6 Fail closed on downgrade.** A build that cannot read codec 4 refuses an integrity directory before it writes anything.
- **G7 No regressions.** Codecs 2 and 3, their fixtures, the #206 rollout and the G04 flip are unchanged.

### Non-goals

- **Rollback and replay protection.** An attacker who saved an older valid slot, a whole older file, or truncates a file is not detected. That needs a Merkle root anchored outside the volume (#200). Falling back to an older slot looks the same as recovering from a torn write; this is by design.
- **Binding files to paths.** A whole file moved to another path still opens there (README "Threat model"). Codec 4 binds slots to the file id, not the path.
- **Converting XTS directories in place.** Codec 2/3 files are never re-encrypted in place (README "Codecs and migration").
- **Hiding metadata** (names, sizes, access patterns).
- **Changing the default** for any deployment. Codec 4 is opt-in per directory.
- **Cross-unit atomicity.** A write that spans units is atomic per unit, not as a whole, as with plaintext pages.

## 4. Assumptions

- **A1 Sector atomicity.** After a power loss, each 512-byte sector inside an in-flight write range holds either its old or its new contents. This is the model `scripts/lib/tear.ts:1-8` already uses, and the one PostgreSQL relies on for `pg_control`.
- **A2 Tears stay inside the write.** Sectors outside the byte range of in-flight writes keep their contents.
- **A3 Honest sync.** When host `sync` or `sync-data` returns success, everything written to the file before it is durable.
- **A4 Single writer.** One encfs instance owns a data directory, the exclusive ownership pglite already requires (`src/component.rs:10-12`). Per-file state may be cached in memory.
- **A5 Ordered size updates.** On the supported filesystems (ext4 `data=ordered`, XFS), an extending `pwrite` that is lost in a crash does not leave a longer file of zeros. Hosts that break this (ext4 `data=writeback`) are discussed in 8.3.

## 5. On-disk format of codec 4

### 5.1 Header and codec id

- **Header:** unchanged: same 152 bytes, format version 1, **codec byte 4** (`src/header.rs:7-17`). The codec byte stays in the wrap's AAD, so a file cannot be relabelled between codecs without the key (`src/header.rs:315-327`).
- **Codec 1 stays retired.** It was the spike's AEAD layout, so reusing it could make leftover spike files parse.
- **DEK:** unchanged: 64 random bytes per file (`src/header.rs:44-45`). Codec 4 derives `aead_key = HKDF-SHA256(ikm = DEK, salt = "di-framework/encfs/v1", info = "codec4-aead")`, 32 bytes. The other XTS key half has no meaning in codec 4. Using HKDF instead of `DEK[..32]` keeps a future Merkle or MAC key (rollback protection) derivable from the same DEK.

### 5.2 Units and slots

- **Unit size 8192** logical bytes, separate from XTS's 4096 (`src/codec.rs:41`). 8 KiB matches PostgreSQL's `BLCKSZ` and `XLOG_BLCKSZ`, so a relation, SLRU or WAL page write is exactly one slot write. The spike also used 8 KiB units (#200). See open question Q1.
- **Slot:** a 64-byte slot header followed by an 8192-byte ciphertext area, **8256 bytes** in total.
- **Pair:** unit `u` owns slot A at `4096 + u × 16512` and slot B at `4096 + u × 16512 + 8256`. A pair is 16512 bytes.

| slot bytes | field | notes |
|---|---|---|
| 0..8 | `generation`, u64 LE | 0 = never written; the first version is 1 |
| 8..12 | `len`, u32 LE | logical bytes in this unit, 1..=8192 |
| 12..16 | reserved, zero | authenticated |
| 16..40 | `nonce`, 24 bytes | random per slot write (5.4) |
| 40..56 | `tag`, Poly1305 | over AAD and ciphertext |
| 56..64 | reserved, zero | authenticated |
| 64..64+len | ciphertext | XChaCha20 of the unit's `len` plaintext bytes |
| 64+len..8256 | padding | not written, not authenticated, ignored |

- **AAD** = `"DIPGENC4"` ‖ file id (16) ‖ unit index (u64 LE) ‖ slot (u8: 0 = A, 1 = B) ‖ slot bytes 0..16 ‖ slot bytes 56..64. This binds a slot to its file, unit, position, generation and length. Swapping slots, units or files, or changing a length, fails authentication.
- **Tag placement.** The tag sits in the slot header, before the ciphertext. A reader gets the metadata and the ciphertext in one contiguous read, and a write is one contiguous `pwrite` of `64 + len` bytes. A tear that keeps the new header with old ciphertext, or the reverse, fails authentication like any other tear.
- **Physical size.** The last pair may be incomplete. A slot that reaches past the end of the host file is "absent". So a one-unit file written once is `4096 + 64 + len` bytes, and grows to `4096 + 8256 + 64 + len` bytes only when slot B is first written.

### 5.3 Logical size

The logical size can no longer be computed from the host size alone (`src/file.rs:77-81`). It is defined by the slots:

- Let `n` be the number of pairs that start inside the host file. Starting from the last one, drop every **trailing** pair that has no valid slot (5.5). A crash in an unsynced append leaves such pairs; dropping them is equivalent to the append not having happened.
- If `k` is the last remaining pair, `logical size = k × 8192 + len(winner of k)`. A file with no remaining pair is empty.
- An **interior** unit whose winner has `len < 8192` reads as its `len` bytes followed by zeros. This state only arises from an unsynced append whose writes were persisted out of order (section 7, C7). It matches plaintext, where unsynced extended blocks can read back as zeros.
- encfs caches the logical size per file id (A4), so `stat` costs one computation per file per instance, not one per call. `stat-at` by path (`src/component.rs:1100-1105`) must open the file to learn its codec. For a codec-4 file it then reads the header and the last pair. See 9.2.

### 5.4 Nonces

The requirement: no two encryptions under one `aead_key` may share a nonce. With Poly1305, a repeated nonce leaks the XOR of the two plaintexts and enables forgery.

- **Why deterministic nonces fail.** Take `nonce = f(unit, slot, generation)`. A write of generation `g+1` to slot B is torn and fails to authenticate. After restart the newest valid generation is still `g`, so the retry writes generation `g+1` to slot B again, with a different plaintext. The torn first attempt may have left durable sectors under the same nonce. The same happens when a process dies after the write but before it learns that the write landed.
- **Proposal: random 192-bit nonces.** Each slot write draws 24 bytes from `wasi:random/random.get-random-bytes`, which the component already uses for file ids, DEKs and wrap nonces (`src/component.rs:115-119`, `src/component.rs:349-352`). XChaCha20's 192-bit nonce makes a collision negligible: about 2^-96 after 2^48 writes under one key. It needs no persistent state, so crash and retry are safe by construction.
- **Optional optimisation (Q5).** `nonce = 16 random bytes drawn once per instance ‖ u64 counter`. This avoids one host call per write. It is unique as long as instance memory is never cloned and resumed twice, which A4 implies but the platform does not enforce.

### 5.5 Slot validity and selection

A slot is **valid** if it lies entirely within the host file, its generation is not 0, its `len` is within 1..=8192, its reserved bytes are zero, and its tag authenticates. The unit's **winner** is the valid slot with the higher generation.

| slot A | slot B | read returns |
|---|---|---|
| valid, gen a | valid, gen b, b > a | B |
| valid, gen a | invalid or absent | A |
| invalid or absent | invalid or absent, all bytes zero or absent | trailing pair: dropped from the size. Interior pair: `io` (8.3) |
| invalid or absent | invalid, not all zero | trailing pair: dropped from the size. Interior pair: `io`, logged with the path and unit |
| valid, gen a | valid, gen a | `io` (cannot happen without tampering) |

A reader checks the slot with the higher claimed generation first. If it authenticates, the other slot does not need to be decrypted. A higher generation in the clear proves nothing until its tag verifies. A torn slot usually shows the new generation with the old ciphertext.

## 6. Write protocol

### 6.1 Per-file state

encfs keeps state per **file id**, not per descriptor. PostgreSQL may write through one descriptor and fsync through another, and the file id is fixed for the inode's lifetime (`src/header.rs:26-29`). For each unit that has been touched, the state holds:

- `winner`: slot and generation of the newest version, or none;
- `pending`: whether `winner` was written since the last successful sync of this file, so may not be durable yet.

It also holds the cached logical size and a `synced_once` flag. Section 9.2 discusses the memory bound.

### 6.2 The durable-slot invariant

> **A write never targets the slot that holds the unit's last durable version.**

The issue's rule, "write to the slot with the older generation", is not enough. Suppose v1 is durable in A, and v2 is written to B and not synced. PostgreSQL then writes the page again, which the WAL writer does for the tail page between commits. Under the issue's rule, v3 goes to A, the older generation. A power loss at that moment can tear A (v3) and lose B (v2, never synced) together. Then nothing valid is left, although v1 was fsynced. The target rule below closes this:

- `pending` is set: overwrite the **pending** slot (the winner). The durable slot keeps the last durable version.
- `pending` is clear: write the **other** slot. The winner is durable.
- No valid slot: write slot A, generation 1. Either slot may hold torn bytes; nothing durable is lost.

The new generation is always `winner.generation + 1`, or 1 if there is none. Generations strictly increase per unit, so the newest valid slot is always the latest version that reached the disk.

### 6.3 Steps of a write

For `write(offset, data)`, and for zero-fill, which already goes through the same path (`src/file.rs:128-133`):

1. **W0, first write to the file in this instance.** If `synced_once` is clear, call host `sync-data` on the file first, then set it. After a restart encfs cannot know whether the winners on disk are durable. A process crash without power loss leaves them in the host page cache. Syncing once makes them durable, so the invariant holds from the first write. Cost: one fsync per written file per instance.
2. **W1, resolve each unit.** Use the cache, or read the pair (one contiguous read of up to 16512 bytes) and select the winner (5.5).
3. **W2, build the plaintext.** A partially covered unit is read-modify-write from the winner. If an interior unit within the size has no valid slot, a partial write fails with `io`. A write that covers the whole unit needs no old plaintext, and only the slot metadata is needed to choose the target.
4. **W3, choose the target slot and generation** (6.2).
5. **W4, seal.** Draw a fresh nonce, then encrypt and authenticate to produce `slot header ‖ ciphertext`.
6. **W5, write.** One host `pwrite` per unit, at the target slot's offset, `64 + len` bytes. When a write creates new pairs, their slot-A images and the zero gaps between them are coalesced into one extending `pwrite`. This keeps A5's ordering for appends.
7. **W6, update the cache.** Set `winner = target`, `pending = true`, and update the size.

**Sync.** `sync` and `sync-data` still pass through (`src/component.rs:1041-1043`, `src/component.rs:1087-1089`). When the host call succeeds, every unit's `pending` flag for that file id is cleared. On failure nothing changes and the error is returned. PostgreSQL treats an fsync failure as fatal.

**No extra barriers.** Apart from W0, codec 4 adds no fsync and no ordering requirement between writes. Correctness rests only on the invariant and on A1–A3.

### 6.4 Resizes

- **Append inside the last unit:** a single slot write with the larger `len`, so it is atomic (G4).
- **Append that adds units:** write the last unit with `len = 8192`, then the new units. The two may reach disk in any order (C7).
- **Grow with `set_size`:** zero-fill through the write path, as today (`src/file.rs:136-141`).
- **Shrink to a unit boundary:** one host `set_size(4096 + k × 16512)`, atomic in the filesystem. PostgreSQL truncates relations in whole 8 KiB blocks, so this is the common case.
- **Shrink inside a unit:** first `set_size` to the end of the new last pair, then write that unit with the new `len`. The order matters. Writing the slot first would leave an interior short unit followed by valid units if the crash comes before the truncate, and the old size would then read with zeros in the middle. Truncating first means a crash in between leaves an intermediate, unit-aligned size whose bytes are all old, valid data (C9). Nothing is garbled.
- **Truncate to 0:** `set_size(4096)` keeps the header, as today (`src/header.rs:27-28`).

## 7. Crash cases

These cases assume A1–A5. "Previous" means the version in the durable slot.

| # | crash point | on disk | a reader returns |
|---|---|---|---|
| C1 | before W5 reaches the disk | old pair | the old winner |
| C2 | W5 torn: any subset of the target slot's sectors is new | target fails authentication; the durable slot is untouched (6.2, A2) | **the previous version**. If the target was pending, the version before it, which was never synced, so losing it is allowed |
| C3 | W5 complete, not synced | target valid with a higher generation | the new version (allowed, never required) |
| C4 | only the slot header's sector, or only ciphertext sectors, are new | target fails authentication | as C2 |
| C5 | a write spanning several units, each landed, torn or lost independently | each unit independently | each unit is its old or new version (G3). There is no cross-unit atomicity, as with plaintext pages |
| C6 | append inside the last unit | one slot | old length and contents, or new: **no garble** (G4, compare #206's 31 and 15 bytes) |
| C7 | append that adds units, unsynced, persisted out of order | the last unit old or full; new trailing pairs present, torn or absent | trailing pairs without a valid slot are dropped, so the size is the old one or an intermediate one. A former last unit with `len < 8192` followed by a valid unit reads as zeros up to 8192 (5.3) |
| C8 | write of a fresh file's first unit, header synced | header plus a torn or absent slot A | an empty file. The header still follows the fresh/sealed rules (`src/header.rs:78-113`) |
| C9 | shrink inside a unit, between `set_size` and the slot write | pairs beyond the new last one gone; the last unit's old slot | a unit-aligned size between the new and the old one, with old valid bytes. After the slot write: the new size |
| C10 | rewriting the same unit twice without a sync, torn on the second write | durable slot untouched; the pending slot torn | the last **durable** version. The issue's "older generation" rule would lose it here (6.2) |
| C11 | during a sync | pending slots durable or not | per unit, the newest version that reached the disk, never older than the previous sync. W0 makes the next instance safe |
| C12 | between W0's sync and the first write | nothing new | as C1 |

**The spike's failures under codec 4:**

- **Tearing the WAL page that holds an fsynced commit** (`tearFirstRewrite`, `scripts/lib/tear.ts:61-81`) is C2 or C10. The durable slot still holds the page with commit A, so commit A survives.
- **Tearing a `pg_control` rewrite** is C2. The previous `pg_control` authenticates and its CRC holds, so PostgreSQL starts from the previous checkpoint, as it does after a lost plaintext write.

Plaintext only promises sector-level old-or-new pages here. Codec 4 is strictly stronger: the whole page is old or new.

**Partial sector writes.** If A1 fails and a sector inside the target range holds neither version, the target fails authentication: still C2. A2 alone keeps the other slot safe. Slots are not sector-aligned (8256 = 16 × 512 + 64), so the last sector of slot A also holds the first 64 bytes of slot B. A write to slot A rewrites that sector with B's bytes unchanged. Under A1 that is safe, and PostgreSQL itself needs A1 for `pg_control`. Q2 offers sector-aligned slots, which remove even this dependency.

## 8. Read protocol

### 8.1 Reads

- **Size:** cached per file id, otherwise computed once as in 5.3.
- **Each unit in range:**
  - With a cached winner, read only that slot (`64 + len` bytes), verify it and decrypt. If verification fails, which cannot happen with a single writer unless the volume changed under encfs, drop the cache entry, re-read the whole pair and select again.
  - Without a cached winner, read the whole pair in one call, select (5.5), cache the winner with `pending = false`, and decrypt.
- **Multi-unit reads:** one contiguous host read over the pairs when most winners are unknown; per-slot reads when they are cached. Either way it is fewer host calls than units, as `read_units` does today (`src/file.rs:153-166`).
- **Integrity failures** map to `ErrorCode::Io` with a log line naming the path and unit, like `FileError::Truncated` today (`src/component.rs:187-198`).

### 8.2 Slot choice

The reader never returns an unauthenticated byte. When both slots are valid it returns the higher generation. Its only fallback is the other authenticated slot. That fallback is how C2 and C10 recover, and it is also why rollback by a volume writer is out of scope (non-goals).

### 8.3 All-zero interior pairs

With A5 a crash cannot leave a zero pair inside the size: encfs extends files by writing, and the size moves only after the data. A zero interior pair therefore means tampering, or a host without A5 (ext4 `data=writeback`).

The proposal is to **fail with `io`**. Reading it as zeros would let a volume writer erase any page without detection, and PostgreSQL reads an all-zero heap page as a valid new page. Whole-unit writes over such a unit still work, so WAL redo can overwrite it with a full-page image without reading it first. See Q6.

## 9. Codec 3, G04 and rollout

### 9.1 Codec id, feature flag and directory mode

- **Codec 4 is a new codec, not a variant of codec 3.** It shares only the header format (version 1). The XTS codecs stay as they are, and `Codec::NEW_FILES` keeps meaning "the XTS codec for new files in XTS directories" (`src/codec.rs:62-69`).
- **Integrity is per directory, chosen once.** A directory that mixes codec 4 with XTS files cannot claim G1. The mode is recorded in the root marker when the directory is initialized (`src/marker.rs:130-135`, `src/component.rs:479-497`):
  - XTS directories keep `DIPGKEY1 ‖ KCV`, 24 bytes (`src/marker.rs:16-17`).
  - Integrity directories get a new magic, `DIPGKEY2`, followed by the KCV and a mode byte (4).
- **Older builds fail closed on an integrity directory (G6).** Today's `decide` treats any marker with the wrong length or magic as `CorruptMarker` and locks the whole preopen before anything is written (`src/marker.rs:192-221`). No codec-4 file is ever opened by a build that cannot read it. That differs from codec 3's rollback, which relies on PostgreSQL panicking on the first codec-3 file (README "Codecs and migration"). The lock message says "corrupt", which is misleading, but that cannot be changed for builds already deployed. The codec-4 release's message names the mode instead.
- **Rotation must keep the mode.** `write_marker` currently encodes only the KCV (`src/component.rs:481-497`).
- **Selection.** A new cargo feature `write-codec-4` compiles the writer, mirroring `write-codec-3` (`Cargo.toml:31-38`). In such a build, the environment variable `DI_PGLITE_INTEGRITY=1` (hidden from the engine like the key variables, `src/keys.rs:42`) is honoured only when an empty directory is initialized. On an existing directory the marker decides, and a mismatch is logged, not acted on. Every build after the reader release reads codec 4.
- **Inside an integrity directory**, every new file is codec 4, and an XTS file is refused with `io`. A fresh directory has none; they can only be copied in.

### 9.2 Code that changes when this is implemented

- `src/codec.rs`: `Codec::TwoSlotAead = 4` in `id` and `from_id`. Codec 1 stays rejected.
- `src/header.rs`: parse accepts 4. Update the tests that assert 4 is unsupported (`src/header.rs:282-290`, `src/codec.rs:235-237`).
- `src/file.rs`: it assumes a length-preserving layout throughout (`src/file.rs:3-5`, `src/file.rs:77-90`, `src/file.rs:153-209`). Codec 4 gets its own module (working name `src/slots.rs`) behind a small layout trait, so the XTS path and its fixtures (`src/file.rs:713-811`) stay byte-identical.
- `src/component.rs`: `guest_stat` and `stat-at` stop deriving the size from the host size for codec-4 files (`src/component.rs:166-181`, `src/component.rs:1096-1105`); the per-file-id state; and promotion of pending units on sync.
- `src/marker.rs`: the second marker form and mode.
- `scripts/smoke.ts`: the codec census only accepts 2 and 3 (`scripts/smoke.ts:252-265`).
- `scripts/lib/tear.ts`: tears are cut at XTS page offsets after the header (`scripts/lib/tear.ts:34-81`). For codec 4 they must be cut inside the slot that changed.
- **Cache memory:** about 10 bytes per touched unit (generation, slot bit, pending bit). A 1 GiB relation segment has 131,072 units, so about 1.3 MiB when fully touched. The implementation should bound the map, for example as a per-file LRU that evicts only non-pending entries. A pending entry is needed for 6.2 until the next sync. If a sync is far away, encfs may sync the file itself before evicting.

### 9.3 Relation to #206 and G04

- **#206 does not wait for codec 4, and codec 4 does not wait for G04.**
  - G04 (identity-server#71 parses and enforces `write-codec`, and a reader-capable encfs is deployed everywhere) gates only flipping the XTS default from codec 2 to 3.
  - Codec 4 changes no default and no existing directory. Its rollback story is the marker (9.1), not the custom section.
  - The T08 order stays `#200:design` → #206.
- **Two-step rollout, as in #206:**
  1. **Reader release:** reads codec 4 and the `DIPGKEY2` marker, but cannot create them.
  2. **Writer:** the `write-codec-4` build. Opt-in per directory, then possibly the published default build.

  An integrity directory must never be opened by a build older than step 1. The marker makes that fail closed.
- **Custom section.** It is a fixed 40-byte `format=1 codec=aes-256-xts write-codec=N` today (`src/component.rs:64-75`). A codec-4-capable build must also advertise, for example, `read-codecs=2,3,4 integrity=opt-in`, so deploy tooling can refuse a pin that cannot read a directory's mode. **identity-server#71 is still open.** Its parser should accept unknown keys and a variable-length section; otherwise codec 4 would need another gate later. See Q11.
- **Codec 4 removes the #206 problem only for integrity directories.** XTS directories still need codec 3 and its flip.

## 10. Migration and compatibility

- **Existing files are never converted in place.** A directory moves to integrity mode by copying its contents into a fresh directory:
  - with the planned offline tool (#199, not built yet; README "Rotation" and "Codecs and migration");
  - or logically: `pg_dump` from the XTS instance, restore into a new instance whose empty directory was initialized with `DI_PGLITE_INTEGRITY=1`.

  See Q10.
- **Codec 2/3 fixtures** (`src/testdata/codec2`, `src/file.rs:713-768`) must keep reading and rewriting byte-identically. The XTS code path is not touched.
- **Downgrade:** a build that cannot read codec 4 sees an integrity directory as `CorruptMarker` and locks it (9.1). Rollback after an integrity directory exists means rolling forward to a codec-4 reader, or restoring a pre-migration snapshot of the XTS directory.
- **Key rotation:** unchanged for headers (`src/header.rs:189-201`). The sweep must rewrite the `DIPGKEY2` marker with its mode.
- **Interface:** the WIT package and the encfs exports are unchanged. As with #206, the rollout is gated by the build feature and the markers.

## 11. Performance and space

These are estimates to be checked against the README benchmark, which the issue's acceptance requires. The README baseline is wasmtime 48, aarch64, ±20% (README "Performance").

**Space:**

- A full unit costs `2 × 8256 / 8192 ≈ 2.016×` once both slots have been written; with a single version it costs `≈ 1.008×`.
- A small file written once (most are, through a temporary file and `rename`) costs `4096 + 64 + len`, about the same as XTS today.
- **Estimate for the README cluster** (1516 files, 32.9 MB plaintext, 40.0 MB with XTS): **about 60 to 75 MB**. Relation and WAL pages rewritten in place count at 2×, files written once at about 1×.
- A 16 MiB WAL segment becomes about 33 MiB once each page has been rewritten. PostgreSQL pre-zeroes segments, so this is the steady state.
- The issue's alternative, codec 4 only for in-place-rewritten files, would cut this to near the XTS figure but give up G1 for relation data (Q3).

**Commit path** (an 8 KiB WAL write plus fsync, `+32%` over plaintext with XTS):

- With a warm cache: one `pwrite` of 8256 bytes, one random draw, one AEAD seal of 8 KiB.
- With a cold cache, add one 16512-byte read. The tail page is hot, so the cache is nearly always warm.
- The fsync count does not change, apart from one W0 fsync per file per instance.
- Expected: **within noise of XTS**, because fsync dominates.

**CPU:**

- XTS runs in software AES inside Wasm at about 50 MB/s (README "Performance").
- Portable XChaCha20-Poly1305 avoids AES table lookups. On Wasm without SIMD it is commonly 2–4× faster per byte than software AES.
- Expected: **equal or lower crypto cost than XTS**, to be measured. This is also why the proposal does not use AES-GCM or AES-GCM-SIV (Q13).

**Bulk load plus checkpoint:**

- Bytes written roughly double (each page's second write goes to the other slot).
- XTS measured 6.0–6.7 s against 1.6–2.1 s for plaintext, CPU-bound.
- Expected: **similar to XTS or somewhat higher**, depending on host I/O.

**Uncached scans** (about 10× today):

- With a cold cache, each unit reads both slots: 2× bytes, but one host call per range.
- With a warm cache: 1× bytes plus a 64-byte header per unit.
- Expected: **1–2× XTS I/O** with cheaper crypto.

**Memory:** the per-file-id cache in 9.2.

## 12. Test plan

### 12.1 Unit tests (host, `cargo test`)

- **Slot codec:** round trips for every `len` class (1, 15, 16, 8191, 8192); AEAD known answers from an independent reference (libsodium or Node `crypto`), kept with the existing KATs (`src/testdata/xts-kat.txt`); HKDF key derivation pinned.
- **Binding:** swapping slots A and B, moving a slot to another unit or file, and editing `generation`, `len`, the reserved bytes, the nonce, the tag or any ciphertext byte must each fail authentication.
- **Selection:** the full table in 5.5, including equal generations, generation 0, a slot past the end of the file, and a `len` out of range.
- **Size:** trailing invalid pairs dropped; an interior short unit reads as zeros; an interior zero pair fails with `io`.
- **The invariant:** a model test that drives write, write, sync, write sequences and asserts that the durable slot is never the target.
- **Plaintext model:** extend `matches_a_plaintext_model_under_random_operations` (`src/file.rs:813-869`) to codec 4 with the existing `XorShift` generator (`src/file.rs:271-283`). No new dependency is needed; see Q15.
- **Unchanged XTS behaviour:** the existing codec-2/3 tests and fixtures pass unchanged.

### 12.2 Fault-injection harness

Replace the narrow `Crashing` storage (`src/file.rs:479-498`) with a **recording storage**. It logs every `write_at`, `set_len` and `sync` and keeps two images: the durable one (as of the last sync) and the volatile one. A crash is simulated by building candidate disks from the durable image plus a selection of the operations since the last sync:

1. **Every write boundary:** after each operation, persist an in-order prefix of the unsynced operations.
2. **Every tear:** for the operation in flight, every 512-byte sector cut, new prefix with old suffix and old prefix with new suffix, and for writes of up to 32 sectors, every subset of sectors (A1).
3. **Reordering:** every subset of up to 8 unsynced operations, and a random sample beyond that, to model page-cache writeback order (C5, C7).
4. **Restart:** reopen with an empty cache, which exercises W0, and continue the workload after the crash.

The invariants checked on every candidate disk:

- **Durability:** every byte covered by a completed sync reads back as its synced value or a later written value.
- **Atomicity:** every unit equals one version that was written to it, or the durable version.
- **No integrity errors:** no `io` from slot authentication on a crash-only disk. This is the regression the spike hit. The one documented exception is a zero interior pair, which cannot arise with A5. The harness asserts A5 by never persisting a size extension without its data.
- **Size:** the size equals some size the file had since the last sync, or an intermediate unit-aligned size during a shrink inside a unit (C9).
- **Nonce uniqueness:** all nonces sealed in a run, retries after each crash included, are distinct. With the production random source this is trivially true. The harness also runs with a deterministic counter source to check that the protocol never reseals with a reused nonce.

Workloads:

- the WAL tail pattern (repeated rewrites of one growing page, fsync on some);
- a `pg_control` rewrite;
- small-file appends and shrinks across unit edges (the #206 cases, `src/file.rs:540-560`);
- multi-unit extensions;
- random sequences.

### 12.3 `make smoke`

- **Integrity directory:** the full pglite suite on a directory initialized in integrity mode, with every file checked to be codec 4 and the marker to be `DIPGKEY2`.
- **Torn-write matrix:** the three existing cases (`scripts/smoke.ts:627-660`), with `tear.ts` taught to cut inside the slot that changed. Add:
  - a fourth case, the WAL tail page rewritten twice without an fsync in between (C10);
  - a fifth, a torn `pg_internal.init` style unaligned append (C6).
- **Tamper:**
  - flipping one ciphertext byte of a relation page in a stopped directory fails with `io` on access;
  - replacing a slot with an older valid copy returns the older version, which documents the non-goal.
- **Downgrade:** the default build without a codec-4 reader, and the published v1, refuse an integrity directory with the marker lock and leave it byte-identical.
- **Coexistence:** an XTS directory opened by the codec-4 build is unchanged (no codec-4 files, codec counts as today).
- **Benchmark:** the README table measured for plaintext, XTS and codec 4 on the same host. This is #200's acceptance criterion.

## 13. Open questions for the owner

1. **Q1 Unit size.** 8 KiB, matching PostgreSQL pages and one slot write per page write (proposed), or 4 KiB like XTS? 4 KiB halves the read-modify-write size of partial writes but doubles the slot writes per page and the metadata overhead.
2. **Q2 Slot alignment.** Compact 8256-byte slots, which rely on A1 for the one sector shared with the neighbouring slot (proposed), or slots padded to 8704 bytes (17 sectors) so a slot write never touches the other slot's sectors? Padding costs about 5% more space (2.125× instead of 2.016×).
3. **Q3 Scope.** Two slots for every file in an integrity directory (proposed), or only for files PostgreSQL rewrites in place (`pg_wal/*`, `global/pg_control`, `pg_xact` and the other SLRUs), with relation files under a single-slot AEAD relying on `full_page_writes`? The cheaper variant is riskier: the FSM is not WAL-logged, and an `io` error is not the checksum failure that `RBM_ZERO_ON_ERROR` tolerates.
4. **Q4 Mode selection.** Is a build feature plus `DI_PGLITE_INTEGRITY=1` at initialization the right control, or should integrity become a platform or Tenant setting rendered into the workload? Should the `DIPGKEY2` marker carry a mode byte or a bit set for future modes?
5. **Q5 Nonces.** A random draw per slot write (proposed), or a random per-instance prefix plus a counter? The second is cheaper but unsafe if an instance is ever snapshot and resumed twice.
6. **Q6 Zero interior pairs.** Fail with `io` (proposed) or read as zeros? Do we support any host without ordered size updates (ext4 `data=writeback`), where `io` could appear after a crash?
7. **Q7 Shrink inside a unit.** Is a crash leaving an intermediate unit-aligned size with valid old bytes (C9) acceptable? The alternative is a third, journalled step.
8. **Q8 Cache bound.** An LRU per file plus a forced sync before evicting pending entries, or a fixed bitmap per file (2 bits per unit plus a generation fetched on demand)?
9. **Q9 W0.** One `sync-data` per file on its first write in each instance (proposed), or a sweep that syncs every file at start, which costs more at start and less on first writes? WASI has no `syncfs`.
10. **Q10 Migration.** Build the offline copy tool (#199) before codec 4 ships, document `pg_dump` and restore only, or allow an existing XTS directory to switch to codec 4 for new files only, which cannot claim G1?
11. **Q11 identity-server#71.** Ask now that its parser of the custom section accepts unknown keys and a variable length (`read-codecs=`, `integrity=`), so codec 4 does not need another gate later?
12. **Q12 `data_checksums`.** Should pglite's initdb enable PostgreSQL data checksums as a cheap interim corruption detector for XTS directories, tracked separately (#200 suggests checking)?
13. **Q13 Algorithm.** XChaCha20-Poly1305, already a pinned dependency, used for wraps and faster than software AES in Wasm (proposed), or AES-256-GCM-SIV for nonce-misuse resistance at a higher CPU cost?
14. **Q14 Rollback protection.** Confirm it stays out of scope here and gets its own issue (Merkle root anchored outside the volume). Keeping the DEK-derived key space (5.1) is the only provision made for it now.
15. **Q15 Property-test dependency.** Keep the hand-rolled generator (proposed), or add `proptest` as a pinned dev-dependency for shrinking failing crash cases?
16. **Q16 Slot padding.** Leave bytes `64+len..8256` unauthenticated and unwritten (proposed), or zero and authenticate the whole ciphertext area, which makes short last units cost a full 8 KiB of crypto?
