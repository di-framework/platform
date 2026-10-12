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
//! | 9        | codec (2 = AES-256-XTS)                    |
//! | 10..16   | reserved, zero                             |
//! | 16..32   | file id (random)                           |
//! | 32..48   | key-check value of the wrapping key        |
//! | 48..72   | wrap nonce (XChaCha20)                     |
//! | 72..136  | wrapped 64-byte DEK                        |
//! | 136..152 | wrap tag (Poly1305); AAD = bytes 0..32     |
//!
//! The DEK is random per file rather than derived from the path, so renames
//! keep working and a copied file gets a fresh key. The header is written once
//! and never removed (truncating to zero keeps it), so the file id is fixed
//! for the inode's lifetime. Rotation rewrites only the wrap (bytes 32..152).

use chacha20poly1305::aead::AeadInPlace;
use chacha20poly1305::{Tag, XNonce};
use zeroize::Zeroizing;

use crate::keys::{Kek, KCV_LEN};

/// Physical offset of the first data unit.
pub const HEADER_LEN: u64 = 4096;
/// Bytes of the header that carry data.
pub const HEADER_USED: usize = 152;
pub const MAGIC: &[u8; 8] = b"DIPGENC1";
pub const FORMAT_VERSION: u8 = 1;
/// AES-256-XTS over 4 KiB units. Codec 1 was the AEAD prototype (#200) and is
/// not accepted.
pub const CODEC_XTS: u8 = 2;
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

/// Classify a regular file of `physical` bytes whose first bytes are `start`
/// (up to [`HEADER_USED`] of them).
///
/// Anything else without a valid header is refused: a zero header on a file
/// longer than [`HEADER_LEN`] (it may hold data; the header is synced before
/// any data is written, so a crash cannot produce that state), and any
/// non-zero bytes that are not a header, however short (a plaintext file must
/// never be read as an empty encrypted one).
pub fn classify(start: &[u8], physical: u64) -> Result<HeaderState, HeaderError> {
    let start = &start[..start.len().min(HEADER_USED)];
    if physical <= HEADER_LEN && start.iter().all(|&b| b == 0) {
        return Ok(HeaderState::Fresh);
    }
    Header::parse(start).map(HeaderState::Sealed)
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
        file_id: &FileId,
        dek: &[u8; DEK_LEN],
        nonce: &[u8; NONCE_LEN],
    ) -> Header {
        let mut bytes = [0u8; HEADER_USED];
        bytes[..MAGIC.len()].copy_from_slice(MAGIC);
        bytes[VERSION_AT] = FORMAT_VERSION;
        bytes[CODEC_AT] = CODEC_XTS;
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
        if version != FORMAT_VERSION || codec != CODEC_XTS {
            return Err(HeaderError::Unsupported { version, codec });
        }
        Ok(Header { bytes })
    }

    pub fn as_bytes(&self) -> &[u8; HEADER_USED] {
        &self.bytes
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
        Header::seal(&kek(1), &[0xAB; 16], &dek(), &[3; NONCE_LEN])
    }

    #[test]
    fn layout_matches_the_documented_offsets() {
        let header = sealed();
        let b = header.as_bytes();
        assert_eq!(&b[..8], b"DIPGENC1");
        assert_eq!((b[8], b[9]), (1, 2));
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
        let mut aead = bytes;
        aead[9] = 1;
        assert_eq!(
            Header::parse(&aead).unwrap_err(),
            HeaderError::Unsupported {
                version: 1,
                codec: 1
            }
        );
        let mut v2 = bytes;
        v2[8] = 2;
        assert_eq!(
            Header::parse(&v2).unwrap_err(),
            HeaderError::Unsupported {
                version: 2,
                codec: 2
            }
        );
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
        // plaintext file must not be read as an empty encrypted one.
        assert_eq!(
            classify(&[b'x'; HEADER_USED], 200),
            Err(HeaderError::NotEncrypted)
        );
        assert_eq!(classify(b"17\n", 3), Err(HeaderError::NotEncrypted));
        let mut half = [0u8; HEADER_USED];
        half[..8].copy_from_slice(MAGIC);
        assert_eq!(classify(&half[..20], 20), Err(HeaderError::NotEncrypted));
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
