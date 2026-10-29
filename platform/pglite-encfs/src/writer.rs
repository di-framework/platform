//! Codec 4 (#200): the write protocol of integrity directories.
//!
//! Section numbers refer to `docs/design-200-two-slot-aead.md`. The format
//! and the read-side selection live in [`crate::slots`]; this module keeps
//! the per-file state (6.1) and runs writes (6.3), resizes (6.4), syncs and
//! the durable-size watermark (5.6) over it.
//!
//! - **The durable-slot invariant (6.2).** A write never targets the slot
//!   that holds the unit's last durable version: a `pending` unit (written
//!   since the last successful sync) overwrites its pending winner, a clean
//!   unit writes the other slot, a unit with no valid slot writes slot A.
//!   Watermark records follow the same rule with one `wm_pending` bit.
//! - **W0.** The first write to a file in an instance syncs it first, so the
//!   winners on disk are durable before any bit is trusted.
//! - **W1.** A unit that is not `known` is resolved by authenticating its
//!   pair, the higher claim first, also for whole-unit writes (C13).
//! - **Fail-stop (A3, 6.5).** After a host sync of a file fails, every later
//!   write to it fails until the instance restarts.
//! - **Lost `pending` bits (6.6).** When the state cannot know a bit, it
//!   syncs (clears `synced_once`, so the next write runs W0) rather than
//!   guessing.

use crate::file::{Storage, FILL_CHUNK, MAX_GAP, MAX_SIZE};
use crate::header::{FileId, NONCE_LEN};
use crate::slots::{
    open_slot, seal_record, seal_slot, select_watermark, slot_offset, Integrity, Layout, Slot,
    SlotError, SlotFile, Watermark, PAIRS_START, PAIR_LEN, RECORD_AT, RECORD_LEN, SLOT_LEN, UNIT,
};

/// Pairs the watermark verifies per successful sync while `D` catches up
/// (5.6 step 2): 4 MiB of reads.
pub const VERIFY_PER_SYNC: u64 = 256;

/// The host's `sync-data` and `sync` on the file being written.
pub trait Durable: Storage {
    fn sync_data(&self) -> Result<(), Self::Error>;
    fn sync_all(&self) -> Result<(), Self::Error> {
        self.sync_data()
    }
}

/// A fresh nonce per slot and record seal (5.4).
pub trait Nonces {
    fn draw(&mut self) -> [u8; NONCE_LEN];
}

impl<F: FnMut() -> [u8; NONCE_LEN]> Nonces for F {
    fn draw(&mut self) -> [u8; NONCE_LEN] {
        self()
    }
}

/// One bit per unit.
#[derive(Clone, Debug, Default)]
struct Bits(Vec<u64>);

impl Bits {
    fn get(&self, unit: u64) -> bool {
        self.0
            .get((unit / 64) as usize)
            .is_some_and(|word| word >> (unit % 64) & 1 == 1)
    }

    fn set(&mut self, unit: u64, value: bool) {
        let word = (unit / 64) as usize;
        if self.0.len() <= word {
            if !value {
                return;
            }
            self.0.resize(word + 1, 0);
        }
        if value {
            self.0[word] |= 1 << (unit % 64);
        } else {
            self.0[word] &= !(1 << (unit % 64));
        }
    }

    /// Clear every bit at or above `units`.
    fn keep_below(&mut self, units: u64) {
        let words = units.div_ceil(64) as usize;
        if self.0.len() >= words {
            self.0.truncate(words);
            if let (Some(last), true) = (self.0.last_mut(), !units.is_multiple_of(64)) {
                *last &= (1 << (units % 64)) - 1;
            }
        }
    }

    fn clear(&mut self) {
        self.0.clear();
    }
}

/// What encfs knows about one codec-4 file (6.1). Kept per file, not per
/// descriptor, keyed by the file id and the host identity of the inode.
#[derive(Clone, Debug)]
pub struct FileState {
    file_id: FileId,
    /// The winner of the unit was authenticated or written in this instance.
    known: Bits,
    /// Which slot wins (`true` = B); meaningful only for `known` units.
    winner_b: Bits,
    /// The winner was written since the last successful sync of this file.
    pending: Bits,
    /// The unit last written, its slot and generation (W6).
    last: Option<(u64, Slot, u64)>,
    size: u64,
    durable_units: u64,
    /// The winning watermark record; `None` only for an interrupted birth.
    record: Option<Watermark>,
    /// The winning record was written since the last successful sync.
    wm_pending: bool,
    /// A watermark computed at the last sync and not written yet (5.6 step 3).
    candidate: Option<u64>,
    /// Holes found by the last sync, filled before the next one (5.6 step 2).
    holes: Vec<u64>,
    synced_once: bool,
    dirty: bool,
    failed: bool,
    /// The record and size must be read again from disk before the next
    /// write: a record write failed and its re-read failed too.
    reload: bool,
}

impl FileState {
    /// The state of a file just born: header and record 0 (`seq = 1, D = 0`)
    /// written and synced (5.6 "Birth").
    pub fn born(file_id: FileId, record: Watermark) -> FileState {
        let mut state = FileState::loaded(
            file_id,
            Layout {
                durable_units: 0,
                size: 0,
                record: Some(record),
            },
        );
        state.synced_once = true;
        state
    }

    /// The state of a file read from disk: nothing known yet.
    pub fn loaded(file_id: FileId, layout: Layout) -> FileState {
        FileState {
            file_id,
            known: Bits::default(),
            winner_b: Bits::default(),
            pending: Bits::default(),
            last: None,
            size: layout.size,
            durable_units: layout.durable_units,
            record: layout.record,
            wm_pending: false,
            candidate: None,
            holes: Vec::new(),
            synced_once: false,
            dirty: false,
            failed: false,
            reload: false,
        }
    }

    pub fn file_id(&self) -> FileId {
        self.file_id
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn durable_units(&self) -> u64 {
        self.durable_units
    }

    /// Written since the last successful sync: the state must not be
    /// dropped (6.6 (c)).
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// A host sync of the file failed: writes are refused until restart.
    pub fn has_failed(&self) -> bool {
        self.failed
    }

    /// A3 for a host sync encfs made of this file outside the state (a
    /// birth's, or one through a descriptor that held no state): nothing a
    /// later sync reports can be trusted, so writes and syncs stop until
    /// restart (6.5).
    pub fn fail_stop(&mut self) {
        self.failed = true;
    }

    fn known(&self, unit: u64) -> Option<Slot> {
        self.known.get(unit).then(|| {
            if self.winner_b.get(unit) {
                Slot::B
            } else {
                Slot::A
            }
        })
    }

    fn pending(&self, unit: u64) -> bool {
        self.pending.get(unit)
    }

    fn remember(&mut self, unit: u64, winner: Slot, pending: bool) {
        self.known.set(unit, true);
        self.winner_b.set(unit, winner == Slot::B);
        self.pending.set(unit, pending);
    }

    fn forget(&mut self, unit: u64) {
        self.known.set(unit, false);
        self.winner_b.set(unit, false);
        self.pending.set(unit, false);
        if self.last.is_some_and(|(u, ..)| u == unit) {
            self.last = None;
        }
    }

    /// Drop the state of every unit at or above `units` (6.4, 6.6 (f)).
    fn drop_from(&mut self, units: u64) {
        self.known.keep_below(units);
        self.winner_b.keep_below(units);
        self.pending.keep_below(units);
        if self.last.is_some_and(|(u, ..)| u >= units) {
            self.last = None;
        }
        self.holes.retain(|&u| u < units);
    }

    /// The bookkeeping of a successful host sync of the file: every version
    /// on disk is durable now.
    fn synced(&mut self) {
        self.pending.clear();
        self.wm_pending = false;
        self.dirty = false;
        self.synced_once = true;
    }
}

/// A codec-4 file being read or written through its state.
pub struct IntegrityFile<'a, S: Durable, N: Nonces> {
    pub file: SlotFile<'a, S>,
    pub state: &'a mut FileState,
    pub nonces: &'a mut N,
    /// Whether the descriptor may write: syncs through a read-only one write
    /// neither a due record nor hole fills.
    pub writable: bool,
}

