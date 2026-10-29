//! The per-file header: a random data-encryption key (DEK) wrapped by the KEK.
//!
//! Every non-empty regular file starts with a [`HEADER_LEN`]-byte header; data
//! units follow at [`HEADER_LEN`], so they stay aligned to host pages. Only the
//! first [`HEADER_USED`] bytes carry data, the rest is zero:
//!
//! | bytes    | field                                      |
//! |----------|--------------------------------------------|
//! | 0..8     | magic `DIPGENC1`                           |
//! | 8        | format version (1)                         |
//! | 9        | codec (2, 3 or 4, see below)               |
//! | 10..16   | reserved, zero                             |
//! | 16..32   | file id (random)                           |
//! | 32..48   | key-check value of the wrapping key        |
//! | 48..72   | wrap nonce (XChaCha20)                     |
//! | 72..136  | wrapped 64-byte DEK                        |
//! | 136..152 | wrap tag (Poly1305); AAD = bytes 0..32     |
//!
//! Codec ids ([`Codec`]): 2 is AES-256-XTS with ciphertext stealing (v1),
//! 3 is AES-256-XTS with a length-independent tail keystream (#206), 4 is the
//! two-slot AEAD of integrity directories (#200, [`crate::slots`]; this build
//! reads it but never creates it). New files get [`Codec::NEW_FILES`]. A file
//! keeps the codec it was created with for its whole lifetime: the header is
//! never rewritten except for its wrap, and the codec byte is part of the AAD,
//! so it cannot be changed without the key. Codec 1 was the AEAD prototype of
//! the #199 spike and is not accepted.
//!
//! The DEK is random per file rather than derived from the path, so renames
//! keep working and a copied file gets a fresh key. The header is written once
//! and never removed (truncating to zero keeps it), so the file id is fixed
//! for the inode's lifetime. Rotation rewrites only the wrap (bytes 32..152).

use chacha20poly1305::aead::AeadInPlace;
use chacha20poly1305::{Tag, XNonce};
use zeroize::Zeroizing;

use crate::codec::Codec;
use crate::keys::{Kek, KCV_LEN};
use crate::marker::Mode;

/// Physical offset of the first data unit.
pub const HEADER_LEN: u64 = 4096;
/// Bytes of the header that carry data.
pub const HEADER_USED: usize = 152;
pub const MAGIC: &[u8; 8] = b"DIPGENC1";
pub const FORMAT_VERSION: u8 = 1;
/// Two AES-256 keys for XTS.
pub const DEK_LEN: usize = 64;
pub const NONCE_LEN: usize = 24;

pub type FileId = [u8; 16];
pub type Dek = Zeroizing<[u8; DEK_LEN]>;

const VERSION_AT: usize = 8;
const CODEC_AT: usize = 9;
const FILE_ID: std::ops::Range<usize> = 16..32;
const AAD: std::ops::Range<usize> = 0..32;
const KCV: std::ops::Range<usize> = 32..32 + KCV_LEN;
const NONCE: std::ops::Range<usize> = 48..72;
const WRAPPED: std::ops::Range<usize> = 72..136;
const TAG: std::ops::Range<usize> = 136..152;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeaderError {
    /// No magic: a plaintext or foreign file, or a header cut short.
    NotEncrypted,
    /// No magic in a file no longer than a header whose start is not all
    /// zero: a small plaintext file, or a stub left by a failed header write
    /// (`ENOSPC`, or a crash under ext4 `data=writeback` that made the size
    /// durable but not the bytes). Either way it holds no encrypted data,
    /// since data only ever follows a synced header (#207).
    Stub,
    /// A format version or codec this build does not read.
    Unsupported { version: u8, codec: u8 },
    /// Wrapped under a key whose KCV is not the one offered.
    WrongKey,
    /// The KCV matched but the wrap did not authenticate.
    Tampered,
}

/// What the start of a regular file holds.
#[derive(Debug, PartialEq, Eq)]
pub enum HeaderState {
    /// No data can be in the file yet: it is empty, or a crash while it was
    /// being created left its size durable but not its header, so the file is
    /// no longer than a header and its start (short or full) is all zero. A
    /// fresh header is sealed on the first write.
    Fresh,
    Sealed(Header),
}

