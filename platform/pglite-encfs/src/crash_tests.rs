//! Fault-injection harness for the codec-4 writer (design note 12.2).
//!
//! [`Rec`] is a recording storage: it keeps the durable image (as of the
//! last sync), the volatile one (the page cache) and every write and
//! `set_len` since the last sync, each with the volatile image right after
//! it. A crash is simulated by building candidate disks from the durable
//! image and a selection of those operations:
//!
//! 1. every in-order prefix;
//! 2. every tear of the operation in flight, at 512-byte and 4 KiB atomic
//!    units and for writes widened to whole 4 KiB pages torn at 512 bytes:
//!    unit cuts both ways, single units, and every subset for small writes
//!    (a sample for large ones), with the file length advanced or not.
//!    Bytes of a touched unit that the write does not cover come from the
//!    page cache, so a pending neighbour can come back as its on-disk or its
//!    page-cache bytes (A1, A2);
//! 3. reordering: every subset of up to 8 unsynced operations, applied in
//!    program order, and a sample beyond that (A5);
//! 4. restart: the workload continues on a crash disk with an empty cache
//!    (W0, W1) and crashes again (C13).
//!
//! On every candidate it checks the invariants of 12.2: no integrity error
//! on a crash-only disk (G8), durability and per-unit atomicity against the
//! logical states since the last sync, the size, watermark soundness,
//! erasure detection below `D`, and that a nonce never seals two different
//! slots. Every write is also checked against the durable-slot invariant
//! (6.2) as it is issued.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use crate::file::tests::{Memory, XorShift};
use crate::file::Storage;
use crate::header::{FileId, DEK_LEN, NONCE_LEN};
use crate::slots::{
    pairs_present, select, select_watermark, slot_offset, Integrity, Slot, SlotError, SlotFile,
    SlotKeys, PAIRS_START, PAIR_LEN, RECORD_AT, RECORD_LEN, UNIT,
};
use crate::writer::{birth_block, Durable, FileState, IntegrityFile, Nonces};

pub(crate) const FILE_ID: FileId = [0x42; 16];

pub(crate) fn keys() -> Rc<SlotKeys> {
    Rc::new(SlotKeys::derive(&core::array::from_fn::<u8, DEK_LEN, _>(
        |i| (i as u8).wrapping_mul(7) ^ 0x3C,
    )))
}

/// One operation since the last sync.
#[derive(Clone, Debug)]
pub(crate) enum Op {
    Write(u64, Vec<u8>),
    SetLen(u64),
}

/// The durable image at a sync and the operations that followed it, each
/// with the volatile image right after it.
#[derive(Clone, Debug)]
pub(crate) struct Epoch {
    pub durable: Vec<u8>,
    pub ops: Vec<(Op, Vec<u8>)>,
}

/// How an injected write failure behaves (6.6 (e)).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fail {
    /// Nothing reached the page cache.
    Nothing,
    /// Every byte landed, and the host still reported an error.
    All,
    /// The first half landed.
    Half,
}

/// The recording storage.
pub(crate) struct Rec {
    pub volatile: RefCell<Vec<u8>>,
    pub durable: RefCell<Vec<u8>>,
    pub ops: RefCell<Vec<(Op, Vec<u8>)>>,
    /// Epochs that ended with a sync since they were last taken.
    pub finished: RefCell<Vec<Epoch>>,
    /// Fail the next write, whatever it writes.
    pub fail_write: Cell<Option<Fail>>,
    /// Fail the next write into the header or record pages: a watermark
    /// record write (W2 of the review: `fail_write` always hits the slot
    /// write a record write follows).
    pub fail_record_write: Cell<Option<Fail>>,
    /// Reads that fail right after the next injected write failure, so the
    /// re-read of 6.6 (e) fails too.
    pub unread_after_failure: Cell<u32>,
    /// Reads still to fail.
    pub reads_fail: Cell<u32>,
    pub fail_sync: Cell<bool>,
    pub syncs: Cell<u32>,
    /// Every write, `(offset, length)`, for layout tests.
    pub writes: RefCell<Vec<(u64, usize)>>,
    /// Keys to check every write against the durable-slot invariant.
    pub guard: Option<Rc<SlotKeys>>,
}

impl Rec {
    pub fn new(disk: Vec<u8>, guard: Option<Rc<SlotKeys>>) -> Rec {
        Rec {
            volatile: RefCell::new(disk.clone()),
            durable: RefCell::new(disk),
            ops: RefCell::default(),
            finished: RefCell::default(),
            fail_write: Cell::new(None),
            fail_record_write: Cell::new(None),
            unread_after_failure: Cell::new(0),
            reads_fail: Cell::new(0),
            fail_sync: Cell::new(false),
            syncs: Cell::new(0),
            writes: RefCell::default(),
            guard,
        }
    }

    /// The epoch since the last sync.
    pub fn current(&self) -> Epoch {
        Epoch {
            durable: self.durable.borrow().clone(),
            ops: self.ops.borrow().clone(),
        }
    }
}

