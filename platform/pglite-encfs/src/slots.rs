//! Codec 4 (#200): two XChaCha20-Poly1305 slots per 8 KiB unit, read side.
//!
//! The design is `docs/design-200-two-slot-aead.md`; section numbers below
//! refer to it. This build reads codec-4 files and never writes them (the
//! reader release of section 9.3); the writer comes in a later release.
//!
//! Physical layout (5.1, 5.2):
//!
//! ```text
//! [header page: 4096][record page 0: 4096][record page 1: 4096][pair 0][pair 1]...
//! pair u = [slot A: 8256][slot B: 8256] at 12288 + u × 16512
//! slot   = generation (u64 LE) ‖ len (u32 LE) ‖ 0^4 ‖ nonce (24) ‖ tag (16) ‖ 0^8 ‖ ciphertext (len)
//! record = seq (u64 LE) ‖ durable units (u64 LE) ‖ nonce (24) ‖ tag (16) ‖ 0^8
//! ```
//!
//! - **Keys (5.1).** HKDF-SHA256 over the file's DEK with the KEK's salt:
//!   info `codec4-aead` seals slots, `codec4-watermark` seals records.
//! - **Slots (5.2, 5.5).** A slot is valid when it lies within the host file,
//!   its generation is not 0, its `len` is 1..=8192, its reserved bytes are
//!   zero and its tag verifies over `"DIPGENC4" ‖ file id ‖ unit ‖ slot ‖
//!   bytes 0..16 ‖ bytes 56..64`. A unit's winner is the valid slot with the
//!   higher generation; two valid slots with one generation are an integrity
//!   error. The slot that claims the higher generation is verified first.
//! - **Watermark (5.6).** Record 0 at byte 4096 and record 1 at byte 8192,
//!   sealed over an empty plaintext with `"DIPGWM04" ‖ file id ‖ index ‖
//!   bytes 0..16 ‖ bytes 56..64` as AAD. The valid record with the higher `seq`
//!   gives `D`, the number of units that were durable at a completed sync.
//! - **Size (5.3).** Walk back from the last pair present: a pair with a
//!   winner ends the walk; a pair at or above `D` without one is a trailing
//!   pair of an unsynced extension and is dropped; one below `D` was erased.
//! - **Reads (8.1, 8.3).** An interior unit reads as its winner padded with
//!   zeros to 8192, as zeros when it has no valid slot at or above `D`, and
//!   fails when it has none below `D`.

use std::ops::Range;

use chacha20poly1305::aead::AeadInPlace;
use chacha20poly1305::{KeyInit, Tag, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::file::Storage;
use crate::header::{FileId, DEK_LEN, HEADER_LEN};
use crate::keys::HKDF_SALT;

/// Logical bytes per unit: PostgreSQL's `BLCKSZ` (Q1).
pub const UNIT: u64 = 8192;
/// Bytes of a slot before its ciphertext.
pub const SLOT_HEADER: usize = 64;
/// A slot: its header and room for a whole unit (Q2: compact, not padded).
pub const SLOT_LEN: u64 = SLOT_HEADER as u64 + UNIT;
/// Slot A and slot B of one unit.
pub const PAIR_LEN: u64 = 2 * SLOT_LEN;
/// Bytes of a watermark record.
pub const RECORD_LEN: usize = 64;
/// Where records 0 and 1 start, each at the start of its own page.
pub const RECORD_AT: [u64; 2] = [HEADER_LEN, 2 * HEADER_LEN];
/// Where pair 0 starts: after the header page and the two record pages.
pub const PAIRS_START: u64 = 3 * HEADER_LEN;

const SLOT_DOMAIN: &[u8; 8] = b"DIPGENC4";
const RECORD_DOMAIN: &[u8; 8] = b"DIPGWM04";
const INFO_AEAD: &[u8] = b"codec4-aead";
const INFO_WATERMARK: &[u8] = b"codec4-watermark";

/// Fields shared by slot and record headers.
const COUNTER: Range<usize> = 0..8;
const NONCE: Range<usize> = 16..40;
const TAG: Range<usize> = 40..56;
/// Authenticated as AAD: bytes 0..16 and 56..64 of a slot or record.
const BOUND_HEAD: Range<usize> = 0..16;
const BOUND_TAIL: Range<usize> = 56..64;
/// Slot only: `len` and the reserved bytes after it.
const SLOT_LEN_FIELD: Range<usize> = 8..12;
const SLOT_RESERVED: Range<usize> = 12..16;
/// Record only: the durable-unit count.
const DURABLE_UNITS: Range<usize> = 8..16;

/// The two slots of a pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    A = 0,
    B = 1,
}

impl Slot {
    fn other(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
        }
    }

    fn offset_in_pair(self) -> usize {
        self as usize * SLOT_LEN as usize
    }
}

/// Physical offset of `slot` of `unit`.
pub fn slot_offset(unit: u64, slot: Slot) -> u64 {
    PAIRS_START + unit * PAIR_LEN + slot.offset_in_pair() as u64
}

/// Number of pairs not absent in a file of `physical` bytes: those whose
/// slot A starts before the end (5.2).
pub fn pairs_present(physical: u64) -> u64 {
    physical.saturating_sub(PAIRS_START).div_ceil(PAIR_LEN)
}

/// The two keys of one codec-4 file, derived from its DEK.
pub struct SlotKeys {
    slots: XChaCha20Poly1305,
    records: XChaCha20Poly1305,
}

fn derive_key(dek: &[u8; DEK_LEN], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let hkdf = Hkdf::<Sha256>::new(Some(HKDF_SALT), dek);
    let mut key = Zeroizing::new([0u8; 32]);
    hkdf.expand(info, key.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

impl SlotKeys {
    pub fn derive(dek: &[u8; DEK_LEN]) -> SlotKeys {
        SlotKeys {
            slots: XChaCha20Poly1305::new(derive_key(dek, INFO_AEAD).as_ref().into()),
            records: XChaCha20Poly1305::new(derive_key(dek, INFO_WATERMARK).as_ref().into()),
        }
    }
}

/// `domain ‖ file id ‖ position ‖ head[0..16] ‖ head[56..64]`.
fn aad(domain: &[u8; 8], file_id: &FileId, position: &[u8], head: &[u8]) -> Vec<u8> {
    [
        &domain[..],
        file_id,
        position,
        &head[BOUND_HEAD],
        &head[BOUND_TAIL],
    ]
    .concat()
}

fn slot_position(unit: u64, slot: Slot) -> [u8; 9] {
    let mut position = [0u8; 9];
    position[..8].copy_from_slice(&unit.to_le_bytes());
    position[8] = slot as u8;
    position
}

fn le_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("8-byte field"))
}

fn is_zero(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| b == 0)
}

/// Verify the AEAD tag of a slot or record over `aad`, decrypting `body` in
/// place.
fn verify(cipher: &XChaCha20Poly1305, head: &[u8], aad: &[u8], body: &mut [u8]) -> bool {
    cipher
        .decrypt_in_place_detached(
            XNonce::from_slice(&head[NONCE]),
            aad,
            body,
            Tag::from_slice(&head[TAG]),
        )
        .is_ok()
}