/// Classify a regular file of an XTS directory; see [`classify_in`].
pub fn classify(start: &[u8], physical: u64) -> Result<HeaderState, HeaderError> {
    classify_in(start, physical, Mode::Xts)
}

/// Classify a regular file of `physical` bytes whose first bytes are `start`
/// (up to [`HEADER_USED`] of them), in a directory of `mode`.
///
/// Anything else without a valid header is refused: a zero header on a file
/// longer than [`HEADER_LEN`] (it may hold data; the header is synced before
/// any data is written, so a crash cannot produce that state), and any
/// non-zero bytes that are not a header, however short (a plaintext file must
/// never be read as an empty encrypted one). Those short files are reported as
/// [`HeaderError::Stub`] so the operator learns they hold no encrypted data.
///
/// Only the first [`HEADER_USED`] bytes are inspected: a file of at most
/// [`Mode::data_start`] bytes ([`HEADER_LEN`] for XTS) whose first
/// [`HEADER_USED`] bytes are zero is fresh whatever the rest holds. In an
/// integrity directory data starts after the header page and the two
/// watermark pages, so the bound is 12288 there (#200 C8a).
pub fn classify_in(start: &[u8], physical: u64, mode: Mode) -> Result<HeaderState, HeaderError> {
    let start = &start[..start.len().min(HEADER_USED)];
    let no_room_for_data = physical <= mode.data_start();
    if no_room_for_data && start.iter().all(|&b| b == 0) {
        return Ok(HeaderState::Fresh);
    }
    match Header::parse(start) {
        Ok(header) => Ok(HeaderState::Sealed(header)),
        Err(HeaderError::NotEncrypted) if no_room_for_data => Err(HeaderError::Stub),
        Err(error) => Err(error),
    }
}

/// A parsed header (magic, version and codec already checked).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Header {
    bytes: [u8; HEADER_USED],
}

impl Header {
    /// Create a header for a new file, wrapping `dek` under `kek`.
    pub fn seal(
        kek: &Kek,
        codec: Codec,
        file_id: &FileId,
        dek: &[u8; DEK_LEN],
        nonce: &[u8; NONCE_LEN],
    ) -> Header {
        let mut bytes = [0u8; HEADER_USED];
        bytes[..MAGIC.len()].copy_from_slice(MAGIC);
        bytes[VERSION_AT] = FORMAT_VERSION;
        bytes[CODEC_AT] = codec.id();
        bytes[FILE_ID].copy_from_slice(file_id);
        let mut header = Header { bytes };
        header.wrap(kek, dek, nonce);
        header
    }

    /// Parse the first [`HEADER_USED`] bytes of a file.
    pub fn parse(bytes: &[u8]) -> Result<Header, HeaderError> {
        let bytes: [u8; HEADER_USED] = bytes
            .get(..HEADER_USED)
            .and_then(|b| b.try_into().ok())
            .ok_or(HeaderError::NotEncrypted)?;
        if &bytes[..MAGIC.len()] != MAGIC {
            return Err(HeaderError::NotEncrypted);
        }
        let (version, codec) = (bytes[VERSION_AT], bytes[CODEC_AT]);
        if version != FORMAT_VERSION || Codec::from_id(codec).is_none() {
            return Err(HeaderError::Unsupported { version, codec });
        }
        Ok(Header { bytes })
    }

    pub fn as_bytes(&self) -> &[u8; HEADER_USED] {
        &self.bytes
    }

    /// The codec of the file's data units (checked by [`Header::parse`]).
    pub fn codec(&self) -> Codec {
        Codec::from_id(self.bytes[CODEC_AT]).expect("parse and seal only accept known codecs")
    }

    pub fn file_id(&self) -> FileId {
        self.bytes[FILE_ID].try_into().expect("16-byte range")
    }

    /// KCV of the key the DEK is wrapped under.
    pub fn kcv(&self) -> &[u8] {
        &self.bytes[KCV]
    }