pub(crate) fn apply(disk: &mut Vec<u8>, op: &Op) {
    match op {
        Op::Write(at, data) => {
            let end = *at as usize + data.len();
            if disk.len() < end {
                disk.resize(end, 0);
            }
            disk[*at as usize..end].copy_from_slice(data);
        }
        Op::SetLen(len) => disk.resize(*len as usize, 0),
    }
}

/// 6.2: a write never touches the slot or record that holds the last
/// durable version.
pub(crate) fn check_durable_slots(keys: &SlotKeys, durable: &[u8], at: u64, len: usize) {
    let end = at + len as u64;
    let overlaps = |start: u64, stop: u64| at < stop && start < end;
    let pages = durable.get(RECORD_AT[0] as usize..).unwrap_or_default();
    if let Ok(Some(record)) = select_watermark(keys, &FILE_ID, pages) {
        let start = RECORD_AT[record.record as usize];
        assert!(
            !overlaps(start, start + RECORD_LEN as u64),
            "write {at}+{len} hits the durable record {record:?}"
        );
    }
    if end <= PAIRS_START {
        return;
    }
    let first = at.saturating_sub(PAIRS_START) / PAIR_LEN;
    let last = (end - 1 - PAIRS_START) / PAIR_LEN;
    for unit in first..=last {
        let start = slot_offset(unit, Slot::A) as usize;
        let pair = durable.get(start..).unwrap_or_default();
        let pair = &pair[..pair.len().min(PAIR_LEN as usize)];
        if let Ok(Some(winner)) = select(keys, &FILE_ID, unit, pair) {
            let slot = slot_offset(unit, winner.slot);
            assert!(
                !overlaps(slot, slot + 64 + winner.plain.len() as u64),
                "write {at}+{len} hits the durable slot {:?} of unit {unit}",
                winner.slot
            );
        }
    }
}

impl Storage for Rec {
    type Error = ();

    fn size(&self) -> Result<u64, ()> {
        Ok(self.volatile.borrow().len() as u64)
    }

    fn read_at(&self, offset: u64, len: u64) -> Result<Vec<u8>, ()> {
        if self.reads_fail.get() > 0 {
            self.reads_fail.set(self.reads_fail.get() - 1);
            return Err(());
        }
        let bytes = self.volatile.borrow();
        let start = (offset as usize).min(bytes.len());
        let end = (offset + len).min(bytes.len() as u64) as usize;
        Ok(bytes[start..end].to_vec())
    }

    fn write_at(&self, offset: u64, data: &[u8]) -> Result<(), ()> {
        if let Some(keys) = &self.guard {
            check_durable_slots(keys, &self.durable.borrow(), offset, data.len());
        }
        self.writes.borrow_mut().push((offset, data.len()));
        let fail = match self.fail_write.take() {
            None if offset < PAIRS_START => self.fail_record_write.take(),
            fail => fail,
        };
        if fail.is_some() {
            self.reads_fail.set(self.unread_after_failure.take());
        }
        let landed = match fail {
            None | Some(Fail::All) => data,
            Some(Fail::Half) => &data[..data.len() / 2],
            Some(Fail::Nothing) => &[][..],
        };
        if !landed.is_empty() {
            let op = Op::Write(offset, landed.to_vec());
            apply(&mut self.volatile.borrow_mut(), &op);
            let after = self.volatile.borrow().clone();
            self.ops.borrow_mut().push((op, after));
        }
        match fail {
            None => Ok(()),
            Some(_) => Err(()),
        }
    }

    fn set_len(&self, len: u64) -> Result<(), ()> {
        let op = Op::SetLen(len);
        apply(&mut self.volatile.borrow_mut(), &op);
        let after = self.volatile.borrow().clone();
        self.ops.borrow_mut().push((op, after));
        Ok(())
    }
}

impl Durable for Rec {
    fn sync_data(&self) -> Result<(), ()> {
        if self.fail_sync.take() {
            return Err(());
        }
        self.syncs.set(self.syncs.get() + 1);
        let epoch = Epoch {
            durable: self.durable.borrow().clone(),
            ops: std::mem::take(&mut *self.ops.borrow_mut()),
        };
        self.finished.borrow_mut().push(epoch);
        *self.durable.borrow_mut() = self.volatile.borrow().clone();
        Ok(())
    }
}

/// A deterministic nonce source shared across restarts, so the harness can
/// check that the protocol never seals twice with one nonce (12.2).
#[derive(Clone, Default)]
pub(crate) struct Counter(pub Rc<Cell<u64>>);

impl Nonces for Counter {
    fn draw(&mut self) -> [u8; NONCE_LEN] {
        let n = self.0.get() + 1;
        self.0.set(n);
        let mut nonce = [0u8; NONCE_LEN];
        nonce[..8].copy_from_slice(&n.to_le_bytes());
        nonce[16..].copy_from_slice(b"counter!");
        nonce
    }
}

/// One codec-4 file on a recording storage, with its state.
pub(crate) struct Bench {
    pub keys: Rc<SlotKeys>,
    pub rec: Rec,
    pub state: FileState,
    pub nonces: Counter,
    pub writable: bool,
}