/// The generation a slot's bytes claim before anything is verified; 0 for a
/// slot too short to hold one.
fn claimed_generation(bytes: &[u8]) -> u64 {
    bytes.get(COUNTER).map_or(0, le_u64)
}

/// A slot that authenticated: its generation and plaintext.
struct Opened {
    generation: u64,
    plain: Vec<u8>,
}

/// Verify one slot (5.5). `bytes` is what the host file holds from the slot's
/// start, cut at the end of the file.
fn open_slot(
    keys: &SlotKeys,
    file_id: &FileId,
    unit: u64,
    slot: Slot,
    bytes: &[u8],
) -> Option<Opened> {
    let head = bytes.get(..SLOT_HEADER)?;
    let generation = le_u64(&head[COUNTER]);
    let len = u32::from_le_bytes(head[SLOT_LEN_FIELD].try_into().expect("4-byte field")) as usize;
    let well_formed = generation != 0
        && (1..=UNIT as usize).contains(&len)
        && is_zero(&head[SLOT_RESERVED])
        && is_zero(&head[BOUND_TAIL]);
    if !well_formed {
        return None;
    }
    // A slot that reaches past the end of the host file is absent.
    let mut plain = bytes.get(SLOT_HEADER..SLOT_HEADER + len)?.to_vec();
    let aad = aad(SLOT_DOMAIN, file_id, &slot_position(unit, slot), head);
    verify(&keys.slots, head, &aad, &mut plain).then_some(Opened { generation, plain })
}

/// Why a codec-4 file cannot be read. Never produced by a disk that saw only
/// crashes (G8); each one is logged with the path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Integrity {
    /// A unit below the watermark has no valid slot: it was erased (8.3).
    Erased { unit: u64 },
    /// Both slots of a unit are valid with the same generation (5.5).
    EqualGenerations { unit: u64 },
    /// No valid watermark record, and pairs are present (5.6).
    NoWatermark,
    /// Both watermark records are valid with the same `seq` (5.6).
    EqualWatermarks,
}

impl Integrity {
    /// Operator-facing description, without key material.
    pub fn describe(self) -> String {
        match self {
            Integrity::Erased { unit } => format!(
                "unit {unit} has no valid slot below the durable-size watermark (erased or corrupted)"
            ),
            Integrity::EqualGenerations { unit } => {
                format!("unit {unit} has two valid slots with the same generation (tampered)")
            }
            Integrity::NoWatermark => {
                "no valid durable-size watermark record, but data is present".to_string()
            }
            Integrity::EqualWatermarks => {
                "both durable-size watermark records are valid with the same sequence (tampered)"
                    .to_string()
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SlotError<E> {
    Storage(E),
    Integrity(Integrity),
}

impl<E> From<E> for SlotError<E> {
    fn from(error: E) -> Self {
        SlotError::Storage(error)
    }
}

type SlotResult<T, E> = Result<T, SlotError<E>>;

/// The unit's newest version on disk, if any slot authenticates.
#[derive(Debug, PartialEq, Eq)]
pub struct Winner {
    pub slot: Slot,
    pub generation: u64,
    pub plain: Vec<u8>,
}

/// Select the winner of `unit` from its pair's bytes, cut at the end of the
/// file (5.5). The slot claiming the higher generation is verified first; a
/// claim proves nothing until its tag verifies, so a torn slot that claims a
/// newer generation never wins (C13).
pub fn select(
    keys: &SlotKeys,
    file_id: &FileId,
    unit: u64,
    pair: &[u8],
) -> Result<Option<Winner>, Integrity> {
    let bytes = |slot: Slot| pair.get(slot.offset_in_pair()..).unwrap_or_default();
    let open = |slot: Slot| open_slot(keys, file_id, unit, slot, bytes(slot));
    let (claim_a, claim_b) = (
        claimed_generation(bytes(Slot::A)),
        claimed_generation(bytes(Slot::B)),
    );
    let first = if claim_b > claim_a { Slot::B } else { Slot::A };
    let winner = match open(first) {
        // Equal claims: the other slot may be valid with the same generation.
        Some(_) if claim_a == claim_b && open(first.other()).is_some() => {
            return Err(Integrity::EqualGenerations { unit })
        }
        Some(opened) => Some((first, opened)),
        None => open(first.other()).map(|opened| (first.other(), opened)),
    };
    Ok(winner.map(|(slot, opened)| Winner {
        slot,
        generation: opened.generation,
        plain: opened.plain,
    }))
}

/// The durable-size watermark in force.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Watermark {
    /// Which record holds it.
    pub record: u8,
    pub seq: u64,
    /// `D`: every unit below it had a valid slot at a completed sync.
    pub durable_units: u64,
}

/// Verify one watermark record (5.6). `bytes` is cut at the end of the file.
fn open_record(keys: &SlotKeys, file_id: &FileId, index: u8, bytes: &[u8]) -> Option<Watermark> {
    let record = bytes.get(..RECORD_LEN)?;
    let seq = le_u64(&record[COUNTER]);
    if seq == 0 || !is_zero(&record[BOUND_TAIL]) {
        return None;
    }
    let aad = aad(RECORD_DOMAIN, file_id, &[index], record);
    verify(&keys.records, record, &aad, &mut []).then_some(Watermark {
        record: index,
        seq,
        durable_units: le_u64(&record[DURABLE_UNITS]),
    })
}

/// Select the watermark from the bytes of both record pages, read from
/// [`RECORD_AT`]`[0]` and cut at the end of the file. `None` when no record
/// is valid.
pub fn select_watermark(
    keys: &SlotKeys,
    file_id: &FileId,
    pages: &[u8],
) -> Result<Option<Watermark>, Integrity> {
    let records = RECORD_AT.map(|at| (at - RECORD_AT[0]) as usize);
    let [zero, one] = [0u8, 1].map(|index| {
        let bytes = pages.get(records[index as usize]..).unwrap_or_default();
        open_record(keys, file_id, index, bytes)
    });
    match (zero, one) {
        (Some(a), Some(b)) if a.seq == b.seq => Err(Integrity::EqualWatermarks),
        (Some(a), Some(b)) => Ok(Some(if b.seq > a.seq { b } else { a })),
        (a, b) => Ok(a.or(b)),
    }
}

/// What a reader needs to know about a codec-4 file before reading a unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    /// The watermark's `D`, 0 for an interrupted birth.
    pub durable_units: u64,
    /// The logical size (5.3).
    pub size: u64,
}

/// An open codec-4 file.
pub struct SlotFile<'a, S: Storage> {
    pub keys: &'a SlotKeys,
    pub file_id: FileId,
    pub storage: &'a S,
}

impl<S: Storage> SlotFile<'_, S> {
    fn read_pairs(&self, first: u64, count: u64) -> SlotResult<Vec<u8>, S::Error> {
        Ok(self
            .storage
            .read_at(slot_offset(first, Slot::A), count * PAIR_LEN)?)
    }

