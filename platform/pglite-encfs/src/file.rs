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
//!   granularity. At a final partial block it depends on the file's codec
//!   (see `codec`):
//!   - Codec 3 (new files): the ciphertext of complete blocks and of the bytes
//!     already in a partial block does not depend on the unit's length. A
//!     shrink or an append that stays inside one block, or starts or ends on a
//!     block boundary, rewrites no durable byte differently. Only a resize that
//!     completes a partial block (append) or splits a complete one (shrink)
//!     re-encrypts that block's durable partial bytes, so a crash between that
//!     write and the size change garbles at most 15 bytes just before the
//!     durable end of file.
//!   - Codec 2 (files created by v1): changing the length of a unit that ends
//!     mid-block re-encrypts its last full block and the partial block
//!     (ciphertext stealing, or the sub-block mask), so a crash can garble up
//!     to 31 durable bytes.
//!
//!   Both bounds are pinned by `unaligned_resizes_bound_crash_damage` (#206).
//!   Relation and WAL I/O is in whole 8 KiB pages and never hits either.
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
    use crate::codec::Codec;
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

    fn cipher_with(codec: Codec) -> UnitCipher {
        UnitCipher::new(codec, &core::array::from_fn(|i| i as u8 ^ 0x5A))
    }

    fn cipher() -> UnitCipher {
        cipher_with(Codec::NEW_FILES)
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
    fn damage(codec: Codec, storage: &Memory, durable: &[u8]) -> Vec<usize> {
        let c = cipher_with(codec);
        let file = EncryptedFile {
            cipher: &c,
            storage,
        };
        let (now, _) = file.read(durable.len() as u64, 0).unwrap();
        (0..durable.len())
            .filter(|&i| now[i] != durable[i])
            .collect()
    }

    /// Simulate a crash in the middle of resizing a file from `old` to `new`
    /// bytes of `data`, and return the durable bytes it garbled.
    fn crash_resize(codec: Codec, data: &[u8], old: usize, new: usize) -> Vec<usize> {
        let c = cipher_with(codec);
        let m = with_header();
        EncryptedFile {
            cipher: &c,
            storage: &m,
        }
        .write(0, &data[..old])
        .unwrap();
        let s = Crashing(m);
        let file = EncryptedFile {
            cipher: &c,
            storage: &s,
        };
        if new < old {
            // Shrink: the tail unit is rewritten, then the crash skips set_len.
            assert!(file.set_size(new as u64).is_err());
            damage(codec, &s.0, &data[..new])
        } else {
            // Append: the new ciphertext lands, the size never grows.
            file.write(old as u64, &data[old..new]).unwrap();
            damage(codec, &s.0, &data[..old])
        }
    }

    /// Lengths around block and unit edges, including several inside the
    /// block 4000..4016.
    const RESIZE_LENGTHS: [usize; 17] = [
        5,
        15,
        16,
        17,
        20,
        31,
        32,
        4000,
        4001,
        4005,
        4015,
        4095,
        4096,
        4096 + 1,
        4096 + 17,
        8192 + 33,
        8192 + 40,
    ];

    fn resize_data() -> Vec<u8> {
        (0..3 * UNIT as usize)
            .map(|i| (i * 7 % 251) as u8 + 1)
            .collect()
    }

    #[test]
    fn unaligned_resizes_bound_crash_damage() {
        // W2 of the #201 review, fixed by codec 3 (#206). Complete blocks never
        // change their ciphertext with the length, and a partial block's bytes
        // are a prefix of a length-independent keystream. A crash between the
        // tail rewrite and the size change therefore loses nothing for a shrink
        // or append inside one block (or on a block boundary). Only completing
        // a partial block (append) or splitting a complete one (shrink)
        // re-encrypts that block's durable partial bytes: at most 15, all in
        // the block that holds the durable end.
        let data = resize_data();
        let mut bounded = 0;
        for &old in &RESIZE_LENGTHS {
            for &new in &RESIZE_LENGTHS {
                if new == old {
                    continue;
                }
                let damaged = crash_resize(Codec::XtsTail, &data, old, new);
                let (case, durable) = if new < old {
                    (format!("shrink {old}->{new}"), new)
                } else {
                    (format!("append {old}->{new}"), old)
                };
                let same_block = old / 16 == new / 16;
                if durable % 16 == 0 || same_block {
                    assert!(damaged.is_empty(), "{case}: lost {damaged:?}");
                } else {
                    bounded += 1;
                    let floor = durable / 16 * 16;
                    assert!(damaged.len() <= 15, "{case}: lost {damaged:?}");
                    assert!(
                        damaged.iter().all(|&i| (floor..durable).contains(&i)),
                        "{case}: damage outside {floor}..{durable}: {damaged:?}"
                    );
                }
            }
        }
        assert!(
            bounded > 0,
            "the completing and splitting cases are covered"
        );
    }

    #[test]
    fn codec_2_files_keep_their_31_byte_bound() {
        // Files created by v1 keep codec 2, and with it the old bound: changing
        // the length of a unit that ends mid-block re-encrypts its last full
        // block and the partial one; aligned lengths lose nothing.
        let data = resize_data();
        for &old in &RESIZE_LENGTHS {
            for &new in &RESIZE_LENGTHS {
                if new == old {
                    continue;
                }
                let damaged = crash_resize(Codec::XtsStealing, &data, old, new);
                let durable = old.min(new);
                let case = format!("{old}->{new}");
                if old % 16 == 0 && new % 16 == 0 {
                    assert!(damaged.is_empty(), "{case}: lost {damaged:?}");
                }
                let floor = (durable / 16 * 16).saturating_sub(16);
                assert!(damaged.len() <= 31, "{case}: lost {damaged:?}");
                assert!(
                    damaged.iter().all(|&i| i >= floor),
                    "{case}: damage before {floor}: {damaged:?}"
                );
            }
        }
    }

    #[test]
    fn the_review_reproduction() {
        // set_size(4001) on a 4096-byte file, crash before set_len. Codec 2
        // garbles bytes 3984..=4000; codec 3 can only touch byte 4000, the one
        // durable byte of the block that the shrink splits.
        let data: Vec<u8> = (0..4096usize).map(|i| (i % 251) as u8 + 1).collect();
        assert_eq!(
            crash_resize(Codec::XtsStealing, &data, 4096, 4001),
            (3984..=4000).collect::<Vec<_>>()
        );
        assert!(crash_resize(Codec::XtsTail, &data, 4096, 4001)
            .iter()
            .all(|&i| i == 4000));
        // Appending 1 byte to a 4000-byte file: codec 2 garbles 3984..3999,
        // codec 3 loses nothing.
        assert_eq!(
            crash_resize(Codec::XtsStealing, &data, 4000, 4001),
            (3984..4000).collect::<Vec<_>>()
        );
        assert!(crash_resize(Codec::XtsTail, &data, 4000, 4001).is_empty());
        // Inside one block: codec 2 still loses bytes, codec 3 nothing.
        assert!(!crash_resize(Codec::XtsStealing, &data, 4001, 4002).is_empty());
        assert!(crash_resize(Codec::XtsTail, &data, 4001, 4002).is_empty());
        assert!(crash_resize(Codec::XtsTail, &data, 4005, 4001).is_empty());
    }

    #[test]
    fn codec_3_round_trips_at_block_and_unit_edges() {
        for len in [0usize, 1, 15, 16, 17, 31, 4095, 4096, 4097] {
            let (c, m) = (cipher(), with_header());
            let file = EncryptedFile {
                cipher: &c,
                storage: &m,
            };
            let data: Vec<u8> = (0..len).map(|i| (i * 13 % 251) as u8 + 1).collect();
            file.write(0, &data).unwrap();
            assert_eq!(m.0.borrow().len(), HEADER_LEN as usize + len, "len {len}");
            assert_eq!(read_all(&file), data, "len {len}");
            if len >= 4 {
                assert!(
                    !m.0.borrow().windows(4).any(|w| w == &data[..4]),
                    "len {len} is not plaintext on disk"
                );
            }
            // Growing the file by small appends never changes the ciphertext
            // already on disk, except for the durable bytes of a partial block
            // that the append completes.
            let (c2, m2) = (cipher(), with_header());
            let grown = EncryptedFile {
                cipher: &c2,
                storage: &m2,
            };
            let mut at = 0;
            for step in [1usize, 7, 16, 3, 13, 30].iter().cycle() {
                if at == len {
                    break;
                }
                let end = (at + step).min(len);
                let before = m2.0.borrow().clone();
                grown.write(at as u64, &data[at..end]).unwrap();
                let block = at / 16 * 16;
                let stable = if at / 16 == end / 16 { at } else { block };
                let h = HEADER_LEN as usize;
                assert_eq!(
                    m2.0.borrow()[h..h + stable],
                    before[h..h + stable],
                    "len {len}: append {at}..{end}"
                );
                at = end;
            }
            assert_eq!(*m2.0.borrow(), *m.0.borrow(), "len {len}");
        }
    }

    /// Fixtures written by the v1 (codec 2) build before #206, see
    /// `testdata/codec2`: master key `[0x11; 32]`, DEK byte i = 3i + 1,
    /// plaintext byte i = (13i + 5) % 251, one `write(0, ..)` per length.
    const CODEC2_FIXTURES: [(usize, &[u8]); 11] = [
        (0, include_bytes!("testdata/codec2/len-0.bin")),
        (3, include_bytes!("testdata/codec2/len-3.bin")),
        (15, include_bytes!("testdata/codec2/len-15.bin")),
        (16, include_bytes!("testdata/codec2/len-16.bin")),
        (17, include_bytes!("testdata/codec2/len-17.bin")),
        (31, include_bytes!("testdata/codec2/len-31.bin")),
        (4001, include_bytes!("testdata/codec2/len-4001.bin")),
        (4095, include_bytes!("testdata/codec2/len-4095.bin")),
        (4096, include_bytes!("testdata/codec2/len-4096.bin")),
        (4097, include_bytes!("testdata/codec2/len-4097.bin")),
        (8225, include_bytes!("testdata/codec2/len-8225.bin")),
    ];

    fn fixture_plain(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 13 + 5) % 251) as u8).collect()
    }

    /// Open a fixture as the component does: parse the header, unwrap the DEK
    /// and pick the cipher for the header's codec.
    fn open_fixture(bytes: &[u8]) -> (crate::header::Header, UnitCipher) {
        use crate::header::{classify, HeaderState};
        let kek = crate::keys::Kek::derive(&[0x11; 32]);
        let header = match classify(bytes, bytes.len() as u64).unwrap() {
            HeaderState::Sealed(header) => header,
            HeaderState::Fresh => panic!("fixture has a header"),
        };
        let dek = header.open(&kek).unwrap();
        let expected: [u8; 64] =
            core::array::from_fn(|i| (i as u8).wrapping_mul(3).wrapping_add(1));
        assert_eq!(*dek, expected);
        let cipher = UnitCipher::new(header.codec(), &dek);
        (header, cipher)
    }

    #[test]
    fn codec_2_fixtures_from_v1_still_read() {
        for (len, bytes) in CODEC2_FIXTURES {
            assert_eq!(bytes.len(), HEADER_LEN as usize + len);
            let (header, c) = open_fixture(bytes);
            assert_eq!(header.codec(), Codec::XtsStealing, "len {len}");
            let m = Memory(RefCell::new(bytes.to_vec()));
            let file = EncryptedFile {
                cipher: &c,
                storage: &m,
            };
            assert_eq!(read_all(&file), fixture_plain(len), "len {len}");
            // The codec-2 writer is unchanged: rewriting the same plaintext
            // reproduces the v1 bytes exactly.
            file.write(0, &fixture_plain(len)).unwrap();
            assert_eq!(&m.0.borrow()[..], bytes, "len {len}");
        }
    }

    #[test]
    fn codec_2_files_stay_codec_2_when_written() {
        // A file keeps its codec for life: appends, overwrites and shrinks of
        // a v1 file keep codec 2 and its header, and stay readable.
        let (_, bytes) = CODEC2_FIXTURES[6];
        let (header, c) = open_fixture(bytes);
        let m = Memory(RefCell::new(bytes.to_vec()));
        let file = EncryptedFile {
            cipher: &c,
            storage: &m,
        };
        let mut model = fixture_plain(4001);
        file.write(4001, b"appended").unwrap();
        model.extend_from_slice(b"appended");
        file.write(10, b"overwrite").unwrap();
        model[10..19].copy_from_slice(b"overwrite");
        file.set_size(4003).unwrap();
        model.truncate(4003);
        assert_eq!(read_all(&file), model);
        assert_eq!(
            &m.0.borrow()[..HEADER_LEN as usize],
            &bytes[..HEADER_LEN as usize]
        );
        // Same bytes as a fresh codec-2 file with that content.
        let fresh = Memory(RefCell::new(bytes[..HEADER_LEN as usize].to_vec()));
        EncryptedFile {
            cipher: &c,
            storage: &fresh,
        }
        .write(0, &model)
        .unwrap();
        assert_eq!(*fresh.0.borrow(), *m.0.borrow());
        // Decoding it as codec 3 would garble the stolen tail: the codec matters.
        let dek = header.open(&crate::keys::Kek::derive(&[0x11; 32])).unwrap();
        let wrong = UnitCipher::new(Codec::XtsTail, &dek);
        let misread = read_all(&EncryptedFile {
            cipher: &wrong,
            storage: &m,
        });
        assert_eq!(misread[..3984], model[..3984]);
        assert_ne!(misread[3984..], model[3984..]);
    }

    #[test]
    fn matches_a_plaintext_model_under_random_operations() {
        for codec in [Codec::XtsStealing, Codec::XtsTail] {
            random_operations_match_the_model(codec);
        }
    }

    fn random_operations_match_the_model(codec: Codec) {
        let (c, m) = (cipher_with(codec), with_header());
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