type Result_<T, E> = Result<T, SlotError<E>>;

/// A unit resolved for a write (W1).
struct Resolved {
    /// The winner: its slot and generation.
    winner: Option<(Slot, u64)>,
    /// The winner's plaintext, read only when the write needs it (W2).
    plain: Option<Vec<u8>>,
}

/// One planned slot write (W3, W4).
struct Planned {
    unit: u64,
    target: Slot,
    generation: u64,
    sealed: Vec<u8>,
    /// No valid slot before the write: may join a coalesced extension (W5).
    fresh: bool,
}

impl<S: Durable, N: Nonces> IntegrityFile<'_, S, N> {
    fn integrity<T>(integrity: Integrity) -> Result_<T, S::Error> {
        Err(SlotError::Integrity(integrity))
    }

    pub fn size(&self) -> u64 {
        self.state.size
    }

    // ------------------------------------------------------------ reads

    /// Read up to `len` bytes at `offset` (8.1). Returns the data and whether
    /// it reaches the end of the file.
    pub fn read(&mut self, len: u64, offset: u64) -> Result_<(Vec<u8>, bool), S::Error> {
        let size = self.state.size;
        if offset >= size || len == 0 {
            return Ok((Vec::new(), offset >= size));
        }
        let end = offset.saturating_add(len).min(size);
        let (first, last) = (offset / UNIT, (end - 1) / UNIT);
        let all_known = (first..=last).all(|u| self.state.known(u).is_some());
        // One contiguous read over the pairs unless every winner is known.
        let pairs = if all_known {
            None
        } else {
            Some(self.file.read_pairs(first, last - first + 1)?)
        };
        let mut plain = Vec::with_capacity(((last - first + 1) * UNIT) as usize);
        for unit in first..=last {
            let pair = pairs.as_ref().map(|pairs| {
                let at = ((unit - first) * PAIR_LEN) as usize;
                let pair = pairs.get(at..).unwrap_or_default();
                &pair[..pair.len().min(PAIR_LEN as usize)]
            });
            let mut bytes = match self.read_unit(unit, pair)? {
                Some(bytes) => bytes,
                // A hole of an unsynced extension reads as zeros (C14).
                None if unit >= self.state.durable_units => Vec::new(),
                None => return Self::integrity(Integrity::Erased { unit }),
            };
            // A short interior winner is followed by zeros (C7).
            bytes.resize(UNIT.min(size - unit * UNIT) as usize, 0);
            plain.extend_from_slice(&bytes);
        }
        let start = (offset - first * UNIT) as usize;
        let data = plain[start..start + (end - offset) as usize].to_vec();
        Ok((data, end == size))
    }

    /// The plaintext of `unit`'s winner, `None` when it has no valid slot.
    /// `pair` is the pair's bytes when they were read already.
    fn read_unit(&mut self, unit: u64, pair: Option<&[u8]>) -> Result_<Option<Vec<u8>>, S::Error> {
        if let Some(slot) = self.state.known(unit) {
            let at = slot as usize * SLOT_LEN as usize;
            let bytes = match pair {
                Some(pair) => pair.get(at..).unwrap_or_default().to_vec(),
                None => self
                    .file
                    .storage
                    .read_at(slot_offset(unit, slot), SLOT_LEN)?,
            };
            return match open_slot(self.file.keys, &self.file.file_id, unit, slot, &bytes) {
                Some(opened) => Ok(Some(opened.plain)),
                None => self.changed_underneath(unit),
            };
        }
        let pair = match pair {
            Some(pair) => pair.to_vec(),
            None => self.file.read_pairs(unit, 1)?,
        };
        // 6.6 (b): a unit without an entry was not written since the last
        // successful sync, so its winner is clean.
        Ok(self.file.select(unit, &pair)?.map(|winner| {
            self.state.remember(unit, winner.slot, false);
            winner.plain
        }))
    }

    /// 6.6 (a): a cached winner failed verification, so the volume changed
    /// under encfs. Re-select from disk keeping the `pending` bit, and sync
    /// before the next write trusts any bit again.
    fn changed_underneath<T>(&mut self, unit: u64) -> Result_<T, S::Error> {
        let pending = self.state.pending(unit);
        let reselected = self
            .file
            .read_pairs(unit, 1)
            .ok()
            .and_then(|pair| self.file.select(unit, &pair).ok().flatten());
        self.state.forget(unit);
        if let Some(winner) = reselected {
            self.state.remember(unit, winner.slot, pending);
        }
        self.state.synced_once = false;
        Self::integrity(Integrity::Changed { unit })
    }

    // ------------------------------------------------------------ writes

    /// Write `data` at `offset`, zero-filling any gap after the end (6.3).
    pub fn write(&mut self, offset: u64, data: &[u8]) -> Result_<(), S::Error> {
        let end = offset
            .checked_add(data.len() as u64)
            .filter(|&end| end <= MAX_SIZE)
            .ok_or(SlotError::TooLarge)?;
        if offset.saturating_sub(self.state.size) > MAX_GAP {
            return Err(SlotError::TooLarge);
        }
        if self.state.failed {
            return Err(SlotError::FailStopped);
        }
        if end <= self.state.size && data.is_empty() {
            return Ok(());
        }
        self.prepare()?;
        while self.state.size < offset {
            let fill = (offset - self.state.size).min(FILL_CHUNK);
            self.write_within(self.state.size, &vec![0; fill as usize])?;
        }
        if !data.is_empty() {
            self.write_within(offset, data)?;
        }
        self.flush_candidate()
    }

    /// W0, the interrupted-birth re-seal (C8a) and a reload after an unknown
    /// record write; refuses a fail-stopped file.
    fn prepare(&mut self) -> Result_<(), S::Error> {
        if self.state.failed {
            return Err(SlotError::FailStopped);
        }
        let w0 = !self.state.synced_once;
        if w0 {
            self.sync_host(false)?;
        }
        if self.state.reload {
            let layout = self.file.layout()?;
            self.state.size = layout.size;
            self.state.durable_units = layout.durable_units;
            self.state.record = layout.record;
            self.state.candidate = None;
            self.state.holes.clear();
            self.state.reload = false;
        }
        if w0 {
            self.next_candidate();
        }
        if self.state.record.is_none() {
            // The header without a valid record: re-seal record 0 as a birth
            // does, and sync it before any pair (5.6).
            self.put_record(0, 1, 0)?;
            self.sync_host(false)?;
        }
        Ok(())
    }

    /// A host sync and, when it succeeds, its bookkeeping; a failure stops
    /// every later write (A3).
    fn sync_host(&mut self, all: bool) -> Result_<(), S::Error> {
        let synced = if all {
            self.file.storage.sync_all()
        } else {
            self.file.storage.sync_data()
        };
        if let Err(error) = synced {
            self.state.failed = true;
            return Err(SlotError::Storage(error));
        }
        self.state.synced();
        Ok(())
    }

    /// Resolve `unit` (W1). `pair` is its pair's bytes when they were read.
    fn resolve(
        &mut self,
        unit: u64,
        pair: Option<&[u8]>,
        need_plain: bool,
    ) -> Result_<Resolved, S::Error> {
        if let Some(slot) = self.state.known(unit) {
            if let Some((_, last_slot, generation)) =
                self.state.last.filter(|&(u, s, _)| u == unit && s == slot)
            {
                if !need_plain {
                    return Ok(Resolved {
                        winner: Some((last_slot, generation)),
                        plain: None,
                    });
                }
            }
            // The generation is not cached: read and verify the winner.
            let bytes = self
                .file
                .storage
                .read_at(slot_offset(unit, slot), SLOT_LEN)?;
            return match open_slot(self.file.keys, &self.file.file_id, unit, slot, &bytes) {
                Some(opened) => Ok(Resolved {
                    winner: Some((slot, opened.generation)),
                    plain: Some(opened.plain),
                }),
                None => self.changed_underneath(unit),
            };
        }
        let pair = match pair {
            Some(pair) => pair.to_vec(),
            None => self.file.read_pairs(unit, 1)?,
        };
        // Only a slot whose tag verified can win, whole-unit writes
        // included (C13).
        Ok(match self.file.select(unit, &pair)? {
            Some(winner) => {
                self.state.remember(unit, winner.slot, false);
                Resolved {
                    winner: Some((winner.slot, winner.generation)),
                    plain: Some(winner.plain),
                }
            }
            None => Resolved {
                winner: None,
                plain: None,
            },
        })
    }

    /// The target slot and generation of a write to `unit` (6.2).
    fn target(&self, unit: u64, winner: Option<(Slot, u64)>) -> Result_<(Slot, u64), S::Error> {
        let Some((slot, generation)) = winner else {
            return Ok((Slot::A, 1));
        };
        let generation = generation.checked_add(1).ok_or(SlotError::Integrity(
            Integrity::GenerationExhausted { unit },
        ))?;
        Ok(if self.state.pending(unit) {
            (slot, generation)
        } else {
            (slot.other(), generation)
        })
    }

    /// Write `data` at `offset <= size`: one slot write per unit, with new
    /// units coalesced into one host write (W1-W6).
    fn write_within(&mut self, offset: u64, data: &[u8]) -> Result_<(), S::Error> {
        debug_assert!(offset <= self.state.size && !data.is_empty());
        let size = self.state.size;
        let end = offset + data.len() as u64;
        let new_size = size.max(end);
        let (first, last) = (offset / UNIT, (end - 1) / UNIT);
        // One read over the pairs of the units that are not known yet.
        let unknown: Vec<u64> = (first..=last)
            .filter(|&u| self.state.known(u).is_none())
            .collect();
        let pairs = match (unknown.first(), unknown.last()) {
            (Some(&lo), Some(&hi)) => Some((lo, self.file.read_pairs(lo, hi - lo + 1)?)),
            _ => None,
        };
        let mut plan = Vec::with_capacity((last - first + 1) as usize);
        for unit in first..=last {
            let unit_start = unit * UNIT;
            let new_len = UNIT.min(new_size - unit_start) as usize;
            let whole = offset <= unit_start && end >= unit_start + new_len as u64;
            let pair = pairs.as_ref().and_then(|(lo, bytes)| {
                let at = ((unit.checked_sub(*lo)?) * PAIR_LEN) as usize;
                let pair = bytes.get(at..).unwrap_or_default();
                Some(&pair[..pair.len().min(PAIR_LEN as usize)])
            });
            let resolved = self.resolve(unit, pair, !whole)?;
            // W2: the plaintext.
            let mut plain = vec![0u8; new_len];
            if !whole {
                match (&resolved.winner, resolved.plain) {
                    (Some(_), Some(old)) => {
                        let keep = old.len().min(new_len);
                        plain[..keep].copy_from_slice(&old[..keep]);
                    }
                    // A hole above D reads as zeros (8.3).
                    (None, _) if unit >= self.state.durable_units => {}
                    // A partial write of an erased unit (6.5).
                    _ => return Self::integrity(Integrity::Erased { unit }),
                }
            }
            let from = offset.max(unit_start);
            let to = end.min(unit_start + new_len as u64);
            plain[(from - unit_start) as usize..(to - unit_start) as usize]
                .copy_from_slice(&data[(from - offset) as usize..(to - offset) as usize]);
            let (target, generation) = self.target(unit, resolved.winner)?;
            let nonce = self.nonces.draw();
            let sealed = seal_slot(
                self.file.keys,
                &self.file.file_id,
                unit,
                target,
                generation,
                &plain,
                &nonce,
            );
            plan.push(Planned {
                unit,
                target,
                generation,
                sealed,
                fresh: resolved.winner.is_none(),
            });
        }
        self.emit(plan, new_size)
    }

    /// W5 and W6 for a planned write. Consecutive units without a valid slot
    /// go out as one host write: slot A images with the zero slot-B gaps
    /// between them. A unit with a valid slot is written alone, so no
    /// coalesced gap ever covers a slot that holds a version.
    fn emit(&mut self, plan: Vec<Planned>, new_size: u64) -> Result_<(), S::Error> {
        let mut index = 0;
        while index < plan.len() {
            let mut run = index + 1;
            if plan[index].fresh {
                while run < plan.len()
                    && plan[run].fresh
                    && plan[run].unit == plan[run - 1].unit + 1
                {
                    run += 1;
                }
            }
            let group = &plan[index..run];
            let at = slot_offset(group[0].unit, group[0].target);
            let bytes = if group.len() == 1 {
                group[0].sealed.clone()
            } else {
                let mut bytes = Vec::with_capacity(group.len() * PAIR_LEN as usize);
                for (i, planned) in group.iter().enumerate() {
                    bytes.extend_from_slice(&planned.sealed);
                    if i + 1 < group.len() {
                        bytes.resize((i + 1) * PAIR_LEN as usize, 0);
                    }
                }
                bytes
            };
            if let Err(error) = self.file.storage.write_at(at, &bytes) {
                for planned in group {
                    self.failed_write(planned.unit, planned.target);
                }
                self.refresh_size();
                return Err(SlotError::Storage(error));
            }
            for planned in group {
                // W6.
                self.state.remember(planned.unit, planned.target, true);
                self.state.last = Some((planned.unit, planned.target, planned.generation));
            }
            self.state.dirty = true;
            index = run;
        }
        self.state.size = new_size;
        Ok(())
    }

    /// 6.6 (e): W5 failed, so the target holds unknown bytes. Re-select from
    /// disk; the unit is pending exactly when the failed target won.
    fn failed_write(&mut self, unit: u64, target: Slot) {
        self.state.dirty = true;
        self.state.forget(unit);
        match self
            .file
            .read_pairs(unit, 1)
            .map(|pair| self.file.select(unit, &pair))
        {
            Ok(Ok(Some(winner))) => {
                let pending = winner.slot == target;
                self.state.remember(unit, winner.slot, pending);
            }
            // A new unit whose first write failed: nothing durable to
            // protect. It reads as zeros above D and is a hole (5.6).
            Ok(Ok(None)) => {}
            // The re-read failed: trust no bit before a sync.
            _ => self.state.synced_once = false,
        }
    }

    /// The size after a failed write, from disk; until it is known, the next
    /// write reloads it.
    fn refresh_size(&mut self) {
        let size = self
            .file
            .storage
            .size()
            .map_err(SlotError::Storage)
            .and_then(|physical| self.file.size_below(physical, self.state.durable_units));
        match size {
            Ok(size) => self.state.size = size,
            Err(_) => {
                self.state.reload = true;
                self.state.synced_once = false;
            }
        }
    }

    // ------------------------------------------------------------ watermark

    /// Write a watermark record claiming `durable_units` (5.6, two-slot rule).
    fn write_record(&mut self, durable_units: u64) -> Result_<(), S::Error> {
        self.prepare()?;
        let record = self
            .state
            .record
            .expect("prepare re-seals a missing record");
        let index = if self.state.wm_pending {
            record.record
        } else {
            1 - record.record
        };
        let seq = record
            .seq
            .checked_add(1)
            .ok_or(SlotError::Integrity(Integrity::SequenceExhausted))?;
        self.put_record(index, seq, durable_units)
    }

    /// Seal and write one record; on failure, re-select from disk.
    fn put_record(&mut self, index: u8, seq: u64, durable_units: u64) -> Result_<(), S::Error> {
        let nonce = self.nonces.draw();
        let bytes = seal_record(
            self.file.keys,
            &self.file.file_id,
            index,
            seq,
            durable_units,
            &nonce,
        );
        self.state.dirty = true;
        if let Err(error) = self
            .file
            .storage
            .write_at(RECORD_AT[index as usize], &bytes)
        {
            self.failed_record(index);
            return Err(SlotError::Storage(error));
        }
        self.state.record = Some(Watermark {
            record: index,
            seq,
            durable_units,
        });
        self.state.durable_units = durable_units;
        self.state.wm_pending = true;
        Ok(())
    }

    /// 6.6 (e) for a record: pending exactly when the failed target won.
    fn failed_record(&mut self, index: u8) {
        let span = RECORD_AT[1] - RECORD_AT[0] + RECORD_LEN as u64;
        let reread = self.file.storage.read_at(RECORD_AT[0], span);
        match reread.map(|pages| select_watermark(self.file.keys, &self.file.file_id, &pages)) {
            Ok(Ok(Some(winner))) => {
                self.state.wm_pending = winner.record == index;
                self.state.durable_units = winner.durable_units;
                self.state.record = Some(winner);
            }
            _ => {
                self.state.reload = true;
                self.state.synced_once = false;
            }
        }
    }

    /// Write a due watermark (5.6 step 3).
    fn flush_candidate(&mut self) -> Result_<(), S::Error> {
        match self.state.candidate.take() {
            Some(candidate) if candidate > self.state.durable_units => {
                if let Err(error) = self.write_record(candidate) {
                    // Still due: retried with the next write or sync.
                    self.state.candidate = Some(candidate);
                    return Err(error);
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// After a successful sync: the next watermark (5.6 steps 1 and 2). It
    /// extends `D` over consecutive units with a known clean winner,
    /// verifying at most [`VERIFY_PER_SYNC`] unknown pairs, and notes the
    /// holes it finds. It replaces any candidate not written yet.
    fn next_candidate(&mut self) {
        let units = self.state.size.div_ceil(UNIT);
        let mut durable = self.state.durable_units;
        let mut extending = true;
        let mut budget = VERIFY_PER_SYNC;
        let mut holes = Vec::new();
        for unit in self.state.durable_units..units {
            if self.state.known(unit).is_some() {
                // Every bit is clean right after a sync.
                if extending && !self.state.pending(unit) {
                    durable = unit + 1;
                } else {
                    extending = false;
                }
                continue;
            }
            if budget == 0 {
                break;
            }
            budget -= 1;
            match self
                .file
                .read_pairs(unit, 1)
                .and_then(|pair| self.file.select(unit, &pair))
            {
                Ok(Some(winner)) => {
                    self.state.remember(unit, winner.slot, false);
                    if extending {
                        durable = unit + 1;
                    }
                }
                Ok(None) => {
                    holes.push(unit);
                    extending = false;
                }
                Err(_) => break,
            }
        }
        self.state.candidate = (durable > self.state.durable_units).then_some(durable);
        self.state.holes = holes;
    }

    /// Fill the holes the last sync found with sealed zero units, through
    /// the write path, so they can join `D` after the next sync (5.6 step 2).
    /// A unit written since is no longer a hole and is left alone.
    fn fill_holes(&mut self) -> Result_<(), S::Error> {
        for unit in std::mem::take(&mut self.state.holes) {
            if unit * UNIT >= self.state.size || self.state.known(unit).is_some() {
                continue;
            }
            let pair = self.file.read_pairs(unit, 1)?;
            if let Some(winner) = self.file.select(unit, &pair)? {
                self.state.remember(unit, winner.slot, false);
                continue;
            }
            let len = UNIT.min(self.state.size - unit * UNIT);
            self.write_within(unit * UNIT, &vec![0; len as usize])?;
        }
        Ok(())
    }

    /// `sync` or `sync-data` of the file (6.3 "Sync"): fill the holes found
    /// at the previous sync and write a due watermark first, so this sync
    /// makes them durable; then the host call; then the next candidate.
    pub fn sync(&mut self, all: bool) -> Result_<(), S::Error> {
        if self.state.failed {
            // Nothing a later sync reports can be trusted (A3).
            return Err(SlotError::FailStopped);
        }
        if self.writable && (self.state.candidate.is_some() || !self.state.holes.is_empty()) {
            self.prepare()?;
            self.fill_holes()?;
            self.flush_candidate()?;
        }
        self.sync_host(all)?;
        self.next_candidate();
        Ok(())
    }

    // ------------------------------------------------------------ resizes

    /// Set the logical size (6.4): grow by zero fill, shrink in three steps
    /// (lower the watermark, truncate, sync), then rewrite a cut unit.
    pub fn set_size(&mut self, new_size: u64) -> Result_<(), S::Error> {
        if self.state.failed {
            return Err(SlotError::FailStopped);
        }
        if new_size >= self.state.size {
            return self.write(new_size, &[]);
        }
        if self.state.reload {
            self.prepare()?;
        }
        let (unit, keep) = (new_size / UNIT, new_size % UNIT);
        let remaining = if keep > 0 { unit + 1 } else { unit };
        // 1. Lower the watermark; an unwritten candidate is discarded.
        self.state.candidate = None;
        if self.state.durable_units > remaining {
            self.write_record(remaining)?;
        }
        // 2. Truncate to the end of the last remaining pair.
        let end = PAIRS_START + remaining * PAIR_LEN;
        let physical = self.file.storage.size()?;
        if physical > end {
            if let Err(error) = self.file.storage.set_len(end) {
                // The truncate may have happened: the removed units' bits go
                // with it, and W0 syncs before any bit is trusted again.
                self.state.drop_from(remaining);
                self.state.reload = true;
                self.state.synced_once = false;
                return Err(SlotError::Storage(error));
            }
        }
        self.state.drop_from(remaining);
        self.state.size = self.state.size.min(remaining * UNIT);
        // 3. Sync before the next write.
        self.sync_host(false)?;
        self.next_candidate();
        // 4. A shrink inside a unit rewrites it with the new length.
        if keep > 0 {
            self.prepare()?;
            let resolved = self.resolve(unit, None, true)?;
            let mut plain = vec![0u8; keep as usize];
            match (&resolved.winner, resolved.plain) {
                (Some(_), Some(old)) => {
                    let n = old.len().min(plain.len());
                    plain[..n].copy_from_slice(&old[..n]);
                }
                (None, _) if unit >= self.state.durable_units => {}
                _ => return Self::integrity(Integrity::Erased { unit }),
            }
            let (target, generation) = self.target(unit, resolved.winner)?;
            let nonce = self.nonces.draw();
            let sealed = seal_slot(
                self.file.keys,
                &self.file.file_id,
                unit,
                target,
                generation,
                &plain,
                &nonce,
            );
            let fresh = resolved.winner.is_none();
            self.emit(
                vec![Planned {
                    unit,
                    target,
                    generation,
                    sealed,
                    fresh,
                }],
                new_size,
            )?;
            self.state.size = new_size;
            self.flush_candidate()?;
        }
        Ok(())
    }
}

/// Bring a codec-4 file into existence (5.6 "Birth"): write its birth block
/// and sync it before any pair can follow. Returns the new file's state.
/// When the write fails there is no state: the header may or may not have
/// landed, and the next write re-seals record 0 (C8a). When the sync fails,
/// the state is returned fail-stopped with the error (A3, 6.5), for the
/// caller to keep before it reports the failure: a later sync of the same
/// pages can report success although they never reached the disk.
pub fn give_birth<S: Durable>(
    storage: &S,
    keys: &crate::slots::SlotKeys,
    file_id: FileId,
    header: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<FileState, (S::Error, Option<Box<FileState>>)> {
    let (block, record) = birth_block(keys, &file_id, header, nonce);
    storage.write_at(0, &block).map_err(|error| (error, None))?;
    let mut state = FileState::born(file_id, record);
    if let Err(error) = storage.sync_data() {
        state.fail_stop();
        return Err((error, Some(Box::new(state))));
    }
    Ok(state)
}

/// The 12 KiB birth block of a codec-4 file (5.6 "Birth"): the header page
/// with `header`, record 0 sealed as `seq = 1, D = 0`, record page 1 zero.
pub fn birth_block(
    keys: &crate::slots::SlotKeys,
    file_id: &FileId,
    header: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> (Vec<u8>, Watermark) {
    let mut block = vec![0u8; PAIRS_START as usize];
    block[..header.len()].copy_from_slice(header);
    let record = seal_record(keys, file_id, 0, 1, 0, nonce);
    block[RECORD_AT[0] as usize..RECORD_AT[0] as usize + RECORD_LEN].copy_from_slice(&record);
    (
        block,
        Watermark {
            record: 0,
            seq: 1,
            durable_units: 0,
        },
    )
}

#[cfg(test)]
impl FileState {
    /// A unit's cached winner and `pending` bit.
    pub(crate) fn unit(&self, unit: u64) -> Option<(Slot, bool)> {
        self.known(unit).map(|slot| (slot, self.pending(unit)))
    }

    pub(crate) fn candidate(&self) -> Option<u64> {
        self.candidate
    }

    pub(crate) fn holes(&self) -> &[u64] {
        &self.holes
    }

    pub(crate) fn synced_once(&self) -> bool {
        self.synced_once
    }

    pub(crate) fn wm_pending(&self) -> bool {
        self.wm_pending
    }

    pub(crate) fn record(&self) -> Option<Watermark> {
        self.record
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crash_tests::{keys, logical, Bench, Counter, Fail, FILE_ID};
    use crate::file::tests::XorShift;
    use crate::slots::testing::Image;

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed) | 1)
            .collect()
    }

    const U: usize = UNIT as usize;

    /// The generation a slot on the page cache claims.
    fn generation(bench: &Bench, unit: u64, slot: Slot) -> u64 {
        let at = slot_offset(unit, slot) as usize;
        u64::from_le_bytes(bench.volatile()[at..at + 8].try_into().unwrap())
    }

    fn last_write(bench: &Bench) -> (u64, usize) {
        *bench.rec.writes.borrow().last().unwrap()
    }

    /// The last write into a pair, skipping a lazy record write after it.
    fn last_slot_write(bench: &Bench) -> (u64, usize) {
        *bench
            .rec
            .writes
            .borrow()
            .iter()
            .rev()
            .find(|(at, _)| *at >= PAIRS_START)
            .unwrap()
    }

    fn slot_write(unit: u64, slot: Slot, len: usize) -> (u64, usize) {
        (slot_offset(unit, slot), SLOT_HEADER_LEN + len)
    }

    const SLOT_HEADER_LEN: usize = crate::slots::SLOT_HEADER;

    /// The watermark on the durable image.
    fn durable_watermark(bench: &Bench) -> u64 {
        logical(&bench.keys, &bench.rec.durable.borrow())
            .unwrap()
            .1
            .durable_units
    }

    fn on_image(image: &Image) -> Bench {
        Bench::restart(keys(), image.bytes.clone(), Counter::default())
    }

    #[test]
    fn targets_follow_the_durable_slot_rule() {
        // 6.2 and C10: a pending unit overwrites its pending slot, a clean
        // one writes the other slot; the issue's "older generation" rule
        // would overwrite the durable slot on the second unsynced write.
        let mut bench = Bench::born();
        bench.write(0, &pattern(U, 1)).unwrap();
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::A, U));
        bench.sync().unwrap();
        bench.write(0, &pattern(U, 2)).unwrap();
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::B, U));
        bench.write(0, &pattern(U, 3)).unwrap();
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::B, U));
        assert_eq!(generation(&bench, 0, Slot::B), 3);
        bench.sync().unwrap();
        bench.write(0, &pattern(U, 4)).unwrap();
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::A, U));
        assert_eq!(generation(&bench, 0, Slot::A), 4);
        assert_eq!(bench.read_all().unwrap(), pattern(U, 4));
        assert_eq!(
            logical(&bench.keys, &bench.volatile()).unwrap().0,
            pattern(U, 4)
        );
    }

    #[test]
    fn a_cold_whole_unit_write_targets_a_torn_newer_slot() {
        // C13: slot A holds v1 (generation 5), slot B is torn and claims 6.
        // A whole-unit write authenticates the pair first, so it targets B.
        let keys = keys();
        let mut image = Image::born(&keys, FILE_ID, b"header");
        image.slot(0, Slot::A, 5, &pattern(U, 1));
        let newer = image.sealed_slot(0, Slot::B, 6, &pattern(U, 2));
        image.put(slot_offset(0, Slot::B), &newer[..512]);
        image.record(1, 2, 1);
        let slot_a = image.bytes[slot_offset(0, Slot::A) as usize..][..64 + U].to_vec();
        let mut bench = on_image(&image);
        bench.write(0, &pattern(U, 3)).unwrap();
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::B, U));
        assert_eq!(generation(&bench, 0, Slot::B), 6);
        let page = bench.volatile();
        assert_eq!(page[slot_offset(0, Slot::A) as usize..][..64 + U], slot_a);
        // W0 synced before the write.
        assert_eq!(bench.rec.syncs.get(), 1);
        assert!(bench.rec.finished.borrow()[0].ops.is_empty());
    }

    #[test]
    fn failed_writes_are_pending_exactly_when_their_target_won() {
        // 6.6 (e), for a clean and a pending unit, with nothing or
        // everything landed.
        for pending_before in [false, true] {
            for fail in [Fail::Nothing, Fail::All] {
                let mut bench = Bench::born();
                bench.write(0, &pattern(U, 1)).unwrap();
                bench.sync().unwrap();
                if pending_before {
                    bench.write(0, &pattern(U, 2)).unwrap();
                }
                bench.rec.fail_write.set(Some(fail));
                assert!(bench.write(0, &pattern(U, 3)).is_err());
                // Clean or pending, the target was B.
                let (winner, pending) = bench.state.unit(0).unwrap();
                let expected = match (fail, pending_before) {
                    (Fail::All, _) => (Slot::B, pattern(U, 3)),
                    (_, true) => (Slot::B, pattern(U, 2)),
                    (_, false) => (Slot::A, pattern(U, 1)),
                };
                let case = format!("pending {pending_before}, {fail:?}");
                assert_eq!(winner, expected.0, "{case}");
                assert_eq!(pending, winner == Slot::B, "{case}");
                assert_eq!(bench.read_all().unwrap(), expected.1, "{case}");
                // The next write never targets the durable slot (the
                // storage guard checks every write) and retries B.
                bench.write(0, &pattern(U, 4)).unwrap();
                assert_eq!(last_slot_write(&bench), slot_write(0, Slot::B, U), "{case}");
                assert_eq!(bench.read_all().unwrap(), pattern(U, 4), "{case}");
            }
        }
    }

    #[test]
    fn a_failed_first_write_leaves_a_hole_that_is_filled_and_covered() {
        // 6.6 (e) and 5.6 step 2: a new unit whose first write failed has
        // no valid slot; it reads as zeros, is filled with a sealed zero
        // unit after a sync, and then joins the watermark.
        let mut bench = Bench::born();
        bench.write(0, &pattern(U, 1)).unwrap();
        bench.rec.fail_write.set(Some(Fail::Nothing));
        assert!(bench.write(UNIT, &pattern(U, 2)).is_err());
        assert_eq!(bench.state.unit(1), None);
        assert_eq!(bench.state.size(), UNIT);
        // Unit 2 is written by a separate host write: unit 1 is a hole.
        bench.rec.fail_write.set(None);
        let keys = bench.keys.clone();
        let mut image = Image::born(&keys, FILE_ID, b"header");
        image.slot(0, Slot::A, 1, &pattern(U, 1));
        image.slot(2, Slot::A, 1, &pattern(10, 3));
        let mut bench = on_image(&image);
        assert_eq!(
            bench.read_all().unwrap(),
            [pattern(U, 1), vec![0; U], pattern(10, 3)].concat()
        );
        bench.sync().unwrap();
        assert_eq!(bench.state.candidate(), Some(1));
        assert_eq!(bench.state.holes(), &[1]);
        bench.sync().unwrap();
        // The fill and the record went out before this sync's host call.
        assert_eq!(durable_watermark(&bench), 1);
        assert_eq!(generation(&bench, 1, Slot::A), 1);
        assert_eq!(bench.state.candidate(), Some(3));
        bench.sync().unwrap();
        assert_eq!(durable_watermark(&bench), 3);
        assert_eq!(
            logical(&bench.keys, &bench.rec.durable.borrow()).unwrap().0,
            [pattern(U, 1), vec![0; U], pattern(10, 3)].concat()
        );
    }

    #[test]
    fn the_watermark_advances_lazily_and_only_after_syncs() {
        let mut bench = Bench::born();
        bench.write(0, &pattern(3 * U, 1)).unwrap();
        assert_eq!(bench.state.durable_units(), 0);
        bench.sync().unwrap();
        // Computed, not written: the next write or sync carries it.
        assert_eq!(bench.state.candidate(), Some(3));
        assert_eq!(durable_watermark(&bench), 0);
        bench.write(10, b"x").unwrap();
        assert_eq!(last_write(&bench), (RECORD_AT[1], RECORD_LEN));
        assert_eq!(bench.state.durable_units(), 3);
        assert_eq!(durable_watermark(&bench), 0);
        bench.sync().unwrap();
        assert_eq!(durable_watermark(&bench), 3);
        // A new candidate replaces an unwritten one; a sync with no write
        // in between writes the due record before its host call.
        bench.write(3 * UNIT, &pattern(2 * U, 2)).unwrap();
        bench.sync().unwrap();
        assert_eq!(bench.state.candidate(), Some(5));
        bench.sync().unwrap();
        assert_eq!(durable_watermark(&bench), 5);
        // Never at close: a clean file's state is dropped with its
        // candidate, and the older D stays in force.
        bench.write(5 * UNIT, &pattern(U, 3)).unwrap();
        bench.sync().unwrap();
        assert_eq!(bench.state.candidate(), Some(6));
        let writes = bench.rec.writes.borrow().len();
        bench.drop_state().unwrap();
        assert_eq!(bench.rec.writes.borrow().len(), writes);
        assert_eq!(durable_watermark(&bench), 5);
        assert_eq!(bench.state.durable_units(), 5);
    }

    #[test]
    fn records_alternate_and_touch_only_their_own_page() {
        // Two-slot rule for records (5.6), and the layout of 12.1: a record
        // write is 64 bytes at the start of its page; the header page and
        // the other record page are never written after birth.
        let mut bench = Bench::born();
        let mut records = Vec::new();
        for round in 0..4u8 {
            bench
                .write(round as u64 * UNIT, &pattern(U, round))
                .unwrap();
            bench.sync().unwrap();
            let before = bench.volatile();
            bench.sync().unwrap();
            let after = bench.volatile();
            let (at, len) = last_write(&bench);
            assert_eq!(len, RECORD_LEN);
            records.push(at);
            let other = if at == RECORD_AT[0] {
                RECORD_AT[1]
            } else {
                RECORD_AT[0]
            };
            let page = |bytes: &[u8], at: u64| bytes[at as usize..at as usize + 4096].to_vec();
            assert_eq!(page(&before, other), page(&after, other));
            assert_eq!(page(&before, 0), page(&after, 0));
            assert_eq!(before[..at as usize], after[..at as usize]);
            assert_eq!(
                before[at as usize + RECORD_LEN..],
                after[at as usize + RECORD_LEN..]
            );
        }
        // Birth wrote record 0; every clean record write takes the other.
        assert_eq!(
            records,
            [RECORD_AT[1], RECORD_AT[0], RECORD_AT[1], RECORD_AT[0]]
        );
        for &(at, len) in bench.rec.writes.borrow().iter() {
            assert!(at >= PAIRS_START || (RECORD_AT.contains(&at) && len == RECORD_LEN));
        }
        // While a record is pending, the next record write overwrites it.
        bench.write(4 * UNIT, &pattern(U, 9)).unwrap();
        bench.sync().unwrap();
        bench.write(0, b"y").unwrap();
        let pending = last_write(&bench).0;
        bench.write(5 * UNIT, &pattern(U, 9)).unwrap();
        bench.state.candidate = Some(6);
        bench.write(1, b"z").unwrap();
        assert_eq!(last_write(&bench).0, pending);
    }

    #[test]
    fn an_interrupted_birth_is_resealed_before_any_pair() {
        // C8a: a header without a valid record and no room for a pair.
        let keys = keys();
        for physical in [4096usize, 8192 + 10, 12288] {
            let mut disk = vec![0u8; physical];
            disk[..6].copy_from_slice(b"header");
            let mut bench = Bench::restart(keys.clone(), disk, Counter::default());
            assert_eq!(bench.read_all().unwrap(), Vec::<u8>::new());
            bench.write(0, b"hello").unwrap();
            let epochs = bench.rec.finished.borrow().clone();
            // W0, then record 0 alone, synced, then the pair.
            let resealed = epochs
                .iter()
                .position(|e| e.ops.iter().any(|(op, _)| matches!(op, crate::crash_tests::Op::Write(at, _) if *at == RECORD_AT[0])))
                .expect("record 0 re-sealed");
            assert!(epochs[resealed].ops.len() == 1);
            let durable = logical(&keys, &bench.rec.durable.borrow()).unwrap().1;
            assert_eq!(
                durable.record,
                Some(Watermark {
                    record: 0,
                    seq: 1,
                    durable_units: 0
                })
            );
            assert_eq!(last_slot_write(&bench), slot_write(0, Slot::A, 5));
            assert_eq!(logical(&keys, &bench.volatile()).unwrap().0, b"hello");
        }
    }

    #[test]
    fn shrinks_lower_the_watermark_truncate_and_sync_before_the_cut_unit() {
        // 6.4: lower D, truncate to the end of the last pair, sync, then
        // rewrite a unit the shrink cuts.
        let mut bench = Bench::born();
        bench.write(0, &pattern(3 * U, 1)).unwrap();
        bench.sync().unwrap();
        bench.sync().unwrap();
        assert_eq!(durable_watermark(&bench), 3);
        bench.rec.finished.borrow_mut().clear();
        let writes = bench.rec.writes.borrow().len();
        bench.set_size(UNIT + 10).unwrap();
        let epochs = bench.rec.finished.borrow().clone();
        let ops: Vec<_> = epochs
            .iter()
            .flat_map(|e| e.ops.iter().map(|(op, _)| op.clone()))
            .collect();
        assert!(
            matches!(&ops[0], crate::crash_tests::Op::Write(at, data) if *at == RECORD_AT[0] && data.len() == RECORD_LEN)
        );
        assert!(
            matches!(ops[1], crate::crash_tests::Op::SetLen(len) if len == PAIRS_START + 2 * PAIR_LEN)
        );
        assert_eq!(
            ops.len(),
            2,
            "the record and the truncate are synced before the slot write"
        );
        assert_eq!(
            bench.rec.writes.borrow()[writes + 1..].to_vec(),
            vec![slot_write(1, Slot::B, 10)]
        );
        assert_eq!(bench.read_all().unwrap(), pattern(3 * U, 1)[..U + 10]);
        // A shrink to a unit boundary and to 0 keep the record pages.
        bench.set_size(UNIT).unwrap();
        assert_eq!(bench.volatile().len() as u64, PAIRS_START + PAIR_LEN);
        bench.set_size(0).unwrap();
        assert_eq!(bench.volatile().len() as u64, PAIRS_START);
        assert_eq!(durable_watermark(&bench), 0);
        // A unit re-created after the shrink starts at generation 1 in A.
        bench.write(0, b"again").unwrap();
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::A, 5));
        assert_eq!(generation(&bench, 0, Slot::A), 1);
    }

    #[test]
    fn a_shrink_discards_an_unwritten_candidate() {
        // 5.6 "Lowering": a candidate from before a shrink is never written
        // after a re-extension.
        let mut bench = Bench::born();
        bench.write(0, &pattern(3 * U, 1)).unwrap();
        bench.sync().unwrap();
        assert_eq!(bench.state.candidate(), Some(3));
        bench.set_size(UNIT).unwrap();
        bench.write(UNIT, &pattern(2 * U, 2)).unwrap();
        assert!(bench.state.durable_units() <= 1);
        assert!(
            logical(&bench.keys, &bench.volatile())
                .unwrap()
                .1
                .durable_units
                <= 1
        );
    }

    #[test]
    fn a_restart_verifies_at_most_256_pairs_per_sync() {
        let mut bench = Bench::born();
        bench.write(0, &vec![7; 300 * U]).unwrap();
        bench.rec.durable.replace(bench.volatile());
        // A restart before any record covered the units.
        let mut bench = Bench::restart(bench.keys.clone(), bench.volatile(), bench.nonces.clone());
        assert_eq!(bench.state.durable_units(), 0);
        bench.sync().unwrap();
        assert_eq!(bench.state.candidate(), Some(VERIFY_PER_SYNC));
        bench.sync().unwrap();
        assert_eq!(durable_watermark(&bench), VERIFY_PER_SYNC);
        assert_eq!(bench.state.candidate(), Some(300));
    }

    #[test]
    fn extensions_go_out_as_one_write_with_zero_gaps() {
        // W5: the slot-A images of new units and the zero slot-B gaps
        // between them are one host write.
        let mut bench = Bench::born();
        let data = pattern(5 * U - 100, 4);
        bench.write(0, &data).unwrap();
        assert_eq!(
            bench.rec.writes.borrow().clone(),
            vec![(PAIRS_START, 4 * PAIR_LEN as usize + 64 + U - 100)]
        );
        let page = bench.volatile();
        for unit in 0..4 {
            let b = slot_offset(unit, Slot::B) as usize;
            assert!(page[b..b + SLOT_LEN as usize].iter().all(|&x| x == 0));
        }
        assert_eq!(bench.read_all().unwrap(), data);
        // A gap past the end is zero-filled through the same path.
        bench.write(9 * UNIT + 5, b"tail").unwrap();
        let mut expected = data.clone();
        expected.resize(9 * U + 5, 0);
        expected.extend_from_slice(b"tail");
        assert_eq!(bench.read_all().unwrap(), expected);
        assert_eq!(logical(&bench.keys, &bench.volatile()).unwrap().0, expected);
    }

    #[test]
    fn a_failed_sync_stops_every_later_write() {
        // A3 and 6.5: reads keep working.
        let mut bench = Bench::born();
        bench.write(0, b"data").unwrap();
        bench.rec.fail_sync.set(true);
        assert_eq!(bench.sync(), Err(SlotError::Storage(())));
        assert!(bench.state.has_failed());
        assert_eq!(bench.write(0, b"more"), Err(SlotError::FailStopped));
        assert_eq!(bench.set_size(1), Err(SlotError::FailStopped));
        assert_eq!(bench.set_size(100), Err(SlotError::FailStopped));
        assert_eq!(bench.sync(), Err(SlotError::FailStopped));
        assert_eq!(bench.read_all().unwrap(), b"data");
        // So does a failed W0.
        let mut bench = Bench::restart(bench.keys.clone(), bench.volatile(), Counter::default());
        bench.rec.fail_sync.set(true);
        assert_eq!(bench.write(0, b"x"), Err(SlotError::Storage(())));
        assert_eq!(bench.write(0, b"x"), Err(SlotError::FailStopped));
    }

    #[test]
    fn erased_units_below_the_watermark_fail_and_whole_writes_repair_them() {
        // 6.5 and W2.
        let keys = keys();
        let mut image = Image::born(&keys, FILE_ID, b"header");
        for unit in 0..3 {
            image.slot(unit, Slot::A, 1, &pattern(U, unit as u8));
        }
        image.put(slot_offset(1, Slot::A), &[0; 64 + U]);
        image.record(1, 2, 3);
        let mut bench = on_image(&image);
        let erased = Err(SlotError::Integrity(Integrity::Erased { unit: 1 }));
        assert_eq!(bench.file().read(10, UNIT).map(|_| ()), erased);
        assert_eq!(bench.write(UNIT + 5, b"partial"), erased);
        bench.write(UNIT, &pattern(U, 9)).unwrap();
        assert_eq!(bench.file().read(UNIT, UNIT).unwrap().0, pattern(U, 9));
    }

    #[test]
    fn exhausted_generations_and_sequences_fail() {
        let keys = keys();
        let mut image = Image::born(&keys, FILE_ID, b"header");
        image.slot(0, Slot::A, u64::MAX, &pattern(U, 1));
        image.record(1, u64::MAX, 0);
        let mut bench = on_image(&image);
        assert_eq!(
            bench.write(0, &pattern(U, 2)),
            Err(SlotError::Integrity(Integrity::GenerationExhausted {
                unit: 0
            }))
        );
        // W0 found unit 0 durable: the record claiming it has no seq left.
        assert_eq!(bench.state.candidate(), Some(1));
        assert_eq!(
            bench.sync(),
            Err(SlotError::Integrity(Integrity::SequenceExhausted))
        );
    }

    #[test]
    fn a_cached_winner_that_stops_verifying_is_refused_and_resynced() {
        // 6.6 (a): the volume changed under encfs.
        let mut bench = Bench::born();
        bench.write(0, &pattern(U, 1)).unwrap();
        bench.sync().unwrap();
        bench.write(0, &pattern(U, 2)).unwrap();
        assert_eq!(bench.state.unit(0), Some((Slot::B, true)));
        bench.rec.volatile.borrow_mut()[slot_offset(0, Slot::B) as usize + 100] ^= 1;
        assert_eq!(
            bench.file().read(10, 0).map(|_| ()),
            Err(SlotError::Integrity(Integrity::Changed { unit: 0 }))
        );
        // Re-selected from disk keeping the pending bit, and W0 again.
        assert_eq!(bench.state.unit(0), Some((Slot::A, true)));
        assert!(!bench.state.synced_once());
        let syncs = bench.rec.syncs.get();
        bench.write(0, &pattern(U, 3)).unwrap();
        assert_eq!(bench.rec.syncs.get(), syncs + 1);
        // After W0's sync slot A is durable, so the write takes B.
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::B, U));
    }

    #[test]
    fn failed_record_writes_are_pending_exactly_when_their_target_won() {
        // 6.6 (e) for records, for a clean record (the write targets the
        // other one) and a pending one (the write overwrites it), with
        // nothing, everything or half of it landed. The retry never targets
        // the durable record (the storage guard checks every write).
        for pending_before in [false, true] {
            for fail in [Fail::Nothing, Fail::All, Fail::Half] {
                let case = format!("pending {pending_before}, {fail:?}");
                let mut bench = Bench::born();
                bench.write(0, &pattern(3 * U, 1)).unwrap();
                bench.sync().unwrap();
                // Record 0 (the birth's) is durable; record 1 is the target.
                if pending_before {
                    // Write record 1 now, then lower the watermark over it.
                    bench.write(0, b"a").unwrap();
                    assert!(bench.state.wm_pending(), "{case}");
                    assert_eq!(bench.state.record().unwrap().record, 1, "{case}");
                }
                bench.rec.fail_record_write.set(Some(fail));
                let result = if pending_before {
                    bench.set_size(UNIT + 1)
                } else {
                    bench.write(0, b"b")
                };
                assert!(result.is_err(), "{case}");
                assert!(bench.rec.fail_record_write.get().is_none(), "{case}");
                assert_eq!(last_write(&bench), (RECORD_AT[1], RECORD_LEN), "{case}");
                // Re-selected from disk: record 1 wins when the failed write
                // landed, or left the pending record it overwrote intact.
                let landed = fail == Fail::All || (pending_before && fail == Fail::Nothing);
                let winner = bench.state.record().unwrap();
                assert_eq!(winner.record, u8::from(landed), "{case}");
                assert_eq!(bench.state.wm_pending(), landed, "{case}");
                assert_eq!(
                    logical(&bench.keys, &bench.volatile()).unwrap().1.record,
                    Some(winner),
                    "{case}"
                );
                // Continue: a record write still due goes to record 1 again,
                // overwriting a pending one or retrying the other one, and
                // the watermark catches up (the guard checks every write).
                let writes = bench.rec.writes.borrow().len();
                let units = if pending_before {
                    bench.set_size(UNIT + 1).unwrap();
                    2
                } else {
                    bench.write(1, b"c").unwrap();
                    3
                };
                for &(at, len) in &bench.rec.writes.borrow()[writes..] {
                    assert!(
                        at >= PAIRS_START || (at, len) == (RECORD_AT[1], RECORD_LEN),
                        "{case}"
                    );
                }
                for _ in 0..3 {
                    bench.sync().unwrap();
                }
                assert_eq!(durable_watermark(&bench), units, "{case}");
            }
        }
    }

    #[test]
    fn a_failed_reread_after_a_failed_write_syncs_before_the_next_write() {
        // 6.6 (e), last case: the write landed in B, which now wins
        // unsynced, and its re-read failed. The unit's bit cannot be known,
        // so the next write runs W0 first; without it, B would be taken for
        // clean and the write would overwrite durable A.
        let mut bench = Bench::born();
        bench.write(0, &pattern(U, 1)).unwrap();
        bench.sync().unwrap();
        bench.rec.fail_write.set(Some(Fail::All));
        bench.rec.unread_after_failure.set(1);
        assert!(bench.write(0, &pattern(U, 2)).is_err());
        assert_eq!(bench.rec.reads_fail.get(), 0);
        assert_eq!(bench.state.unit(0), None);
        assert!(!bench.state.synced_once());
        let syncs = bench.rec.syncs.get();
        bench.write(0, &pattern(U, 3)).unwrap();
        assert_eq!(bench.rec.syncs.get(), syncs + 1);
        // W0 made B durable, so the write takes A.
        assert_eq!(last_slot_write(&bench), slot_write(0, Slot::A, U));
        assert_eq!(bench.read_all().unwrap(), pattern(U, 3));
        // The same for a record write whose re-read fails: W0 runs, then the
        // record and size are reloaded from disk.
        bench.write(UNIT, b"y").unwrap();
        bench.sync().unwrap();
        assert_eq!(bench.state.candidate(), Some(2));
        bench.rec.fail_record_write.set(Some(Fail::All));
        bench.rec.unread_after_failure.set(1);
        assert!(bench.write(0, b"x").is_err());
        assert_eq!(bench.rec.reads_fail.get(), 0);
        assert!(!bench.state.synced_once());
        let syncs = bench.rec.syncs.get();
        bench.write(UNIT + 1, b"z").unwrap();
        assert_eq!(bench.rec.syncs.get(), syncs + 1);
        // The landed record, read back: D = 2, written before W0's sync.
        let durable = logical(&bench.keys, &bench.rec.durable.borrow()).unwrap().1;
        assert_eq!(bench.state.record(), durable.record);
        assert_eq!(durable.durable_units, 2);
        bench.sync().unwrap();
        assert_eq!(
            logical(&bench.keys, &bench.rec.durable.borrow()).unwrap().0,
            [&b"x"[..], &pattern(U, 3)[1..], b"yz"].concat()
        );
    }

    #[test]
    fn a_birth_whose_sync_fails_is_fail_stopped() {
        // A3 and 6.5 for the birth's own sync: the state comes back failed,
        // so no pair follows a header and record 0 that may not be durable.
        let keys = keys();
        let rec = crate::crash_tests::Rec::new(Vec::new(), Some(keys.clone()));
        rec.fail_sync.set(true);
        let nonce = [7u8; NONCE_LEN];
        let (error, state) = give_birth(&rec, &keys, FILE_ID, b"header", &nonce).unwrap_err();
        assert_eq!(error, ());
        let state = state.expect("the birth block was written");
        assert!(state.has_failed());
        let mut bench = Bench {
            keys,
            rec,
            state: *state,
            nonces: Counter::default(),
            writable: true,
        };
        assert_eq!(bench.write(0, b"data"), Err(SlotError::FailStopped));
        assert_eq!(bench.sync(), Err(SlotError::FailStopped));
        assert_eq!(bench.read_all().unwrap(), b"");
        // A failed write leaves no state; a birth that succeeds is synced.
        let rec = crate::crash_tests::Rec::new(Vec::new(), None);
        rec.fail_write.set(Some(Fail::Half));
        assert!(matches!(
            give_birth(&rec, &bench.keys, FILE_ID, b"header", &nonce),
            Err(((), None))
        ));
        let rec = crate::crash_tests::Rec::new(Vec::new(), None);
        let state = give_birth(&rec, &bench.keys, FILE_ID, b"header", &nonce).unwrap();
        assert!(!state.has_failed() && state.synced_once());
        assert_eq!(rec.syncs.get(), 1);
        assert_eq!(*rec.durable.borrow(), *rec.volatile.borrow());
    }

    #[test]
    fn a_fail_stop_from_outside_the_state_stops_writes() {
        // W3 of the review: a sync that failed through a descriptor with no
        // state fail-stops the state loaded afterwards; reads keep working.
        let mut bench = Bench::born();
        bench.write(0, b"data").unwrap();
        bench.sync().unwrap();
        bench.drop_state().unwrap();
        bench.state.fail_stop();
        assert_eq!(bench.write(0, b"more"), Err(SlotError::FailStopped));
        assert_eq!(bench.set_size(1), Err(SlotError::FailStopped));
        assert_eq!(bench.sync(), Err(SlotError::FailStopped));
        assert_eq!(bench.read_all().unwrap(), b"data");
    }

    #[test]
    fn random_operations_match_a_plaintext_model() {
        // 12.1 "Plaintext model", for codec 4, with every write checked
        // against the durable-slot invariant and the page cache read back by
        // an independent reader.
        let mut bench = Bench::born();
        let mut model: Vec<u8> = Vec::new();
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        for step in 0..500 {
            match rng.below(12) {
                0..=5 => {
                    let offset = rng.below(model.len() as u64 + 3 * UNIT);
                    let len = 1 + rng.below(3 * UNIT);
                    let data: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
                    bench.write(offset, &data).unwrap();
                    let end = (offset + len) as usize;
                    if model.len() < end {
                        model.resize(end, 0);
                    }
                    model[offset as usize..end].copy_from_slice(&data);
                }
                6 | 7 => {
                    let size = rng.below(model.len() as u64 + 2 * UNIT);
                    bench.set_size(size).unwrap();
                    model.resize(size as usize, 0);
                }
                8 => bench.sync().unwrap(),
                9 => bench.drop_state().unwrap(),
                _ => {
                    let offset = rng.below(model.len() as u64 + 10);
                    let len = rng.below(2 * UNIT + 10);
                    let (data, eof) = bench.file().read(len, offset).unwrap();
                    let start = (offset as usize).min(model.len());
                    let end = (offset + len).min(model.len() as u64) as usize;
                    assert_eq!(data, model[start..end.max(start)], "step {step}");
                    assert_eq!(eof, offset + len >= model.len() as u64, "step {step}");
                }
            }
            assert_eq!(bench.state.size(), model.len() as u64, "step {step}");
            if step % 25 == 0 {
                assert_eq!(
                    logical(&bench.keys, &bench.volatile()).unwrap().0,
                    model,
                    "step {step}"
                );
            }
        }
        assert_eq!(bench.read_all().unwrap(), model);
    }
}