    fn select(&self, unit: u64, pair: &[u8]) -> SlotResult<Option<Winner>, S::Error> {
        select(self.keys, &self.file_id, unit, pair).map_err(SlotError::Integrity)
    }

    /// Read the watermark and compute the logical size (5.3, 5.6).
    pub fn layout(&self) -> SlotResult<Layout, S::Error> {
        let physical = self.storage.size()?;
        let span = RECORD_AT[1] - RECORD_AT[0] + RECORD_LEN as u64;
        let pages = self.storage.read_at(RECORD_AT[0], span)?;
        let durable_units = match select_watermark(self.keys, &self.file_id, &pages) {
            Ok(Some(watermark)) => watermark.durable_units,
            // An interrupted birth: no pair can exist yet (C8a).
            Ok(None) if physical <= PAIRS_START => 0,
            Ok(None) => return Err(SlotError::Integrity(Integrity::NoWatermark)),
            Err(integrity) => return Err(SlotError::Integrity(integrity)),
        };
        for unit in (0..pairs_present(physical)).rev() {
            let pair = self.read_pairs(unit, 1)?;
            match self.select(unit, &pair)? {
                Some(winner) => {
                    return Ok(Layout {
                        durable_units,
                        size: unit * UNIT + winner.plain.len() as u64,
                    })
                }
                // A trailing pair of an unsynced extension (C7, C14).
                None if unit >= durable_units => {}
                None => return Err(SlotError::Integrity(Integrity::Erased { unit })),
            }
        }
        Ok(Layout {
            durable_units,
            size: 0,
        })
    }

    /// Read up to `len` bytes at `offset` of a file with `layout`, with one
    /// host read over the pairs. Returns the data and whether it reaches the
    /// end of the file.
    pub fn read(
        &self,
        layout: Layout,
        len: u64,
        offset: u64,
    ) -> SlotResult<(Vec<u8>, bool), S::Error> {
        let size = layout.size;
        if offset >= size || len == 0 {
            return Ok((Vec::new(), offset >= size));
        }
        let end = offset.saturating_add(len).min(size);
        let (first, last) = (offset / UNIT, (end - 1) / UNIT);
        let pairs = self.read_pairs(first, last - first + 1)?;
        let mut plain = Vec::with_capacity(((last - first + 1) * UNIT) as usize);
        for unit in first..=last {
            let at = ((unit - first) * PAIR_LEN) as usize;
            let pair = pairs.get(at..).unwrap_or_default();
            let pair = &pair[..pair.len().min(PAIR_LEN as usize)];
            let mut bytes = match self.select(unit, pair)? {
                Some(winner) => winner.plain,
                // A hole of an unsynced extension reads as zeros (C14).
                None if unit >= layout.durable_units => Vec::new(),
                None => return Err(SlotError::Integrity(Integrity::Erased { unit })),
            };
            // A short interior winner is followed by zeros (C7).
            bytes.resize(UNIT.min(size - unit * UNIT) as usize, 0);
            plain.extend_from_slice(&bytes);
        }
        let start = (offset - first * UNIT) as usize;
        let data = plain[start..start + (end - offset) as usize].to_vec();
        Ok((data, end == size))
    }
}