impl Bench {
    /// A file just born: the birth block written and synced.
    pub fn born() -> Bench {
        let keys = keys();
        let mut nonces = Counter::default();
        let (block, record) = birth_block(&keys, &FILE_ID, b"header page", &nonces.draw());
        Bench {
            rec: Rec::new(block, Some(keys.clone())),
            state: FileState::born(FILE_ID, record),
            keys,
            nonces,
            writable: true,
        }
    }

    /// A restart on `disk`: an empty cache, the state read from disk.
    pub fn restart(keys: Rc<SlotKeys>, disk: Vec<u8>, nonces: Counter) -> Bench {
        Bench::resume(keys, Rec::new(disk, None), nonces)
    }

    /// A process crash without power loss: the page cache survives, the
    /// disk is still the durable image, and the unsynced operations are
    /// still in flight. Only W0 makes them durable (6.3).
    pub fn process_crash(&self) -> Bench {
        let rec = Rec::new(self.rec.durable.borrow().clone(), None);
        *rec.volatile.borrow_mut() = self.volatile();
        *rec.ops.borrow_mut() = self.rec.ops.borrow().clone();
        Bench::resume(self.keys.clone(), rec, self.nonces.clone())
    }

    fn resume(keys: Rc<SlotKeys>, mut rec: Rec, nonces: Counter) -> Bench {
        rec.guard = Some(keys.clone());
        let layout = SlotFile {
            keys: &keys,
            file_id: FILE_ID,
            storage: &rec,
        }
        .layout()
        .expect("a crash-only disk opens");
        Bench {
            state: FileState::loaded(FILE_ID, layout),
            rec,
            keys,
            nonces,
            writable: true,
        }
    }

    pub fn file(&mut self) -> IntegrityFile<'_, Rec, Counter> {
        IntegrityFile {
            file: SlotFile {
                keys: &self.keys,
                file_id: FILE_ID,
                storage: &self.rec,
            },
            state: &mut self.state,
            nonces: &mut self.nonces,
            writable: self.writable,
        }
    }

    pub fn volatile(&self) -> Vec<u8> {
        self.rec.volatile.borrow().clone()
    }

    pub fn write(&mut self, offset: u64, data: &[u8]) -> Result<(), SlotError<()>> {
        self.file().write(offset, data)
    }

    pub fn set_size(&mut self, size: u64) -> Result<(), SlotError<()>> {
        self.file().set_size(size)
    }

    pub fn sync(&mut self) -> Result<(), SlotError<()>> {
        self.file().sync(false)
    }

    /// Everything, through the writer's own state.
    pub fn read_all(&mut self) -> Result<Vec<u8>, SlotError<()>> {
        let size = self.state.size();
        self.file().read(size + 1, 0).map(|(data, _)| data)
    }

    /// Drop the state as 6.6 (c) allows: a dirty file is synced first.
    pub fn drop_state(&mut self) -> Result<(), SlotError<()>> {
        if self.state.is_dirty() {
            self.sync()?;
        }
        let layout = SlotFile {
            keys: &self.keys,
            file_id: FILE_ID,
            storage: &self.rec,
        }
        .layout()?;
        self.state = FileState::loaded(FILE_ID, layout);
        Ok(())
    }
}

/// The logical content and layout of a disk, read by an independent reader
/// with an empty cache.
pub(crate) fn logical(
    keys: &SlotKeys,
    disk: &[u8],
) -> Result<(Vec<u8>, crate::slots::Layout), SlotError<()>> {
    let memory = Memory(RefCell::new(disk.to_vec()));
    let file = SlotFile {
        keys,
        file_id: FILE_ID,
        storage: &memory,
    };
    let layout = file.layout()?;
    let (data, _) = file.read(layout, layout.size + 1, 0)?;
    Ok((data, layout))
}

fn prefix(epoch: &Epoch, n: usize) -> Vec<u8> {
    let mut disk = epoch.durable.clone();
    for (op, _) in &epoch.ops[..n] {
        apply(&mut disk, op);
    }
    disk
}