    /// Unwrap the DEK with `kek`.
    pub fn open(&self, kek: &Kek) -> Result<Dek, HeaderError> {
        if !kek.matches(self.kcv()) {
            return Err(HeaderError::WrongKey);
        }
        let mut dek = Zeroizing::new([0u8; DEK_LEN]);
        dek.copy_from_slice(&self.bytes[WRAPPED]);
        let nonce = XNonce::from_slice(&self.bytes[NONCE]);
        let tag = Tag::from_slice(&self.bytes[TAG]);
        kek.cipher()
            .decrypt_in_place_detached(nonce, &self.bytes[AAD], dek.as_mut(), tag)
            .map_err(|_| HeaderError::Tampered)?;
        Ok(dek)
    }

    /// Re-wrap the unchanged DEK from `from` to `to` (key rotation). The file
    /// id, codec and data units stay as they are.
    pub fn rewrap(
        &self,
        from: &Kek,
        to: &Kek,
        nonce: &[u8; NONCE_LEN],
    ) -> Result<Header, HeaderError> {
        let dek = self.open(from)?;
        let mut header = self.clone();
        header.wrap(to, &dek, nonce);
        Ok(header)
    }

    fn wrap(&mut self, kek: &Kek, dek: &[u8; DEK_LEN], nonce: &[u8; NONCE_LEN]) {
        self.bytes[KCV].copy_from_slice(kek.kcv());
        self.bytes[NONCE].copy_from_slice(nonce);
        let mut wrapped = Zeroizing::new(*dek);
        let (aad, rest) = self.bytes.split_at_mut(AAD.end);
        let tag = kek
            .cipher()
            .encrypt_in_place_detached(XNonce::from_slice(nonce), aad, wrapped.as_mut())
            .expect("XChaCha20-Poly1305 accepts a 64-byte message");
        rest[WRAPPED.start - AAD.end..WRAPPED.end - AAD.end].copy_from_slice(wrapped.as_ref());
        rest[TAG.start - AAD.end..TAG.end - AAD.end].copy_from_slice(&tag);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kek(byte: u8) -> Kek {
        Kek::derive(&[byte; 32])
    }

    fn dek() -> [u8; DEK_LEN] {
        core::array::from_fn(|i| i as u8)
    }

    fn sealed() -> Header {
        Header::seal(
            &kek(1),
            Codec::NEW_FILES,
            &[0xAB; 16],
            &dek(),
            &[3; NONCE_LEN],
        )
    }

    #[test]
    fn layout_matches_the_documented_offsets() {
        let header = sealed();
        let b = header.as_bytes();
        assert_eq!(&b[..8], b"DIPGENC1");
        assert_eq!((b[8], b[9]), (1, Codec::NEW_FILES.id()));
        assert_eq!(header.codec(), Codec::NEW_FILES);
        assert_eq!(&b[10..16], &[0; 6]);
        assert_eq!(&b[16..32], &[0xAB; 16]);
        assert_eq!(&b[32..48], kek(1).kcv());
        assert_eq!(&b[48..72], &[3; 24]);
        // The DEK is not stored in the clear.
        assert_ne!(&b[72..136], &dek()[..]);
        assert_eq!(header.file_id(), [0xAB; 16]);
    }

    #[test]
    fn round_trips_through_bytes() {
        let header = sealed();
        let parsed = Header::parse(header.as_bytes()).unwrap();
        assert_eq!(parsed, header);
        assert_eq!(parsed.open(&kek(1)).unwrap().as_slice(), &dek()[..]);
        // A full on-disk header (zero padded) parses the same.
        let mut block = vec![0u8; HEADER_LEN as usize];
        block[..HEADER_USED].copy_from_slice(header.as_bytes());
        assert_eq!(Header::parse(&block).unwrap(), header);
    }

    #[test]
    fn rejects_plaintext_short_and_unsupported_headers() {
        assert_eq!(
            Header::parse(b"17\n").unwrap_err(),
            HeaderError::NotEncrypted
        );
        assert_eq!(
            Header::parse(&[0; HEADER_USED]).unwrap_err(),
            HeaderError::NotEncrypted
        );
        let bytes = *sealed().as_bytes();
        assert_eq!(
            Header::parse(&bytes[..HEADER_USED - 1]).unwrap_err(),
            HeaderError::NotEncrypted
        );
        for codec in [0, 1, 5, 0xFF] {
            // 1 is the #199 spike's AEAD prototype; 5 and up are not defined.
            let mut other = bytes;
            other[9] = codec;
            assert_eq!(
                Header::parse(&other).unwrap_err(),
                HeaderError::Unsupported { version: 1, codec }
            );
        }
        let mut v2 = bytes;
        v2[8] = 2;
        assert_eq!(
            Header::parse(&v2).unwrap_err(),
            HeaderError::Unsupported {
                version: 2,
                codec: Codec::NEW_FILES.id()
            }
        );
    }

    #[test]
    fn every_codec_parses_and_keeps_its_id() {
        for codec in [Codec::XtsStealing, Codec::XtsTail, Codec::TwoSlotAead] {
            let header = Header::seal(&kek(1), codec, &[0xAB; 16], &dek(), &[3; NONCE_LEN]);
            assert_eq!(header.as_bytes()[9], codec.id());
            let parsed = Header::parse(header.as_bytes()).unwrap();
            assert_eq!(parsed.codec(), codec);
            // Rotation keeps the codec.
            let rotated = parsed.rewrap(&kek(1), &kek(2), &[4; NONCE_LEN]).unwrap();
            assert_eq!(rotated.codec(), codec);
        }
    }

    #[test]
    fn the_codec_byte_is_authenticated() {
        // Swapping codec 3 for 2 (or back) would decode the tail differently;
        // the codec is in the AAD, so the wrap no longer opens.
        let mut bytes = *sealed().as_bytes();
        bytes[9] = if Codec::NEW_FILES == Codec::XtsTail {
            Codec::XtsStealing.id()
        } else {
            Codec::XtsTail.id()
        };
        let header = Header::parse(&bytes).unwrap();
        assert_eq!(header.open(&kek(1)).unwrap_err(), HeaderError::Tampered);
    }

    #[test]
    fn short_or_zero_headers_without_room_for_data_are_fresh() {
        // A crash while creating a file: the size became durable, the header did not.
        for (start, physical) in [
            (&[][..], 0),
            (&[0u8; 40][..], 40),
            (&[0u8; HEADER_USED][..], HEADER_LEN),
            (&[0u8; HEADER_USED][..], 100),
            (&[0u8; 100][..], 100),
        ] {
            assert_eq!(
                classify(start, physical),
                Ok(HeaderState::Fresh),
                "{physical}"
            );
        }
        let sealed = sealed();
        assert_eq!(
            classify(sealed.as_bytes(), HEADER_LEN),
            Ok(HeaderState::Sealed(sealed.clone()))
        );
        assert_eq!(
            classify(sealed.as_bytes(), HEADER_LEN + 8192),
            Ok(HeaderState::Sealed(sealed))
        );
    }

    #[test]
    fn files_that_may_hold_data_still_need_a_header() {
        // Longer than a header: zero or plaintext starts are refused, never re-sealed.
        assert_eq!(
            classify(&[0u8; HEADER_USED], HEADER_LEN + 1),
            Err(HeaderError::NotEncrypted)
        );
        assert_eq!(
            classify(&[b'x'; HEADER_USED], HEADER_LEN + 8192),
            Err(HeaderError::NotEncrypted)
        );
        // Non-zero bytes that are not a header are refused at any size: a small
        // plaintext file must not be read as an empty encrypted one. Up to a
        // header's length they are reported as a stub (#207): no encrypted
        // data can be in them.
        assert_eq!(classify(&[b'x'; HEADER_USED], 200), Err(HeaderError::Stub));
        assert_eq!(
            classify(&[b'x'; HEADER_USED], HEADER_LEN),
            Err(HeaderError::Stub)
        );
        assert_eq!(classify(b"17\n", 3), Err(HeaderError::Stub));
        let mut half = [0u8; HEADER_USED];
        half[..8].copy_from_slice(MAGIC);
        assert_eq!(classify(&half[..20], 20), Err(HeaderError::Stub));
    }

    #[test]
    fn stubs_are_only_files_without_room_for_data() {
        // A partial header write (ENOSPC) or garbage behind a durable size
        // (ext4 data=writeback crash): no larger than a header, start not zero.
        let mut torn = [0u8; HEADER_USED];
        torn[..8].copy_from_slice(MAGIC);
        torn[8] = FORMAT_VERSION;
        for physical in [1, 8, HEADER_USED as u64, HEADER_LEN] {
            assert_eq!(
                classify(&torn[..(physical as usize).min(12)], physical),
                Err(HeaderError::Stub),
                "{physical}"
            );
        }
        // One byte longer may hold data: still refused, but not called a stub.
        assert_eq!(
            classify(&[b'x'; HEADER_USED], HEADER_LEN + 1),
            Err(HeaderError::NotEncrypted)
        );
        // A complete header in a short file is sealed, and an unsupported one
        // is reported as such, never as a stub.
        let sealed = sealed();
        assert_eq!(
            classify(sealed.as_bytes(), HEADER_USED as u64),
            Ok(HeaderState::Sealed(sealed.clone()))
        );
        let mut other = *sealed.as_bytes();
        other[9] = 0xFF;
        assert_eq!(
            classify(&other, HEADER_LEN),
            Err(HeaderError::Unsupported {
                version: FORMAT_VERSION,
                codec: 0xFF
            })
        );
        // The first HEADER_USED bytes decide: zero there means fresh, whatever
        // follows within the header (README "Header lifecycle").
        assert_eq!(
            classify(&[0u8; HEADER_USED], HEADER_LEN),
            Ok(HeaderState::Fresh)
        );
    }

    #[test]
    fn integrity_directories_have_room_for_the_watermark_pages() {
        // C8a: a zero start up to 12288 bytes is an interrupted birth in an
        // integrity directory, and may hold data in an XTS one.
        for physical in [HEADER_LEN + 1, 8192, 12288] {
            assert_eq!(
                classify_in(&[0u8; HEADER_USED], physical, Mode::Integrity),
                Ok(HeaderState::Fresh),
                "{physical}"
            );
            assert_eq!(
                classify_in(&[0u8; HEADER_USED], physical, Mode::Xts),
                Err(HeaderError::NotEncrypted),
                "{physical}"
            );
        }
        assert_eq!(
            classify_in(&[0u8; HEADER_USED], 12289, Mode::Integrity),
            Err(HeaderError::NotEncrypted)
        );
        assert_eq!(
            classify_in(&[b'x'; HEADER_USED], 12288, Mode::Integrity),
            Err(HeaderError::Stub)
        );
        let header = Header::seal(&kek(1), Codec::TwoSlotAead, &[1; 16], &dek(), &[3; 24]);
        assert_eq!(
            classify_in(header.as_bytes(), 12288 + 100, Mode::Integrity),
            Ok(HeaderState::Sealed(header))
        );
    }

    #[test]
    fn wrong_key_is_detected_before_decryption() {
        assert_eq!(sealed().open(&kek(2)).unwrap_err(), HeaderError::WrongKey);
    }

    #[test]
    fn any_change_to_the_authenticated_bytes_is_tampering() {
        let bytes = *sealed().as_bytes();
        // File id (AAD), nonce, wrapped DEK and tag; not the KCV (that is a key mismatch).
        for at in [16, 31, 48, 72, 135, 136, 151] {
            let mut tampered = bytes;
            tampered[at] ^= 1;
            let header = Header::parse(&tampered).unwrap();
            assert_eq!(
                header.open(&kek(1)).unwrap_err(),
                HeaderError::Tampered,
                "byte {at}"
            );
        }
    }

    #[test]
    fn rotation_rewraps_the_same_dek_under_the_new_key() {
        let old = sealed();
        let new = old.rewrap(&kek(1), &kek(2), &[4; NONCE_LEN]).unwrap();
        assert_eq!(new.file_id(), old.file_id());
        assert_eq!(new.kcv(), kek(2).kcv());
        assert_eq!(new.open(&kek(2)).unwrap().as_slice(), &dek()[..]);
        assert_eq!(new.open(&kek(1)).unwrap_err(), HeaderError::WrongKey);
        // Magic, version, codec and file id are untouched; only the wrap changed.
        assert_eq!(new.as_bytes()[..32], old.as_bytes()[..32]);
        // Rewrapping from a key that does not match fails without changing anything.
        assert_eq!(
            old.rewrap(&kek(3), &kek(2), &[4; NONCE_LEN]).unwrap_err(),
            HeaderError::WrongKey
        );
    }
}
