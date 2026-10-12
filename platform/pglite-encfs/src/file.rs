//! Logical file operations over an encrypted physical file.
//!
//! Physical layout: `[header: HEADER_LEN][unit 0][unit 1]...`, each unit
//! [`UNIT`] bytes of AES-XTS ciphertext except a shorter last one. XTS is
//! length-preserving, so `logical size = physical size - HEADER_LEN`.
//!
//! - Every logical write becomes exactly one physical write (after any
//!   read-modify-write of a partial first or last unit). Nothing is cached, and
//!   `sync`/`sync-data` pass straight through, so PostgreSQL's fsync ordering
//!   holds.
//! - A write past the end first zero-fills the gap with encrypted zeros: a hole
//!   left by the host would read back as garbage, not zeros.
//! - Torn and interrupted writes behave like plaintext at 16-byte block
//!   granularity, except at a final partial block: changing the length of a
//!   unit that ends mid-block re-encrypts its last full block and the partial
//!   block (ciphertext stealing, or the sub-block mask). A crash in the middle
//!   of such a resize or append can therefore garble up to 31 durable bytes
//!   just before the old or new end of file (see the
//!   `unaligned_resizes_bound_crash_damage` test, and #206). Relation and WAL I/O is in
//!   whole 8 KiB pages and never hits this.
//! - Sizes are capped at [`MAX_SIZE`], and a write may extend a file by at
//!   most [`MAX_GAP`] of zero fill, so absurd offsets fail instead of writing
//!   terabytes of encrypted zeros.
//!
//! The functions are generic over [`Storage`] so the host build can test them
//! against memory.

use crate::codec::{UnitCipher, UNIT};
use crate::header::HEADER_LEN;

/// Zero-fill and extension happen in chunks of this many bytes, so a large
/// `set-size` never needs a buffer of the full size.
pub const FILL_CHUNK: u64 = 1 << 20;
/// Largest logical file size (1 TiB; PostgreSQL segments are 1 GiB).
pub const MAX_SIZE: u64 = 1 << 40;
/// Largest zero fill one write or `set-size` may add (one PostgreSQL segment).
pub const MAX_GAP: u64 = 1 << 30;

/// Positional I/O on the physical file.
pub trait Storage {
    type Error;
    fn size(&self) -> Result<u64, Self::Error>;
    /// Read up to `len` bytes at `offset`; shorter only at end of file.
    fn read_at(&self, offset: u64, len: u64) -> Result<Vec<u8>, Self::Error>;
    /// Write all of `data` at `offset`.
    fn write_at(&self, offset: u64, data: &[u8]) -> Result<(), Self::Error>;
    fn set_len(&self, len: u64) -> Result<(), Self::Error>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum FileError<E> {
    Storage(E),
    /// The physical file is shorter than its logical size implies.
    Truncated,
    /// The write would pass [`MAX_SIZE`] or zero-fill more than [`MAX_GAP`].
    TooLarge,
}

impl<E> From<E> for FileError<E> {
    fn from(error: E) -> Self {
        FileError::Storage(error)
    }
}

type FileResult<T, E> = Result<T, FileError<E>>;

/// Logical size of a file with a header and `physical` bytes. A header that
/// was cut short by a crash holds no data yet.
pub fn logical_size(physical: u64) -> u64 {
    physical.saturating_sub(HEADER_LEN)
}

fn physical_offset(logical: u64) -> u64 {
    HEADER_LEN + logical
}

/// Bytes of unit `unit` in a file of `size` logical bytes.
fn unit_len(unit: u64, size: u64) -> u64 {
    UNIT.min(size - unit * UNIT)
}

/// An open encrypted file: its unit cipher and physical storage.
pub struct EncryptedFile<'a, S: Storage> {
    pub cipher: &'a UnitCipher,
    pub storage: &'a S,
}