/// The candidate disks of a crash during `epoch`, for the operations from
/// `from` on (the earlier ones were enumerated before).
pub(crate) fn crash_disks(epoch: &Epoch, from: usize, rng: &mut XorShift) -> Vec<Vec<u8>> {
    let mut disks = Vec::new();
    // 1. Every write boundary.
    for n in from..=epoch.ops.len() {
        disks.push(prefix(epoch, n));
    }
    // 2. Every tear of the operation in flight, over the earlier operations
    //    persisted in order, over none of them, and over subsets of them:
    //    nothing orders unsynced writes (A5).
    for i in from..epoch.ops.len() {
        let (Op::Write(at, data), page) = &epoch.ops[i] else {
            continue;
        };
        let mut bases = vec![prefix(epoch, i), epoch.durable.clone()];
        let masks: Vec<u64> = if i <= 4 {
            (1..(1u64 << i).saturating_sub(1)).collect()
        } else {
            (0..6).map(|_| rng.next()).collect()
        };
        for mask in masks {
            let mut disk = epoch.durable.clone();
            for (k, (op, _)) in epoch.ops[..i].iter().enumerate() {
                if k < 64 && mask >> k & 1 == 1 {
                    apply(&mut disk, op);
                }
            }
            bases.push(disk);
        }
        bases.dedup();
        for base in &bases {
            tears(&mut disks, base, *at, data.len(), page, rng);
        }
    }
    // 3. Reordering: subsets in program order, each with a new operation.
    let n = epoch.ops.len();
    let masks: Vec<u64> = if n <= 8 {
        (0..1u64 << n).collect()
    } else {
        (0..32).map(|_| rng.next()).collect()
    };
    for mask in masks {
        if from > 0 && mask >> from.min(63) == 0 {
            continue;
        }
        let mut disk = epoch.durable.clone();
        for (k, (op, _)) in epoch.ops.iter().enumerate() {
            if k < 64 && mask >> k & 1 == 1 {
                apply(&mut disk, op);
            }
        }
        disks.push(disk);
    }
    disks.sort();
    disks.dedup();
    disks
}

/// The tears of one write of `len` bytes at `at` over `base`; `page` is the
/// page cache right after the write.
fn tears(
    disks: &mut Vec<Vec<u8>>,
    base: &[u8],
    at: u64,
    len: usize,
    page: &[u8],
    rng: &mut XorShift,
) {
    let end = at + len as u64;
    for (atomic, widened) in [(512u64, false), (4096, false), (512, true)] {
        let grain = if widened { 4096 } else { atomic };
        let lo = at / grain * grain;
        let hi = (end.div_ceil(grain) * grain).min(page.len() as u64);
        let units: Vec<(u64, u64)> = (lo..hi)
            .step_by(atomic as usize)
            .map(|start| (start, (start + atomic).min(hi)))
            .collect();
        let n = units.len();
        let mut choices: Vec<Vec<bool>> = Vec::new();
        for j in 1..n {
            choices.push((0..n).map(|k| k < j).collect());
            choices.push((0..n).map(|k| k >= j).collect());
        }
        for j in 0..n {
            choices.push((0..n).map(|k| k == j).collect());
            choices.push((0..n).map(|k| k != j).collect());
        }
        if n <= 6 {
            for mask in 0..1u32 << n {
                choices.push((0..n).map(|k| mask >> k & 1 == 1).collect());
            }
        } else {
            for _ in 0..12 {
                choices.push((0..n).map(|_| rng.below(2) == 1).collect());
            }
        }
        for choice in choices {
            let new_end = units
                .iter()
                .zip(&choice)
                .filter(|(_, &new)| new)
                .map(|(&(_, stop), _)| stop)
                .max()
                .unwrap_or(0);
            // The length advanced with the write, or only as far as
            // the units that landed.
            for len in [end.min(page.len() as u64), new_end] {
                let len = len.max(base.len() as u64) as usize;
                let mut disk = base.to_vec();
                disk.resize(len, 0);
                for (&(start, stop), &new) in units.iter().zip(&choice) {
                    let stop = (stop as usize).min(len);
                    if new && (start as usize) < stop {
                        disk[start as usize..stop].copy_from_slice(&page[start as usize..stop]);
                    }
                }
                disks.push(disk);
            }
        }
    }
}

/// The invariants of 12.2 over every candidate disk.
pub(crate) struct Checker {
    pub keys: Rc<SlotKeys>,
    /// Nonce → what it sealed, over every valid slot seen in a run.
    pub sealed: HashMap<[u8; NONCE_LEN], Vec<u8>>,
    /// The most units durable at any completed sync.
    pub max_durable_units: u64,
    pub disks: usize,
    /// Failure steps whose failure was injected, outside restarted runs.
    pub injected: usize,
    pub rng: XorShift,
}

impl Checker {
    pub fn new(keys: Rc<SlotKeys>, seed: u64) -> Checker {
        Checker {
            keys,
            sealed: HashMap::new(),
            max_durable_units: 0,
            disks: 0,
            injected: 0,
            rng: XorShift(seed),
        }
    }