/// Test-only writer helpers: they build codec-4 images for the reader's
/// tests and fixtures. This build ships no codec-4 writer.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use crate::header::NONCE_LEN;

    fn seal(cipher: &XChaCha20Poly1305, head: &mut [u8], aad: &[u8], body: &mut [u8]) {
        let tag = cipher
            .encrypt_in_place_detached(XNonce::from_slice(&head[NONCE]), aad, body)
            .expect("XChaCha20-Poly1305 seals any unit");
        head[TAG].copy_from_slice(&tag);
    }

    /// The `64 + len` bytes of a slot holding `plain`.
    pub fn seal_slot(
        keys: &SlotKeys,
        file_id: &FileId,
        unit: u64,
        slot: Slot,
        generation: u64,
        plain: &[u8],
        nonce: &[u8; NONCE_LEN],
    ) -> Vec<u8> {
        let mut head = [0u8; SLOT_HEADER];
        head[COUNTER].copy_from_slice(&generation.to_le_bytes());
        head[SLOT_LEN_FIELD].copy_from_slice(&(plain.len() as u32).to_le_bytes());
        head[NONCE].copy_from_slice(nonce);
        let mut body = plain.to_vec();
        let aad = aad(SLOT_DOMAIN, file_id, &slot_position(unit, slot), &head);
        seal(&keys.slots, &mut head, &aad, &mut body);
        [&head[..], &body].concat()
    }

    /// The 64 bytes of watermark record `index`.
    pub fn seal_record(
        keys: &SlotKeys,
        file_id: &FileId,
        index: u8,
        seq: u64,
        durable_units: u64,
        nonce: &[u8; NONCE_LEN],
    ) -> [u8; RECORD_LEN] {
        let mut record = [0u8; RECORD_LEN];
        record[COUNTER].copy_from_slice(&seq.to_le_bytes());
        record[DURABLE_UNITS].copy_from_slice(&durable_units.to_le_bytes());
        record[NONCE].copy_from_slice(nonce);
        let aad = aad(RECORD_DOMAIN, file_id, &[index], &record);
        seal(&keys.records, &mut record, &aad, &mut []);
        record
    }

    /// A physical codec-4 file under construction, with a deterministic nonce
    /// per seal.
    pub struct Image<'a> {
        pub keys: &'a SlotKeys,
        pub file_id: FileId,
        pub bytes: Vec<u8>,
        nonces: u64,
    }

    impl<'a> Image<'a> {
        /// The birth block (5.6): the header page with `header` and both
        /// record pages, record 0 sealed as `seq = 1, D = 0`.
        pub fn born(keys: &'a SlotKeys, file_id: FileId, header: &[u8]) -> Image<'a> {
            let mut image = Image {
                keys,
                file_id,
                bytes: vec![0u8; PAIRS_START as usize],
                nonces: 0,
            };
            image.bytes[..header.len()].copy_from_slice(header);
            image.record(0, 1, 0);
            image
        }

        pub fn nonce(&mut self) -> [u8; NONCE_LEN] {
            self.nonces += 1;
            let mut nonce = [0u8; NONCE_LEN];
            nonce[..8].copy_from_slice(&self.nonces.to_le_bytes());
            nonce[8..16].copy_from_slice(&self.file_id[..8]);
            nonce
        }

        pub fn put(&mut self, at: u64, data: &[u8]) {
            let end = at as usize + data.len();
            if self.bytes.len() < end {
                self.bytes.resize(end, 0);
            }
            self.bytes[at as usize..end].copy_from_slice(data);
        }

        pub fn record(&mut self, index: u8, seq: u64, durable_units: u64) {
            let nonce = self.nonce();
            let record = seal_record(self.keys, &self.file_id, index, seq, durable_units, &nonce);
            self.put(RECORD_AT[index as usize], &record);
        }

        pub fn sealed_slot(
            &mut self,
            unit: u64,
            slot: Slot,
            generation: u64,
            plain: &[u8],
        ) -> Vec<u8> {
            let nonce = self.nonce();
            seal_slot(
                self.keys,
                &self.file_id,
                unit,
                slot,
                generation,
                plain,
                &nonce,
            )
        }

        pub fn slot(&mut self, unit: u64, slot: Slot, generation: u64, plain: &[u8]) {
            let bytes = self.sealed_slot(unit, slot, generation, plain);
            self.put(slot_offset(unit, slot), &bytes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::file::tests::{Memory, XorShift};
    use crate::header::NONCE_LEN;
    use std::cell::RefCell;

    const FILE_ID: FileId = [0x5A; 16];

    fn keys() -> SlotKeys {
        SlotKeys::derive(&core::array::from_fn(|i| i as u8 ^ 0xC3))
    }

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(29).wrapping_add(seed))
            .collect()
    }

    fn file<'a>(keys: &'a SlotKeys, storage: &'a Memory) -> SlotFile<'a, Memory> {
        SlotFile {
            keys,
            file_id: FILE_ID,
            storage,
        }
    }

    fn memory(image: &Image) -> Memory {
        Memory(RefCell::new(image.bytes.clone()))
    }

    fn read_all(keys: &SlotKeys, m: &Memory) -> Result<Vec<u8>, SlotError<()>> {
        let f = file(keys, m);
        let layout = f.layout()?;
        let (data, eof) = f.read(layout, layout.size + 10, 0)?;
        assert!(eof);
        Ok(data)
    }

    fn erased(unit: u64) -> SlotError<()> {
        SlotError::Integrity(Integrity::Erased { unit })
    }

    #[test]
    fn layout_constants_match_the_design() {
        assert_eq!((SLOT_LEN, PAIR_LEN, PAIRS_START), (8256, 16512, 12288));
        assert_eq!(RECORD_AT, [4096, 8192]);
        assert_eq!(slot_offset(0, Slot::A), 12288);
        assert_eq!(slot_offset(0, Slot::B), 12288 + 8256);
        assert_eq!(slot_offset(3, Slot::B), 12288 + 3 * 16512 + 8256);
        assert_eq!(pairs_present(0), 0);
        assert_eq!(pairs_present(12288), 0);
        assert_eq!(pairs_present(12289), 1);
        assert_eq!(pairs_present(12288 + 16512), 1);
        assert_eq!(pairs_present(12288 + 16512 + 1), 2);
        // Section 7: slot A of unit u starts at 128·u (mod 512), slot B at 128·u + 64.
        for unit in 0..64 {
            assert_eq!(slot_offset(unit, Slot::A) % 512, 128 * unit % 512);
            assert_eq!(slot_offset(unit, Slot::B) % 512, (128 * unit + 64) % 512);
        }
    }

    const KAT: &str = include_str!("testdata/codec4-kat.txt");

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn shown(bytes: &[u8]) -> String {
        if bytes.len() > 128 {
            use sha2::Digest;
            format!("sha256:{:x}", Sha256::digest(bytes))
        } else {
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }
    }

    /// The KAT file's DEK, file id, nonces and plaintexts.
    fn kat_dek() -> [u8; DEK_LEN] {
        core::array::from_fn(|i| ((5 * i + 7) % 256) as u8)
    }
    const KAT_FILE_ID: FileId = [
        0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE,
        0xAF,
    ];
    fn kat_nonce(seed: usize) -> [u8; NONCE_LEN] {
        core::array::from_fn(|i| ((seed + 11 * i) % 256) as u8)
    }

    fn kat_lines(prefix: &str) -> Vec<Vec<&'static str>> {
        KAT.lines()
            .filter_map(|line| line.strip_prefix(prefix))
            .map(|line| line.split(' ').collect())
            .collect()
    }

    #[test]
    fn known_answer_key_derivations() {
        let lines = kat_lines("hkdf ");
        assert_eq!(lines.len(), 2);
        for fields in lines {
            let info = fields[0].as_bytes();
            assert!(info == INFO_AEAD || info == INFO_WATERMARK, "{}", fields[0]);
            assert_eq!(derive_key(&kat_dek(), info).to_vec(), hex(fields[1]));
        }
    }

    #[test]
    fn known_answer_slots() {
        let keys = SlotKeys::derive(&kat_dek());
        let lines = kat_lines("slot ");
        assert_eq!(lines.len(), 7);
        for fields in lines {
            let unit: u64 = fields[0].parse().unwrap();
            let slot = [Slot::A, Slot::B][fields[1].parse::<usize>().unwrap()];
            let generation: u64 = fields[2].parse().unwrap();
            let len: usize = fields[3].parse().unwrap();
            let nonce = kat_nonce(fields[4].parse().unwrap());
            let plain: Vec<u8> = (0..len).map(|i| ((7 * i + 3) % 256) as u8).collect();
            let sealed = seal_slot(&keys, &KAT_FILE_ID, unit, slot, generation, &plain, &nonce);
            assert_eq!(
                shown(&sealed),
                fields[5],
                "unit {unit} slot {slot:?} len {len}"
            );
            let opened = open_slot(&keys, &KAT_FILE_ID, unit, slot, &sealed).unwrap();
            assert_eq!((opened.generation, opened.plain), (generation, plain));
        }
    }

    #[test]
    fn known_answer_records() {
        let keys = SlotKeys::derive(&kat_dek());
        let lines = kat_lines("record ");
        assert_eq!(lines.len(), 3);
        for fields in lines {
            let index: u8 = fields[0].parse().unwrap();
            let seq: u64 = fields[1].parse().unwrap();
            let durable_units: u64 = fields[2].parse().unwrap();
            let nonce = kat_nonce(fields[3].parse().unwrap());
            let record = seal_record(&keys, &KAT_FILE_ID, index, seq, durable_units, &nonce);
            assert_eq!(shown(&record), fields[4], "record {index}");
            assert_eq!(
                open_record(&keys, &KAT_FILE_ID, index, &record),
                Some(Watermark {
                    record: index,
                    seq,
                    durable_units
                })
            );
        }
    }

    #[test]
    fn slots_round_trip_every_length_class() {
        let keys = keys();
        for len in [1, 15, 16, 8191, 8192] {
            for slot in [Slot::A, Slot::B] {
                let plain = pattern(len, 3);
                let sealed = seal_slot(&keys, &FILE_ID, 7, slot, 9, &plain, &[1; NONCE_LEN]);
                assert_eq!(sealed.len(), SLOT_HEADER + len);
                assert!(!sealed
                    .windows(8)
                    .any(|w| plain.len() >= 8 && w == &plain[..8]));
                let opened = open_slot(&keys, &FILE_ID, 7, slot, &sealed).unwrap();
                assert_eq!((opened.generation, opened.plain), (9, plain));
                // Padding after the ciphertext is neither required nor read (Q16).
                let padded = [&sealed[..], &[0xEE; 100]].concat();
                assert!(open_slot(&keys, &FILE_ID, 7, slot, &padded).is_some());
            }
        }
    }

    #[test]
    fn slots_are_bound_to_file_unit_position_and_metadata() {
        let keys = keys();
        let sealed = seal_slot(&keys, &FILE_ID, 4, Slot::A, 3, &pattern(100, 1), &[2; 24]);
        let opens =
            |unit, slot, bytes: &[u8]| open_slot(&keys, &FILE_ID, unit, slot, bytes).is_some();
        assert!(opens(4, Slot::A, &sealed));
        // Swapping slots, moving it to another unit or file, or another key.
        assert!(!opens(4, Slot::B, &sealed));
        assert!(!opens(5, Slot::A, &sealed));
        assert!(open_slot(&keys, &[0x5B; 16], 4, Slot::A, &sealed).is_none());
        let other = SlotKeys::derive(&[9; DEK_LEN]);
        assert!(open_slot(&other, &FILE_ID, 4, Slot::A, &sealed).is_none());
        // Any edit of the generation, length, reserved bytes, nonce, tag or
        // ciphertext.
        for at in [0, 7, 8, 11, 12, 15, 16, 39, 40, 55, 56, 63, 64, 100, 163] {
            let mut tampered = sealed.clone();
            tampered[at] ^= 1;
            assert!(!opens(4, Slot::A, &tampered), "byte {at}");
        }
        // Cut short: the slot reaches past the end of the file.
        assert!(!opens(4, Slot::A, &sealed[..sealed.len() - 1]));
        assert!(!opens(4, Slot::A, &sealed[..SLOT_HEADER]));
        assert!(!opens(4, Slot::A, &[]));
    }

    #[test]
    fn malformed_slots_are_invalid_before_any_tag_check() {
        let keys = keys();
        // Generation 0, and lengths 0 and 8193: sealed correctly, still invalid.
        let gen0 = seal_slot(&keys, &FILE_ID, 0, Slot::A, 0, &[1; 10], &[3; 24]);
        assert!(open_slot(&keys, &FILE_ID, 0, Slot::A, &gen0).is_none());
        let empty = seal_slot(&keys, &FILE_ID, 0, Slot::A, 1, &[], &[3; 24]);
        assert!(open_slot(&keys, &FILE_ID, 0, Slot::A, &empty).is_none());
        let long = seal_slot(&keys, &FILE_ID, 0, Slot::A, 1, &[1; 8193], &[3; 24]);
        assert!(open_slot(&keys, &FILE_ID, 0, Slot::A, &long).is_none());
        assert!(open_slot(&keys, &FILE_ID, 0, Slot::A, &[0; SLOT_LEN as usize]).is_none());
    }

    /// A pair of `unit` with the given slot images, slot B at its offset.
    fn pair(a: &[u8], b: &[u8]) -> Vec<u8> {
        let mut bytes = a.to_vec();
        if !b.is_empty() {
            bytes.resize(SLOT_LEN as usize, 0);
            bytes.extend_from_slice(b);
        }
        bytes
    }

    fn torn(sealed: &[u8]) -> Vec<u8> {
        let mut torn = sealed.to_vec();
        let mid = torn.len() / 2;
        torn[mid..].fill(0x99);
        torn
    }

    #[test]
    fn selection_follows_the_table() {
        let keys = keys();
        let seal = |slot, generation, seed| {
            seal_slot(
                &keys,
                &FILE_ID,
                2,
                slot,
                generation,
                &pattern(300, seed),
                &[seed; 24],
            )
        };
        let pick = |a: &[u8], b: &[u8]| {
            select(&keys, &FILE_ID, 2, &pair(a, b))
                .map(|w| w.map(|w| (w.slot, w.generation, w.plain[0])))
        };
        let (a5, b6, b4) = (
            seal(Slot::A, 5, 1),
            seal(Slot::B, 6, 2),
            seal(Slot::B, 4, 3),
        );
        let p = |seed| pattern(300, seed)[0];
        assert_eq!(pick(&a5, &b6), Ok(Some((Slot::B, 6, p(2)))));
        assert_eq!(pick(&a5, &b4), Ok(Some((Slot::A, 5, p(1)))));
        // Symmetric: A newer than B.
        let (a7, b3) = (seal(Slot::A, 7, 4), seal(Slot::B, 3, 5));
        assert_eq!(pick(&a7, &b3), Ok(Some((Slot::A, 7, p(4)))));
        // One valid slot, the other invalid, zero or absent.
        assert_eq!(pick(&a5, &torn(&b6)), Ok(Some((Slot::A, 5, p(1)))));
        assert_eq!(pick(&a5, &[0; 64]), Ok(Some((Slot::A, 5, p(1)))));
        assert_eq!(pick(&a5, &[]), Ok(Some((Slot::A, 5, p(1)))));
        assert_eq!(pick(&torn(&a7), &b3), Ok(Some((Slot::B, 3, p(5)))));
        assert_eq!(pick(&[0; 64], &b6), Ok(Some((Slot::B, 6, p(2)))));
        // Neither valid.
        assert_eq!(pick(&torn(&a5), &torn(&b6)), Ok(None));
        assert_eq!(pick(&[0; 64], &[]), Ok(None));
        assert_eq!(pick(&[], &[]), Ok(None));
        // Equal generations in two valid slots cannot happen without tampering.
        let b5 = seal(Slot::B, 5, 6);
        assert_eq!(pick(&a5, &b5), Err(Integrity::EqualGenerations { unit: 2 }));
        // Equal claims with one slot invalid are not a conflict.
        assert_eq!(pick(&a5, &torn(&b5)), Ok(Some((Slot::A, 5, p(1)))));
        assert_eq!(pick(&torn(&a5), &b5), Ok(Some((Slot::B, 5, p(6)))));
    }

    #[test]
    fn a_torn_slot_claiming_a_newer_generation_never_wins() {
        // C13: the torn write to B kept its new header (generation g+1) over
        // old ciphertext. The durable v1 in A is the winner.
        let keys = keys();
        let a = seal_slot(&keys, &FILE_ID, 0, Slot::A, 10, &pattern(8192, 1), &[1; 24]);
        let new_b = seal_slot(&keys, &FILE_ID, 0, Slot::B, 11, &pattern(8192, 2), &[2; 24]);
        let old_b = seal_slot(&keys, &FILE_ID, 0, Slot::B, 9, &pattern(8192, 3), &[3; 24]);
        for cut in [512usize, 4096, 8192] {
            let b = [&new_b[..cut], &old_b[cut..]].concat();
            assert_eq!(claimed_generation(&b), 11);
            let winner = select(&keys, &FILE_ID, 0, &pair(&a, &b)).unwrap().unwrap();
            assert_eq!((winner.slot, winner.generation), (Slot::A, 10), "cut {cut}");
            assert_eq!(winner.plain, pattern(8192, 1));
        }
    }

    #[test]
    fn watermark_records_are_bound_and_selected() {
        let keys = keys();
        let rec = |index, seq, d| seal_record(&keys, &FILE_ID, index, seq, d, &[seq as u8; 24]);
        let pages = |zero: &[u8], one: &[u8]| {
            let mut bytes = zero.to_vec();
            if !one.is_empty() {
                bytes.resize(4096, 0);
                bytes.extend_from_slice(one);
            }
            bytes
        };
        let wm = |record, seq, durable_units| Watermark {
            record,
            seq,
            durable_units,
        };
        let pick = |zero: &[u8], one: &[u8]| select_watermark(&keys, &FILE_ID, &pages(zero, one));
        let (r0, r1) = (rec(0, 4, 10), rec(1, 5, 12));
        assert_eq!(pick(&r0, &r1), Ok(Some(wm(1, 5, 12))));
        assert_eq!(pick(&rec(0, 6, 3), &r1), Ok(Some(wm(0, 6, 3))));
        assert_eq!(pick(&r0, &[]), Ok(Some(wm(0, 4, 10))));
        assert_eq!(pick(&[0; 64], &r1), Ok(Some(wm(1, 5, 12))));
        assert_eq!(pick(&[], &[]), Ok(None));
        assert_eq!(pick(&rec(0, 5, 1), &r1), Err(Integrity::EqualWatermarks));
        // A torn record falls back to the other one (C15).
        assert_eq!(pick(&r0, &torn(&r1)), Ok(Some(wm(0, 4, 10))));
        // Swapping records, moving one to another file, editing seq, D,
        // the reserved bytes, nonce or tag.
        assert_eq!(pick(&r1, &r0), Ok(None));
        assert_eq!(
            select_watermark(&keys, &[1; 16], &pages(&r0, &r1)),
            Ok(None)
        );
        for at in [0, 7, 8, 15, 16, 39, 40, 55, 56, 63] {
            let mut tampered = r0;
            tampered[at] ^= 1;
            assert_eq!(pick(&tampered, &[]), Ok(None), "byte {at}");
        }
        // seq 0 is never written; a record cut by the end of file is absent.
        assert_eq!(pick(&rec(0, 0, 7), &[]), Ok(None));
        assert_eq!(pick(&r0[..63], &[]), Ok(None));
        // A slot is not a record and a record is not a slot.
        let slot = seal_slot(&keys, &FILE_ID, 0, Slot::A, 4, &[0; 1], &[4; 24]);
        assert_eq!(pick(&slot[..64], &[]), Ok(None));
        assert!(open_slot(&keys, &FILE_ID, 0, Slot::A, &[&r0[..], &[0; 1]].concat()).is_none());
    }

    /// A file of three units, all durable: `D = 3`.
    fn three_units(keys: &SlotKeys) -> (Image<'_>, Vec<u8>) {
        let mut image = Image::born(keys, FILE_ID, b"header");
        let data = pattern(2 * 8192 + 100, 7);
        image.slot(0, Slot::A, 1, &data[..8192]);
        image.slot(1, Slot::A, 1, &data[8192..16384]);
        image.slot(2, Slot::A, 1, &data[16384..]);
        image.record(1, 2, 3);
        (image, data)
    }

    #[test]
    fn reads_whole_files_and_ranges() {
        let keys = keys();
        let (image, data) = three_units(&keys);
        let m = memory(&image);
        assert_eq!(read_all(&keys, &m).unwrap(), data);
        let f = file(&keys, &m);
        let layout = f.layout().unwrap();
        assert_eq!(
            layout,
            Layout {
                durable_units: 3,
                size: data.len() as u64
            }
        );
        assert_eq!(f.read(layout, 0, 5).unwrap(), (vec![], false));
        assert_eq!(
            f.read(layout, 10, 8190).unwrap(),
            (data[8190..8200].to_vec(), false)
        );
        assert_eq!(
            f.read(layout, 1000, 16000).unwrap(),
            (data[16000..].to_vec(), true)
        );
        assert_eq!(
            f.read(layout, u64::MAX, 5).unwrap(),
            (data[5..].to_vec(), true)
        );
        assert_eq!(f.read(layout, 1, layout.size).unwrap(), (vec![], true));
        // The physical size: the last unit's slot B was never written.
        assert_eq!(m.0.borrow().len() as u64, 12288 + 2 * 16512 + 64 + 100);
    }

    #[test]
    fn interrupted_births_read_as_empty() {
        // C8a: a valid header without a valid record, no room for a pair.
        let keys = keys();
        for physical in [152, 4096, 4096 + 63, 8192 + 10, 12288] {
            let m = Memory(RefCell::new(vec![0; physical]));
            let f = file(&keys, &m);
            assert_eq!(
                f.layout(),
                Ok(Layout {
                    durable_units: 0,
                    size: 0
                }),
                "{physical}"
            );
        }
        // Born, no pair yet.
        let image = Image::born(&keys, FILE_ID, b"header");
        assert_eq!(read_all(&keys, &memory(&image)).unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn no_valid_record_with_pairs_present_is_an_integrity_error() {
        let keys = keys();
        let (mut image, _) = three_units(&keys);
        image.put(RECORD_AT[0], &[0; RECORD_LEN]);
        image.put(RECORD_AT[1], &[0; RECORD_LEN]);
        let m = memory(&image);
        assert_eq!(
            file(&keys, &m).layout(),
            Err(SlotError::Integrity(Integrity::NoWatermark))
        );
        // One byte of a pair is enough for "pairs present".
        let m = Memory(RefCell::new(vec![0; PAIRS_START as usize + 1]));
        assert_eq!(
            file(&keys, &m).layout(),
            Err(SlotError::Integrity(Integrity::NoWatermark))
        );
    }

    #[test]
    fn units_without_a_valid_slot_read_by_the_watermark() {
        let keys = keys();
        let data = pattern(8192 * 4, 3);
        // Units 0..4 written; unit 1 and unit 3 have no valid slot.
        let build = |durable_units| {
            let mut image = Image::born(&keys, FILE_ID, b"header");
            image.slot(0, Slot::A, 1, &data[..8192]);
            let torn = torn(&image.sealed_slot(1, Slot::A, 1, &data[8192..16384]));
            image.put(slot_offset(1, Slot::A), &torn);
            image.slot(2, Slot::A, 1, &data[16384..24576]);
            image.put(slot_offset(3, Slot::A), &[0; 200]);
            image.record(1, 2, durable_units);
            memory(&image)
        };
        // D = 1: unit 1 is an interior hole (zeros, C14), unit 3 a trailing pair (dropped).
        let m = build(1);
        let expected = [&data[..8192], &[0; 8192], &data[16384..24576]].concat();
        assert_eq!(read_all(&keys, &m).unwrap(), expected);
        // D = 3: unit 1 is below D, so reading it fails, the others still read.
        let m = build(3);
        let f = file(&keys, &m);
        let layout = f.layout().unwrap();
        assert_eq!(layout.size, 3 * 8192);
        assert_eq!(f.read(layout, 8192, 0).unwrap().0, data[..8192]);
        assert_eq!(f.read(layout, 1, 8192), Err(erased(1)));
        assert_eq!(f.read(layout, 10, 16380), Err(erased(1)));
        assert_eq!(f.read(layout, 8192, 16384).unwrap().0, data[16384..24576]);
        // D = 4: the trailing pair 3 is below D: the size computation fails.
        let m = build(4);
        assert_eq!(file(&keys, &m).layout(), Err(erased(3)));
    }

    #[test]
    fn absent_pairs_are_never_an_integrity_error() {
        // A host file shorter than D units (a truncate, or a shrink's record
        // reordered before its sync, 6.4) reads as a shorter file.
        let keys = keys();
        let (mut image, data) = three_units(&keys);
        image.record(0, 9, 100);
        let m = memory(&image);
        assert_eq!(read_all(&keys, &m).unwrap(), data);
        m.0.borrow_mut().truncate(slot_offset(2, Slot::A) as usize);
        assert_eq!(read_all(&keys, &m).unwrap(), data[..16384]);
    }

    #[test]
    fn a_short_interior_winner_is_followed_by_zeros() {
        // C7: an unsynced append grew unit 0, but unit 1 reached the disk first.
        let keys = keys();
        let mut image = Image::born(&keys, FILE_ID, b"header");
        image.slot(0, Slot::A, 1, b"short");
        image.slot(1, Slot::A, 1, b"next");
        let m = memory(&image);
        let mut expected = b"short".to_vec();
        expected.resize(8192, 0);
        expected.extend_from_slice(b"next");
        assert_eq!(read_all(&keys, &m).unwrap(), expected);
    }

    #[test]
    fn equal_generations_fail_reads_and_sizes() {
        let keys = keys();
        let (mut image, _) = three_units(&keys);
        image.slot(2, Slot::B, 1, b"forged");
        let m = memory(&image);
        let conflict = SlotError::Integrity(Integrity::EqualGenerations { unit: 2 });
        assert_eq!(file(&keys, &m).layout(), Err(conflict));
        // An interior conflict fails the reads that touch it.
        let (mut image, data) = three_units(&keys);
        image.slot(0, Slot::B, 1, b"forged");
        let m = memory(&image);
        let f = file(&keys, &m);
        let layout = f.layout().unwrap();
        let conflict = SlotError::Integrity(Integrity::EqualGenerations { unit: 0 });
        assert_eq!(f.read(layout, 10, 0), Err(conflict));
        assert_eq!(f.read(layout, 10, 8192).unwrap().0, data[8192..8202]);
    }

    /// The whole-file fixture `testdata/codec4/four-units.bin`, built by the
    /// test-only writer: master key `[0x11; 32]`, DEK byte i = 3i + 1, file
    /// id `[0xF4; 16]`, header nonce `[5; 24]`, plaintext of unit u byte i =
    /// (13i + 5 + u) % 251. Unit 0 was rewritten (old A, newer B); unit 1 has
    /// a torn B claiming a newer generation over a valid A (C13); unit 2 is a
    /// hole above `D = 2` (C14); unit 3 is the short last unit.
    fn fixture() -> (Vec<u8>, Vec<u8>) {
        use crate::codec::Codec;
        use crate::header::Header;
        let kek = crate::keys::Kek::derive(&[0x11; 32]);
        let dek: [u8; DEK_LEN] =
            core::array::from_fn(|i| (i as u8).wrapping_mul(3).wrapping_add(1));
        let file_id = [0xF4; 16];
        let header = Header::seal(&kek, Codec::TwoSlotAead, &file_id, &dek, &[5; 24]);
        let keys = SlotKeys::derive(&dek);
        let unit = |u: usize, len: usize| -> Vec<u8> {
            (0..len).map(|i| ((i * 13 + 5 + u) % 251) as u8).collect()
        };
        let mut image = Image::born(&keys, file_id, header.as_bytes());
        image.slot(0, Slot::A, 1, &unit(9, 8192));
        image.slot(0, Slot::B, 2, &unit(0, 8192));
        image.slot(1, Slot::A, 3, &unit(1, 8192));
        let newer = image.sealed_slot(1, Slot::B, 4, &unit(7, 8192));
        let old = image.sealed_slot(1, Slot::B, 2, &unit(8, 8192));
        image.put(
            slot_offset(1, Slot::B),
            &[&newer[..512], &old[512..]].concat(),
        );
        image.put(slot_offset(2, Slot::A), &[0; 4096]);
        image.slot(3, Slot::A, 1, &unit(3, 1000));
        image.record(1, 2, 2);
        let plain = [unit(0, 8192), unit(1, 8192), vec![0; 8192], unit(3, 1000)].concat();
        (image.bytes, plain)
    }

    const FIXTURE: &[u8] = include_bytes!("testdata/codec4/four-units.bin");

    #[test]
    fn codec_4_fixture_reads_as_the_component_opens_it() {
        use crate::codec::Codec;
        use crate::header::{classify_in, HeaderState};
        use crate::marker::Mode;
        let (_, plain) = fixture();
        let header = match classify_in(FIXTURE, FIXTURE.len() as u64, Mode::Integrity) {
            Ok(HeaderState::Sealed(header)) => header,
            other => panic!("{other:?}"),
        };
        assert_eq!(header.codec(), Codec::TwoSlotAead);
        assert!(Mode::Integrity.admits(header.codec()) && !Mode::Xts.admits(header.codec()));
        let dek = header.open(&crate::keys::Kek::derive(&[0x11; 32])).unwrap();
        let keys = SlotKeys::derive(&dek);
        let m = Memory(RefCell::new(FIXTURE.to_vec()));
        let f = SlotFile {
            keys: &keys,
            file_id: header.file_id(),
            storage: &m,
        };
        let layout = f.layout().unwrap();
        assert_eq!(
            layout,
            Layout {
                durable_units: 2,
                size: 3 * 8192 + 1000
            }
        );
        assert_eq!(f.read(layout, layout.size, 0).unwrap(), (plain, true));
    }

    #[test]
    fn codec_4_fixture_is_what_the_test_writer_builds() {
        // Pins the on-disk format: the writer release must read this file.
        assert_eq!(fixture().0, FIXTURE);
    }

    #[test]
    #[ignore = "regenerates src/testdata/codec4/four-units.bin"]
    fn write_codec_4_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/testdata/codec4/four-units.bin"
        );
        std::fs::write(path, fixture().0).unwrap();
    }

    #[test]
    fn integrity_errors_describe_the_unit_without_secrets() {
        assert!(Integrity::Erased { unit: 7 }.describe().contains("unit 7"));
        assert!(Integrity::EqualGenerations { unit: 3 }
            .describe()
            .contains("unit 3"));
        assert!(Integrity::NoWatermark.describe().contains("watermark"));
        assert!(Integrity::EqualWatermarks.describe().contains("watermark"));
    }

    #[test]
    fn storage_errors_propagate() {
        struct Broken;
        impl Storage for Broken {
            type Error = &'static str;
            fn size(&self) -> Result<u64, &'static str> {
                Err("stat failed")
            }
            fn read_at(&self, _: u64, _: u64) -> Result<Vec<u8>, &'static str> {
                Err("read failed")
            }
            fn write_at(&self, _: u64, _: &[u8]) -> Result<(), &'static str> {
                unreachable!()
            }
            fn set_len(&self, _: u64) -> Result<(), &'static str> {
                unreachable!()
            }
        }
        let keys = keys();
        let f = SlotFile {
            keys: &keys,
            file_id: FILE_ID,
            storage: &Broken,
        };
        assert_eq!(f.layout(), Err(SlotError::Storage("stat failed")));
        let layout = Layout {
            durable_units: 0,
            size: 10,
        };
        assert_eq!(f.read(layout, 5, 0), Err(SlotError::Storage("read failed")));
    }

    /// One unit of a random crash-only image (12.1 "Plaintext model").
    enum UnitState {
        /// A winner, plus what the other slot holds.
        Valid {
            plain: Vec<u8>,
            slot: Slot,
            generation: u64,
            other: Other,
        },
        /// No valid slot: only ever at or above `D` on a crash-only disk.
        Hole(Other, Other),
    }

    enum Other {
        Older,
        TornNewer,
        Zero,
        Garbage,
        Unwritten,
    }

    /// What the slot that does not win holds. A hole (`older` false) never
    /// gets a valid older slot.
    fn random_other(rng: &mut XorShift, older: bool) -> Other {
        match rng.below(5) {
            0 if older => Other::Older,
            0 => Other::Zero,
            1 => Other::TornNewer,
            2 => Other::Zero,
            3 => Other::Garbage,
            _ => Other::Unwritten,
        }
    }

    fn put_other(
        image: &mut Image,
        rng: &mut XorShift,
        unit: u64,
        slot: Slot,
        generation: u64,
        other: &Other,
    ) {
        let at = slot_offset(unit, slot);
        match other {
            Other::Older if generation > 1 => {
                let plain = pattern(1 + rng.below(8192) as usize, rng.next() as u8);
                image.slot(
                    unit,
                    slot,
                    generation - 1 - rng.below(generation - 1),
                    &plain,
                );
            }
            Other::Older | Other::Unwritten => {}
            Other::TornNewer => {
                let plain = pattern(8192, rng.next() as u8);
                let sealed = image.sealed_slot(unit, slot, generation + 1, &plain);
                let cut = 64 + 512 * rng.below(16) as usize;
                image.put(at, &sealed[..cut]);
                image.put(
                    at + cut as u64,
                    &vec![rng.next() as u8 | 1; sealed.len() - cut],
                );
            }
            Other::Zero => image.put(at, &[0; SLOT_LEN as usize]),
            Other::Garbage => {
                let garbage: Vec<u8> = (0..SLOT_LEN).map(|_| rng.next() as u8).collect();
                image.put(at, &garbage);
            }
        }
    }

    #[test]
    fn matches_a_plaintext_model_on_random_crash_only_images() {
        let keys = keys();
        let mut rng = XorShift(0xD1B5_4A32_D192_ED03);
        for round in 0..150 {
            let units = rng.below(7);
            let durable_units = rng.below(units + 1);
            let mut states = Vec::new();
            for unit in 0..units {
                // Holes only at or above D: the disk saw crashes, not erasure.
                let hole = unit >= durable_units && rng.below(4) == 0;
                states.push(if hole {
                    UnitState::Hole(random_other(&mut rng, false), random_other(&mut rng, false))
                } else {
                    let len = if rng.below(3) == 0 {
                        1 + rng.below(8192)
                    } else {
                        8192
                    };
                    UnitState::Valid {
                        plain: pattern(len as usize, rng.next() as u8),
                        slot: if rng.below(2) == 0 { Slot::A } else { Slot::B },
                        generation: 1 + rng.below(1000),
                        other: random_other(&mut rng, true),
                    }
                });
            }
            let mut image = Image::born(&keys, FILE_ID, b"header");
            image.record(1, 2, durable_units);
            for (unit, state) in states.iter().enumerate() {
                let unit = unit as u64;
                match state {
                    UnitState::Valid {
                        plain,
                        slot,
                        generation,
                        other,
                    } => {
                        put_other(&mut image, &mut rng, unit, slot.other(), *generation, other);
                        image.slot(unit, *slot, *generation, plain);
                    }
                    UnitState::Hole(a, b) => {
                        put_other(&mut image, &mut rng, unit, Slot::A, 5, a);
                        put_other(&mut image, &mut rng, unit, Slot::B, 5, b);
                    }
                }
            }
            // The model: the last valid unit ends the file; interior units are
            // padded with zeros and holes are zeros.
            let last = states
                .iter()
                .rposition(|s| matches!(s, UnitState::Valid { .. }));
            let mut model = Vec::new();
            for state in states.iter().take(last.map_or(0, |k| k + 1)) {
                let start = model.len();
                if let UnitState::Valid { plain, .. } = state {
                    model.extend_from_slice(plain);
                }
                model.resize(start + 8192, 0);
            }
            if let Some(UnitState::Valid { plain, .. }) = last.map(|k| &states[k]) {
                model.truncate(last.unwrap() * 8192 + plain.len());
            }
            let m = memory(&image);
            let f = file(&keys, &m);
            let layout = f
                .layout()
                .unwrap_or_else(|e| panic!("round {round}: {e:?}"));
            assert_eq!(layout.size, model.len() as u64, "round {round}");
            assert_eq!(layout.durable_units, durable_units, "round {round}");
            for _ in 0..8 {
                let offset = rng.below(model.len() as u64 + 10);
                let len = rng.below(3 * 8192);
                let (data, eof) = f.read(layout, len, offset).unwrap();
                let start = (offset as usize).min(model.len());
                let end = (offset + len).min(model.len() as u64) as usize;
                assert_eq!(
                    data,
                    model[start..end.max(start)],
                    "round {round} {offset}+{len}"
                );
                assert_eq!(eof, offset + len >= model.len() as u64, "round {round}");
            }
            // Erasing both slots of any unit below D is detected.
            if durable_units > 0 {
                let unit = rng.below(durable_units);
                let mut erased_image = m.0.borrow().clone();
                let start = slot_offset(unit, Slot::A) as usize;
                let end = (start + PAIR_LEN as usize).min(erased_image.len());
                erased_image[start..end].fill(0);
                let e = Memory(RefCell::new(erased_image));
                let f = file(&keys, &e);
                let result = f.layout().and_then(|l| f.read(l, 8192, unit * 8192));
                assert_eq!(result, Err(erased(unit)), "round {round}");
            }
        }
    }
}