impl<S: Storage> EncryptedFile<'_, S> {
    pub fn size(&self) -> FileResult<u64, S::Error> {
        Ok(logical_size(self.storage.size()?))
    }

    /// Read up to `len` bytes at `offset`. Returns the data and whether it
    /// reaches the end of the file.
    pub fn read(&self, len: u64, offset: u64) -> FileResult<(Vec<u8>, bool), S::Error> {
        let size = self.size()?;
        if offset >= size || len == 0 {
            return Ok((Vec::new(), offset >= size));
        }
        let end = offset.saturating_add(len).min(size);
        let first = offset / UNIT;
        let plain = self.read_units(first, (end - 1) / UNIT, size)?;
        let start = (offset - first * UNIT) as usize;
        let data = plain[start..start + (end - offset) as usize].to_vec();
        Ok((data, end == size))
    }

    /// Write `data` at `offset`, extending the file as needed.
    pub fn write(&self, offset: u64, data: &[u8]) -> FileResult<(), S::Error> {
        let mut size = self.size()?;
        offset
            .checked_add(data.len() as u64)
            .filter(|&end| end <= MAX_SIZE)
            .ok_or(FileError::TooLarge)?;
        if offset.saturating_sub(size) > MAX_GAP {
            return Err(FileError::TooLarge);
        }
        while size < offset {
            let fill = (offset - size).min(FILL_CHUNK);
            self.write_within(size, &vec![0; fill as usize], size)?;
            size += fill;
        }
        self.write_within(offset, data, size)
    }

    /// Set the logical size, zero-filling when it grows.
    pub fn set_size(&self, new_size: u64) -> FileResult<(), S::Error> {
        let size = self.size()?;
        if new_size >= size {
            return self.write(new_size, &[]);
        }
        let (unit, keep) = (new_size / UNIT, new_size % UNIT);
        if keep > 0 {
            let mut tail = self.read_units(unit, unit, size)?;
            tail.truncate(keep as usize);
            self.cipher.encrypt(unit, &mut tail);
            self.storage.write_at(physical_offset(unit * UNIT), &tail)?;
        }
        self.storage.set_len(physical_offset(new_size))?;
        Ok(())
    }

    /// Decrypt units `first..=last` of a file of `size` logical bytes with one
    /// physical read.
    fn read_units(&self, first: u64, last: u64, size: u64) -> FileResult<Vec<u8>, S::Error> {
        let start = first * UNIT;
        let end = last * UNIT + unit_len(last, size);
        let mut buf = self.storage.read_at(physical_offset(start), end - start)?;
        if buf.len() as u64 != end - start {
            return Err(FileError::Truncated);
        }
        for (unit, chunk) in (first..).zip(buf.chunks_mut(UNIT as usize)) {
            self.cipher.decrypt(unit, chunk);
        }
        Ok(buf)
    }

    /// Write `data` at `offset <= size` as one physical write, merging the
    /// existing plaintext of a partially covered first or last unit.
    fn write_within(&self, offset: u64, data: &[u8], size: u64) -> FileResult<(), S::Error> {
        debug_assert!(offset <= size);
        if data.is_empty() {
            return Ok(());
        }
        // `write` checked that `end` is at most MAX_SIZE.
        let end = offset + data.len() as u64;
        let new_size = size.max(end);
        let (first, last) = (offset / UNIT, (end - 1) / UNIT);
        let span_start = first * UNIT;
        let span_end = last * UNIT + unit_len(last, new_size);
        let mut plain = vec![0u8; (span_end - span_start) as usize];
        // Only the first and last unit can be partially covered; keep their old bytes.
        let edges = if first == last {
            &[first][..]
        } else {
            &[first, last][..]
        };
        for &unit in edges {
            let unit_start = unit * UNIT;
            let old_len = if unit_start < size {
                unit_len(unit, size)
            } else {
                0
            };
            let covered = offset <= unit_start && end >= unit_start + old_len;
            if old_len > 0 && !covered {
                let old = self.read_units(unit, unit, size)?;
                let at = (unit_start - span_start) as usize;
                plain[at..at + old.len()].copy_from_slice(&old);
            }
        }
        let at = (offset - span_start) as usize;
        plain[at..at + data.len()].copy_from_slice(data);
        for (unit, chunk) in (first..).zip(plain.chunks_mut(UNIT as usize)) {
            self.cipher.encrypt(unit, chunk);
        }
        self.storage.write_at(physical_offset(span_start), &plain)?;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;

    /// In-memory physical file.
    #[derive(Default)]
    pub struct Memory(pub RefCell<Vec<u8>>);

    impl Storage for Memory {
        type Error = ();
        fn size(&self) -> Result<u64, ()> {
            Ok(self.0.borrow().len() as u64)
        }
        fn read_at(&self, offset: u64, len: u64) -> Result<Vec<u8>, ()> {
            let bytes = self.0.borrow();
            let start = (offset as usize).min(bytes.len());
            let end = (offset + len).min(bytes.len() as u64) as usize;
            Ok(bytes[start..end].to_vec())
        }
        fn write_at(&self, offset: u64, data: &[u8]) -> Result<(), ()> {
            let mut bytes = self.0.borrow_mut();
            let end = offset as usize + data.len();
            if bytes.len() < end {
                bytes.resize(end, 0);
            }
            bytes[offset as usize..end].copy_from_slice(data);
            Ok(())
        }
        fn set_len(&self, len: u64) -> Result<(), ()> {
            self.0.borrow_mut().resize(len as usize, 0);
            Ok(())
        }
    }

    fn cipher() -> UnitCipher {
        UnitCipher::new(&core::array::from_fn(|i| i as u8 ^ 0x5A))
    }

    /// A file whose header has been written (content irrelevant here).
    fn with_header() -> Memory {
        Memory(RefCell::new(vec![0xEE; HEADER_LEN as usize]))
    }

    fn read_all<S: Storage>(file: &EncryptedFile<S>) -> Vec<u8>
    where
        S::Error: std::fmt::Debug,
    {
        let size = file.size().unwrap();
        let (data, eof) = file.read(size + 10, 0).unwrap();
        assert!(eof);
        data
    }

    /// Small deterministic generator for the model test.
    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[test]
    fn logical_size_hides_the_header() {
        assert_eq!(logical_size(0), 0);
        assert_eq!(logical_size(100), 0, "a header cut short holds no data");
        assert_eq!(logical_size(HEADER_LEN), 0);
        assert_eq!(logical_size(HEADER_LEN + 8192), 8192);
    }

    #[test]
    fn length_preserving_and_not_plaintext() {
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        let data = b"ZEBRA-SECRET".repeat(1000);
        file.write(0, &data).unwrap();
        assert_eq!(m.0.borrow().len() as u64, HEADER_LEN + data.len() as u64);
        assert_eq!(file.size().unwrap(), data.len() as u64);
        let disk = m.0.borrow();
        assert!(!disk.windows(12).any(|w| w == b"ZEBRA-SECRET"));
        drop(disk);
        assert_eq!(read_all(&file), data);
    }

    #[test]
    fn reads_report_eof_and_clamp_to_size() {
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        assert_eq!(file.read(10, 0).unwrap(), (vec![], true));
        file.write(0, b"hello world").unwrap();
        assert_eq!(file.read(5, 0).unwrap(), (b"hello".to_vec(), false));
        assert_eq!(file.read(100, 6).unwrap(), (b"world".to_vec(), true));
        assert_eq!(file.read(0, 3).unwrap(), (vec![], false));
        assert_eq!(file.read(1, 11).unwrap(), (vec![], true));
        assert_eq!(file.read(u64::MAX, 6).unwrap(), (b"world".to_vec(), true));
    }

    #[test]
    fn tiny_files_round_trip() {
        // PG_VERSION is "17\n": shorter than one AES block.
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        file.write(0, b"17\n").unwrap();
        assert_eq!(m.0.borrow().len() as u64, HEADER_LEN + 3);
        assert_ne!(&m.0.borrow()[HEADER_LEN as usize..], b"17\n");
        assert_eq!(read_all(&file), b"17\n");
    }

    #[test]
    fn writing_past_the_end_zero_fills_the_gap() {
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        file.write(0, b"head").unwrap();
        let offset = 3 * FILL_CHUNK + 100;
        file.write(offset, b"tail").unwrap();
        let data = read_all(&file);
        assert_eq!(data.len() as u64, offset + 4);
        assert_eq!(&data[..4], b"head");
        assert!(data[4..offset as usize].iter().all(|&b| b == 0));
        assert_eq!(&data[offset as usize..], b"tail");
    }

    #[test]
    fn set_size_grows_with_zeros_and_shrinks_to_partial_units() {
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8 + 1).collect();
        file.write(0, &data).unwrap();
        file.set_size(5000).unwrap();
        assert_eq!(file.size().unwrap(), 5000);
        assert_eq!(m.0.borrow().len() as u64, HEADER_LEN + 5000);
        assert_eq!(read_all(&file), &data[..5000]);
        file.set_size(9000).unwrap();
        let grown = read_all(&file);
        assert_eq!(&grown[..5000], &data[..5000]);
        assert!(
            grown[5000..].iter().all(|&b| b == 0),
            "no stale bytes resurface"
        );
        file.set_size(4096).unwrap();
        assert_eq!(read_all(&file), &data[..4096]);
        file.set_size(0).unwrap();
        assert_eq!(
            m.0.borrow().len() as u64,
            HEADER_LEN,
            "truncate keeps the header"
        );
        file.set_size(0).unwrap();
        assert_eq!(read_all(&file), Vec::<u8>::new());
    }

    #[test]
    fn whole_unit_overwrites_skip_the_read() {
        // A page write covering whole units must not depend on the old contents
        // (full_page_writes restores pages without reading them).
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        file.write(0, &[1; 8192]).unwrap();
        // Corrupt the old ciphertext; an aligned 8 KiB rewrite must still succeed exactly.
        m.0.borrow_mut()[HEADER_LEN as usize..].fill(0x77);
        file.write(0, &[2; 8192]).unwrap();
        assert_eq!(read_all(&file), vec![2; 8192]);
    }

    #[test]
    fn a_truncated_physical_file_is_an_error_not_short_data() {
        struct Lying(Memory);
        impl Storage for Lying {
            type Error = ();
            fn size(&self) -> Result<u64, ()> {
                Ok(self.0.size()? + 4096)
            }
            fn read_at(&self, o: u64, l: u64) -> Result<Vec<u8>, ()> {
                self.0.read_at(o, l)
            }
            fn write_at(&self, o: u64, d: &[u8]) -> Result<(), ()> {
                self.0.write_at(o, d)
            }
            fn set_len(&self, l: u64) -> Result<(), ()> {
                self.0.set_len(l)
            }
        }
        let (c, m) = (cipher(), Lying(with_header()));
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        assert_eq!(file.read(10, 0).unwrap_err(), FileError::Truncated);
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
                unreachable!()
            }
            fn write_at(&self, _: u64, _: &[u8]) -> Result<(), &'static str> {
                unreachable!()
            }
            fn set_len(&self, _: u64) -> Result<(), &'static str> {
                unreachable!()
            }
        }
        let c = cipher();
        let file = EncryptedFile {
            cipher: &c,
            storage: &Broken,
        };
        assert_eq!(
            file.write(0, b"x").unwrap_err(),
            FileError::Storage("stat failed")
        );
    }

    #[test]
    fn absurd_offsets_fail_instead_of_filling_terabytes() {
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        assert_eq!(file.write(u64::MAX, b"x").unwrap_err(), FileError::TooLarge);
        assert_eq!(file.write(MAX_SIZE, b"x").unwrap_err(), FileError::TooLarge);
        assert_eq!(
            file.write(MAX_GAP + 1, b"x").unwrap_err(),
            FileError::TooLarge
        );
        assert_eq!(file.set_size(MAX_GAP + 1).unwrap_err(), FileError::TooLarge);
        assert_eq!(m.0.borrow().len() as u64, HEADER_LEN, "nothing was written");
        file.write(10, b"x").unwrap();
        assert_eq!(file.size().unwrap(), 11);
    }

    /// Storage that loses the effect of a crash: `set_len` never happens, and
    /// bytes written past the current end never reach the disk.
    struct Crashing(Memory);
    impl Storage for Crashing {
        type Error = ();
        fn size(&self) -> Result<u64, ()> {
            self.0.size()
        }
        fn read_at(&self, o: u64, l: u64) -> Result<Vec<u8>, ()> {
            self.0.read_at(o, l)
        }
        fn write_at(&self, o: u64, d: &[u8]) -> Result<(), ()> {
            let len = self.0.size()?;
            let keep = len.saturating_sub(o).min(d.len() as u64) as usize;
            self.0.write_at(o, &d[..keep])
        }
        fn set_len(&self, _: u64) -> Result<(), ()> {
            Err(())
        }
    }

    /// Bytes of `durable` that read back differently after a simulated crash.
    fn damage(storage: &Memory, durable: &[u8]) -> Vec<usize> {
        let c = cipher();
        let file = EncryptedFile {
            cipher: &c,
            storage,
        };
        let (now, _) = file.read(durable.len() as u64, 0).unwrap();
        (0..durable.len())
            .filter(|&i| now[i] != durable[i])
            .collect()
    }

    fn assert_bounded(damaged: &[usize], durable_len: usize, aligned: bool, case: &str) {
        if aligned {
            assert!(
                damaged.is_empty(),
                "{case}: aligned lengths must not lose bytes: {damaged:?}"
            );
        }
        let floor = (durable_len / 16 * 16).saturating_sub(16);
        assert!(
            damaged.len() <= 31,
            "{case}: {} bytes damaged",
            damaged.len()
        );
        assert!(
            damaged.iter().all(|&i| i >= floor),
            "{case}: damage before {floor}: {damaged:?}"
        );
    }

    #[test]
    fn unaligned_resizes_bound_crash_damage() {
        // W2 of the #201 review: XTS keeps torn writes plaintext-like only for whole
        // 16-byte blocks. Changing the length of a unit that ends mid-block
        // re-encrypts its last full block and the partial one, so a crash between
        // that rewrite and the size change garbles at most 31 bytes just before the
        // durable end; aligned lengths lose nothing.
        let c = cipher();
        let data: Vec<u8> = (0..3 * UNIT as usize)
            .map(|i| (i * 7 % 251) as u8 + 1)
            .collect();
        let lengths = [
            5,
            16,
            17,
            31,
            32,
            4000,
            4001,
            4095,
            4096,
            4096 + 17,
            8192 + 33,
        ];
        for &old in &lengths {
            for &new in &lengths {
                let setup = |len: usize| {
                    let m = with_header();
                    EncryptedFile {
                        cipher: &c,
                        storage: &m,
                    }
                    .write(0, &data[..len])
                    .unwrap();
                    Crashing(m)
                };
                let aligned = old % 16 == 0 && new % 16 == 0;
                if new < old {
                    // Shrink: the tail unit is rewritten, then the crash skips set_len.
                    let s = setup(old);
                    let crashed = EncryptedFile {
                        cipher: &c,
                        storage: &s,
                    }
                    .set_size(new as u64);
                    assert!(crashed.is_err());
                    let case = format!("shrink {old}->{new}");
                    assert_bounded(&damage(&s.0, &data[..new]), new, aligned, &case);
                } else if new > old {
                    // Append: the new ciphertext lands, the size never grows.
                    let s = setup(old);
                    EncryptedFile {
                        cipher: &c,
                        storage: &s,
                    }
                    .write(old as u64, &data[old..new])
                    .unwrap();
                    let case = format!("append {old}->{new}");
                    assert_bounded(&damage(&s.0, &data[..old]), old, aligned, &case);
                }
            }
        }
    }

    #[test]
    fn the_review_reproduction_damages_17_bytes() {
        // set_size(4001) on a 4096-byte file, crash before set_len: bytes 3984..=4000.
        let c = cipher();
        let data: Vec<u8> = (0..4096usize).map(|i| (i % 251) as u8 + 1).collect();
        let m = with_header();
        EncryptedFile {
            cipher: &c,
            storage: &m,
        }
        .write(0, &data)
        .unwrap();
        let s = Crashing(m);
        assert!(EncryptedFile {
            cipher: &c,
            storage: &s
        }
        .set_size(4001)
        .is_err());
        assert_eq!(
            damage(&s.0, &data[..4001]),
            (3984..=4000).collect::<Vec<_>>()
        );
    }

    #[test]
    fn matches_a_plaintext_model_under_random_operations() {
        let (c, m) = (cipher(), with_header());
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        let mut model: Vec<u8> = Vec::new();
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        for step in 0..600 {
            match rng.below(10) {
                0..=5 => {
                    let offset = rng.below(model.len() as u64 + 3 * UNIT);
                    let len = 1 + rng.below(3 * UNIT);
                    let data: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
                    file.write(offset, &data).unwrap();
                    let end = (offset + len) as usize;
                    if model.len() < end {
                        model.resize(end, 0);
                    }
                    model[offset as usize..end].copy_from_slice(&data);
                }
                6 | 7 => {
                    let size = rng.below(model.len() as u64 + 2 * UNIT);
                    file.set_size(size).unwrap();
                    model.resize(size as usize, 0);
                }
                _ => {
                    let offset = rng.below(model.len() as u64 + 10);
                    let len = rng.below(2 * UNIT + 10);
                    let (data, eof) = file.read(len, offset).unwrap();
                    let start = (offset as usize).min(model.len());
                    let end = (offset + len).min(model.len() as u64) as usize;
                    let expected = if start < end {
                        &model[start..end]
                    } else {
                        &[][..]
                    };
                    assert_eq!(data, expected, "step {step}");
                    assert_eq!(eof, offset + len >= model.len() as u64, "step {step}");
                }
            }
            assert_eq!(file.size().unwrap(), model.len() as u64, "step {step}");
            assert_eq!(
                m.0.borrow().len(),
                HEADER_LEN as usize + model.len(),
                "step {step}"
            );
        }
        assert_eq!(read_all(&file), model);
    }
}