    /// `synced`: the logical content at the epoch's sync. `states`: every
    /// logical state since then, `synced` included.
    pub fn check(&mut self, disk: &[u8], synced: &[u8], states: &[Vec<u8>], ctx: &str) {
        self.disks += 1;
        let keys = self.keys.clone();
        // G8: no integrity error on a crash-only disk, without exceptions.
        let (data, layout) = logical(&keys, disk)
            .unwrap_or_else(|e| panic!("{ctx}: integrity error on a crash-only disk: {e:?}"));
        // Size: within the sizes the file had since the last sync.
        let min = states.iter().map(Vec::len).min().unwrap();
        let max = states.iter().map(Vec::len).max().unwrap();
        assert!(
            (min..=max).contains(&data.len()),
            "{ctx}: size {} outside {min}..={max}",
            data.len()
        );
        // Durability and atomicity: each unit is one version written to
        // it since the last sync, padded with zeros when interior (C7), or
        // zeros if it was first written after the sync (C14).
        let unit = UNIT as usize;
        for u in 0..data.len().div_ceil(unit) {
            let chunk = &data[u * unit..data.len().min((u + 1) * unit)];
            let is_version = |state: &Vec<u8>| {
                let start = u * unit;
                start < state.len() && {
                    let version = &state[start..state.len().min(start + unit)];
                    version.len() <= chunk.len()
                        && chunk[..version.len()] == *version
                        && chunk[version.len()..].iter().all(|&b| b == 0)
                }
            };
            let fresh_zeros = u * unit >= synced.len() && chunk.iter().all(|&b| b == 0);
            assert!(
                fresh_zeros || states.iter().any(is_version),
                "{ctx}: unit {u} holds no version written to it"
            );
        }
        // Watermark soundness.
        assert!(
            layout.durable_units <= self.max_durable_units,
            "{ctx}: D = {} claims more than was ever durable ({})",
            layout.durable_units,
            self.max_durable_units
        );
        // A nonce never seals two different slots.
        for unit in 0..pairs_present(disk.len() as u64) {
            for slot in [Slot::A, Slot::B] {
                let at = slot_offset(unit, slot) as usize;
                let bytes = disk.get(at..).unwrap_or_default();
                if let Some(opened) = crate::slots::open_slot(&keys, &FILE_ID, unit, slot, bytes) {
                    let nonce: [u8; NONCE_LEN] = bytes[16..40].try_into().unwrap();
                    let what = [
                        &unit.to_le_bytes()[..],
                        &[slot as u8],
                        &opened.generation.to_le_bytes(),
                        &opened.plain,
                    ]
                    .concat();
                    let seen = self.sealed.entry(nonce).or_insert_with(|| what.clone());
                    assert!(*seen == what, "{ctx}: nonce {nonce:?} sealed twice");
                }
            }
        }
        // Erasure detection: both slots of a unit below D zeroed.
        let erasable = pairs_present(disk.len() as u64).min(layout.durable_units);
        if erasable > 0 {
            let victim = self.rng.below(erasable);
            let mut erased = disk.to_vec();
            let start = slot_offset(victim, Slot::A) as usize;
            let stop = (start + PAIR_LEN as usize).min(erased.len());
            erased[start..stop].fill(0);
            match logical(&keys, &erased) {
                Err(SlotError::Integrity(Integrity::Erased { unit })) if unit == victim => {}
                other => panic!("{ctx}: erasing unit {victim} below D gave {other:?}"),
            }
        }
    }

    /// Check every crash during `epoch` from operation `from` on; returns
    /// the candidate disks.
    pub fn check_epoch(&mut self, epoch: &Epoch, from: usize, ctx: &str) -> Vec<Vec<u8>> {
        let keys = self.keys.clone();
        let read = |disk: &[u8], what: &str| {
            logical(&keys, disk)
                .unwrap_or_else(|e| panic!("{ctx}: {what} does not read: {e:?}"))
                .0
        };
        let synced = read(&epoch.durable, "the durable image");
        self.max_durable_units = self
            .max_durable_units
            .max(synced.len().div_ceil(UNIT as usize) as u64);
        let mut states = vec![synced.clone()];
        for (_, page) in &epoch.ops {
            states.push(read(page, "the page cache"));
        }
        let mut rng = XorShift(self.rng.next() | 1);
        let disks = crash_disks(epoch, from, &mut rng);
        for (i, disk) in disks.iter().enumerate() {
            self.check(disk, &synced, &states, &format!("{ctx}, disk {i}"));
        }
        disks
    }
}

/// One step of a workload.
#[derive(Clone, Debug)]
pub(crate) enum Step {
    Write(u64, Vec<u8>),
    SetSize(u64),
    Sync,
    /// Drop the state (6.6 (c)): a dirty file is synced first.
    Drop,
    /// A write whose host write fails (6.6 (e)).
    FailingWrite(Fail, u64, Vec<u8>),
    /// A write whose host write fails and whose re-read fails too, so the
    /// writer cannot know the unit's bit (6.6 (e), last case).
    UnreadFailingWrite(Fail, u64, Vec<u8>),
    /// A step during which the next watermark record write fails (6.6 (e)
    /// for records); with `true`, the re-read after it fails too. The step
    /// must be a write, a resize or a sync. After a restart no record may be
    /// due; the step then runs as it is.
    FailingRecord(Fail, bool, Box<Step>),
}

fn pattern(len: usize, seed: u64) -> Vec<u8> {
    let mut rng = XorShift(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    (0..len).map(|_| rng.next() as u8 | 1).collect()
}

/// Run one step; `expected` becomes the content a successful step leaves.
/// Returns the result and whether an injected failure was reported, so the
/// content is not compared.
fn perform(
    bench: &mut Bench,
    step: &Step,
    expected: &mut Vec<u8>,
    ctx: &str,
) -> (Result<(), SlotError<()>>, bool) {
    match step {
        Step::Write(offset, data) => {
            let end = *offset as usize + data.len();
            if expected.len() < end {
                expected.resize(end, 0);
            }
            expected[*offset as usize..end].copy_from_slice(data);
            (bench.write(*offset, data), false)
        }
        Step::SetSize(size) => {
            expected.resize(*size as usize, 0);
            (bench.set_size(*size), false)
        }
        Step::Sync => (bench.sync(), false),
        Step::Drop => (bench.drop_state(), false),
        Step::FailingWrite(fail, offset, data) | Step::UnreadFailingWrite(fail, offset, data) => {
            bench.rec.fail_write.set(Some(*fail));
            if matches!(step, Step::UnreadFailingWrite(..)) {
                bench.rec.unread_after_failure.set(1);
            }
            let result = bench.write(*offset, data);
            assert!(
                result.is_err(),
                "{ctx}: the injected failure was not reported"
            );
            assert_eq!(
                bench.rec.reads_fail.get(),
                0,
                "{ctx}: the re-read was not made"
            );
            (Ok(()), true)
        }
        Step::FailingRecord(fail, unread, inner) => {
            bench.rec.fail_record_write.set(Some(*fail));
            if *unread {
                bench.rec.unread_after_failure.set(1);
            }
            let (result, _) = perform(bench, inner, expected, ctx);
            let injected = bench.rec.fail_record_write.take().is_none();
            if !injected {
                // No record was due: nothing failed.
                bench.rec.unread_after_failure.set(0);
                return (result, false);
            }
            assert!(
                result.is_err(),
                "{ctx}: the injected record failure was not reported"
            );
            assert_eq!(
                bench.rec.reads_fail.get(),
                0,
                "{ctx}: the re-read was not made"
            );
            (Ok(()), true)
        }
    }
}

/// Run `steps` on `bench`, checking every crash after each step, and, down
/// to `depth`, continuing the rest of the workload after a crash.
pub(crate) fn run(checker: &mut Checker, mut bench: Bench, steps: &[Step], depth: u32, name: &str) {
    let mut model = logical(&bench.keys, &bench.volatile()).unwrap().0;
    for (i, step) in steps.iter().enumerate() {
        let ctx = format!("{name} step {i} {}", describe(step));
        let before = bench.rec.ops.borrow().len();
        let mut expected = model.clone();
        let (result, failed) = perform(&mut bench, step, &mut expected, &ctx);
        if failed && !name.contains("restart") {
            checker.injected += 1;
        }
        result.unwrap_or_else(|e| panic!("{ctx}: {e:?}"));
        // Check every crash since the step began.
        let finished: Vec<Epoch> = bench.rec.finished.borrow_mut().drain(..).collect();
        let mut disks = Vec::new();
        for (k, epoch) in finished.iter().chain([&bench.rec.current()]).enumerate() {
            let from = if k == 0 { before } else { 0 };
            disks = checker.check_epoch(epoch, from, &ctx);
        }
        // The writer's view equals what an empty cache reads from the page
        // cache, and a successful step did what it says.
        let now = logical(&bench.keys, &bench.volatile())
            .unwrap_or_else(|e| panic!("{ctx}: the page cache does not read: {e:?}"))
            .0;
        assert_eq!(
            bench.read_all().unwrap(),
            now,
            "{ctx}: state and disk disagree"
        );
        if !failed {
            assert_eq!(now, expected, "{ctx}: wrong content");
        }
        model = now;
        // Restart on one crash disk and continue the workload (C13), or
        // restart after a process crash, with the page cache intact.
        if depth > 0 && i + 1 < steps.len() && !disks.is_empty() {
            let restarted = if checker.rng.below(3) == 0 {
                bench.process_crash()
            } else {
                let disk = disks[checker.rng.below(disks.len() as u64) as usize].clone();
                Bench::restart(bench.keys.clone(), disk, bench.nonces.clone())
            };
            run(
                checker,
                restarted,
                &steps[i + 1..],
                depth - 1,
                &format!("{ctx} / restart"),
            );
        }
    }
}

fn describe(step: &Step) -> String {
    match step {
        Step::Write(offset, data) => format!("write {offset}+{}", data.len()),
        Step::SetSize(size) => format!("set_size {size}"),
        Step::Sync => "sync".into(),
        Step::Drop => "drop state".into(),
        Step::FailingWrite(fail, offset, data) => {
            format!("failing write ({fail:?}) {offset}+{}", data.len())
        }
        Step::UnreadFailingWrite(fail, offset, data) => {
            format!(
                "failing write ({fail:?}, re-read fails) {offset}+{}",
                data.len()
            )
        }
        Step::FailingRecord(fail, unread, inner) => format!(
            "{} with a failing record write ({fail:?}{})",
            describe(inner),
            if *unread { ", re-read fails" } else { "" }
        ),
    }
}

#[cfg(test)]
mod workloads {
    use super::*;

    const U: u64 = UNIT;

    fn w(offset: u64, len: usize, seed: u64) -> Step {
        Step::Write(offset, pattern(len, seed))
    }

    /// Run `steps` from a birth; returns the checker (disks, injections).
    fn check(steps: &[Step], depth: u32, name: &str) -> Checker {
        let mut checker = Checker::new(keys(), 0xC0FF_EE11_D00D_F00D);
        run(&mut checker, Bench::born(), steps, depth, name);
        checker
    }

    #[test]
    fn wal_tail_page_rewrites() {
        // The WAL tail: one page grows and is rewritten in place, fsynced
        // on some writes; C2, C6, C10 and, after a restart, C13.
        let steps = [
            w(0, 100, 1),
            Step::Sync,
            w(100, 300, 2),
            w(0, U as usize, 3),
            Step::Sync,
            w(0, U as usize, 4),
            w(0, U as usize, 5),
            Step::Sync,
            w(U, 50, 6),
            w(U, U as usize, 7),
            Step::Sync,
        ];
        assert!(check(&steps, 1, "wal tail").disks > 1000);
    }

    #[test]
    fn pg_control_rewrites() {
        let steps = [
            w(0, U as usize, 1),
            Step::Sync,
            w(0, U as usize, 2),
            Step::Sync,
            w(0, U as usize, 3),
            Step::Drop,
            w(0, U as usize, 4),
            Step::Sync,
        ];
        check(&steps, 1, "pg_control");
    }

    #[test]
    fn small_appends_and_shrinks_across_unit_edges() {
        // The #206 cases: unaligned appends and shrinks garble nothing (G4),
        // truncate to 0 and re-extension (C9, C16).
        let steps = [
            w(0, 5, 1),
            w(5, 8190, 2),
            Step::Sync,
            Step::SetSize(8000),
            Step::Sync,
            Step::SetSize(2 * U + 33),
            w(2 * U + 33, 7, 3),
            Step::Sync,
            Step::SetSize(U + 1),
            w(U + 1, 4000, 4),
            Step::SetSize(0),
            w(0, 20_000, 5),
            Step::Sync,
            Step::SetSize(8193),
            Step::SetSize(4001),
            Step::Sync,
        ];
        check(&steps, 1, "appends and shrinks");
    }

    #[test]
    fn multi_unit_extensions() {
        // C7 and C14: an extension persisted out of order or torn, and a
        // gap zero-filled past the end.
        let steps = [
            w(0, 100, 1),
            Step::Sync,
            w(100, 5 * U as usize, 2),
            Step::Sync,
            w(7 * U + 10, 100, 3),
            Step::Sync,
            w(2 * U, 2 * U as usize, 4),
            Step::Sync,
        ];
        check(&steps, 1, "extensions");
    }

    #[test]
    fn failed_writes() {
        // 6.6 (e): nothing landed or everything landed, on a pending and
        // on a clean unit, and a new unit whose first write failed.
        let steps = [
            w(0, 2 * U as usize, 1),
            Step::Sync,
            Step::FailingWrite(Fail::Nothing, 0, pattern(U as usize, 2)),
            w(0, U as usize, 3),
            Step::FailingWrite(Fail::All, 0, pattern(U as usize, 4)),
            w(0, 100, 5),
            Step::Sync,
            Step::FailingWrite(Fail::All, U, pattern(U as usize, 6)),
            Step::Sync,
            Step::FailingWrite(Fail::Half, 3 * U, pattern(U as usize, 7)),
            w(5 * U, 10, 8),
            Step::Sync,
            Step::Sync,
            Step::Sync,
        ];
        check(&steps, 1, "failed writes");
    }

    fn failing_record(fail: Fail, unread: bool, step: Step) -> Step {
        Step::FailingRecord(fail, unread, Box::new(step))
    }

    #[test]
    fn failed_record_writes() {
        // 6.6 (e) for watermark records: a lazy record write that fails with
        // nothing, everything or half of it landed, over a clean record (the
        // write targets the other record) and over a pending one (the write
        // overwrites it); then the retry, and tears of everything after.
        // Each record write is checked against the durable record as it is
        // issued, so `wm_pending` wrong either way fails here.
        let mut steps = Vec::new();
        for (round, fail) in [Fail::Nothing, Fail::All, Fail::Half]
            .into_iter()
            .enumerate()
        {
            let base = round as u64 * 3 * U;
            let seed = 10 * round as u64;
            steps.extend([
                // A clean record: the sync leaves a candidate due, and the
                // next write's record write targets the other record.
                w(base, 2 * U as usize, seed + 1),
                Step::Sync,
                failing_record(fail, false, w(base + 10, 100, seed + 2)),
                // The retry writes the candidate, or finds it written.
                w(base + 20, 100, seed + 3),
                Step::Sync,
                // A pending record: a third unit, a sync, and a write that
                // carries its record; then a shrink to two units lowers the
                // watermark by overwriting that unsynced record.
                w(base + 2 * U, U as usize, seed + 4),
                Step::Sync,
                w(base + 30, 10, seed + 5),
                failing_record(fail, false, Step::SetSize(base + U + 5)),
                Step::SetSize(base + U + 5),
                w(base + U + 5, 2 * U as usize, seed + 6),
                Step::Sync,
            ]);
        }
        steps.push(Step::Sync);
        // Every failure step failed: none ran without a record write due.
        assert_eq!(check(&steps, 1, "failed record writes").injected, 6);
    }

    #[test]
    fn failed_rereads() {
        // 6.6 (e), last case: the re-read after a failed slot or record
        // write fails too, so no bit can be known; the writer syncs before
        // it trusts one again (W0), and reloads the record and size.
        let steps = [
            w(0, 2 * U as usize, 1),
            Step::Sync,
            // A clean unit whose write landed: B now wins unsynced.
            Step::UnreadFailingWrite(Fail::All, 0, pattern(U as usize, 2)),
            w(0, U as usize, 3),
            Step::UnreadFailingWrite(Fail::Half, U, pattern(U as usize, 4)),
            w(U, 100, 5),
            Step::Sync,
            Step::UnreadFailingWrite(Fail::Nothing, 2 * U, pattern(U as usize, 6)),
            w(2 * U, 10, 7),
            Step::Sync,
            // A record write that landed, its re-read failed.
            w(3 * U, 100, 8),
            Step::Sync,
            failing_record(Fail::All, true, w(0, 50, 9)),
            w(60, 50, 10),
            Step::Sync,
            // A sync's own record write that did not land, re-read failed.
            w(4 * U, 100, 11),
            Step::Sync,
            failing_record(Fail::Nothing, true, Step::Sync),
            Step::Sync,
            Step::Sync,
        ];
        assert_eq!(check(&steps, 1, "failed re-reads").injected, 5);
    }

    #[test]
    fn random_sequences() {
        for seed in 1..=4u64 {
            let mut rng = XorShift(seed.wrapping_mul(0xA24B_AED4_963E_E407));
            let mut size = 0u64;
            let mut steps = Vec::new();
            for _ in 0..14 {
                let step = match rng.below(10) {
                    0..=4 => {
                        let offset = rng.below(size + U);
                        let len = 1 + rng.below(2 * U) as usize;
                        size = size.max(offset + len as u64);
                        w(offset, len, rng.next())
                    }
                    5 => {
                        size = rng.below(size + U);
                        Step::SetSize(size)
                    }
                    6 | 7 => Step::Sync,
                    8 => Step::Drop,
                    _ => {
                        let fail = [Fail::Nothing, Fail::All, Fail::Half][rng.below(3) as usize];
                        let offset = rng.below(size + 1);
                        let data = pattern(1 + rng.below(U) as usize, rng.next());
                        match rng.below(4) {
                            0 | 1 => Step::FailingWrite(fail, offset, data),
                            2 => Step::UnreadFailingWrite(fail, offset, data),
                            _ => {
                                size = size.max(offset + data.len() as u64);
                                failing_record(fail, rng.below(2) == 1, Step::Write(offset, data))
                            }
                        }
                    }
                };
                steps.push(step);
            }
            steps.push(Step::Sync);
            check(&steps, 1, &format!("random {seed}"));
        }
    }

    #[test]
    fn tear_restart_rewrite_tear_again_keeps_the_durable_page() {
        // C13 walked through (7): v1 durable in A; a rewrite to B is torn
        // with its header claiming the newer generation; after a restart a
        // whole-unit rewrite must target B again, so a second tear still
        // leaves v1.
        let v1 = pattern(U as usize, 1);
        let mut bench = Bench::born();
        bench.write(0, &v1).unwrap();
        bench.sync().unwrap();
        bench.sync().unwrap(); // the watermark covers unit 0
        bench.write(0, &pattern(U as usize, 2)).unwrap();
        let durable = bench.rec.durable.borrow().clone();
        let page = bench.volatile();
        let b = slot_offset(0, Slot::B) as usize;
        // Torn: the new header sector over the old (never written) bytes.
        let mut torn = durable.clone();
        torn.resize(page.len(), 0);
        torn[b..b + 512].copy_from_slice(&page[b..b + 512]);
        assert_eq!(logical(&bench.keys, &torn).unwrap().0, v1);
        let a = slot_offset(0, Slot::A) as usize;
        let slot_a = torn[a..a + 64 + U as usize].to_vec();
        let mut restarted = Bench::restart(bench.keys.clone(), torn, bench.nonces.clone());
        restarted.write(0, &pattern(U as usize, 3)).unwrap();
        let writes = restarted.rec.writes.borrow().clone();
        assert_eq!(
            writes,
            vec![(b as u64, 64 + U as usize)],
            "the rewrite targets B"
        );
        let page = restarted.volatile();
        assert_eq!(page[a..a + 64 + U as usize], slot_a, "slot A is untouched");
        // A second tear: any prefix of B's new sectors.
        for cut in (0..64 + U as usize).step_by(512) {
            let mut again = restarted.rec.durable.borrow().clone();
            again[b..b + cut].copy_from_slice(&page[b..b + cut]);
            assert_eq!(logical(&restarted.keys, &again).unwrap().0, v1, "cut {cut}");
        }
    }
}
