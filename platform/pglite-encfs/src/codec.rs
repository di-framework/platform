//! AES-256-XTS over fixed 4 KiB data units (the fscrypt/LUKS model).
//!
//! - Tweak = unit index, so identical plaintext in different units encrypts
//!   differently.
//! - Length-preserving: a unit's ciphertext is exactly as long as its plaintext.
//! - Each complete 16-byte block is encrypted independently under its (unit,
//!   block) tweak, and the mode is deterministic. A write of whole blocks torn
//!   at any sector boundary therefore decrypts to old sectors followed by new
//!   ones, which is exactly what PostgreSQL's crash recovery expects from a
//!   plain disk.
//!
//! A unit that ends mid-block (`len % 16 != 0`) is encoded by one of two
//! codecs, chosen per file by the header's codec id ([`Codec`]):
//!
//! - **Codec 3, [`Codec::XtsTail`]** (written for new files since #206):
//!   complete blocks are always plain XTS, without ciphertext stealing. The
//!   trailing `len % 16` bytes are XORed with the length-independent keystream
//!   block `AES_k2(unit ‖ block index ‖ "TAIL")` (see [`tail_input`]).
//!   Changing a unit's length therefore never changes the ciphertext of its
//!   complete blocks, and the bytes already in the partial block keep theirs
//!   (they are a prefix of the same keystream). Only a resize that completes or
//!   splits a block re-encrypts that block's durable partial bytes, at most 15.
//!   Cost: the partial block is a deterministic XOR, so two versions of the same
//!   tail block leak the XOR of their plaintexts.
//! - **Codec 2, [`Codec::XtsStealing`]** (v1, still read and written for files
//!   that carry it): a final partial unit of 16 bytes or more uses ciphertext
//!   stealing, and a unit shorter than one block is XORed with
//!   `AES_k2(tweak(unit) ^ (0x80 | len) << 120)`. Both depend on the unit's
//!   length, so a length change re-encrypts the last full block and the partial
//!   one (up to 31 durable bytes at risk on a crash, see `file`).
//!
//! No integrity: XTS does not detect tampering (see #200 for the AEAD mode).

use aes::cipher::{BlockEncrypt, KeyInit};
use aes::{Aes256, Block};
use xts_mode::{get_tweak_default, Xts128};

use crate::header::DEK_LEN;

/// Data unit size in bytes.
pub const UNIT: u64 = 4096;
const AES_BLOCK: usize = 16;

/// Domain separation for codec-3 tail keystream inputs, in bytes 12..16.
///
/// Every input of the tweak key within one file is distinct:
/// - XTS tweak inputs are the unit index as a little-endian u128, so byte 15
///   is zero (unit indices stay below 2^64);
/// - codec-2 sub-block masks have byte 15 = `0x80 | len`, in `0x81..=0x8F`;
/// - codec-3 tail inputs have byte 15 = `b'L'` (0x4C).
const TAIL_DOMAIN: [u8; 4] = *b"TAIL";

/// How a unit's trailing partial block is encoded; stored in the file header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    /// Codec 2 (v1): XTS with ciphertext stealing, length-dependent sub-block mask.
    XtsStealing,
    /// Codec 3: XTS on complete blocks, length-independent tail keystream.
    XtsTail,
}

impl Codec {
    /// The codec new files are created with: codec 2 unless the build has the
    /// `write-codec-3` feature (every build reads both).
    pub const NEW_FILES: Codec = if cfg!(feature = "write-codec-3") {
        Codec::XtsTail
    } else {
        Codec::XtsStealing
    };

    /// The header's codec byte.
    pub fn id(self) -> u8 {
        match self {
            Codec::XtsStealing => 2,
            Codec::XtsTail => 3,
        }
    }

    /// The codec for a header's codec byte. Codec 1 was the AEAD prototype
    /// (#200) and is not accepted.
    pub fn from_id(id: u8) -> Option<Codec> {
        match id {
            2 => Some(Codec::XtsStealing),
            3 => Some(Codec::XtsTail),
            _ => None,
        }
    }
}

/// Keystream input for the partial block at `block` of `unit` (codec 3):
/// unit index (LE u64) ‖ block index (LE u32) ‖ [`TAIL_DOMAIN`].
fn tail_input(unit: u64, block: usize) -> Block {
    let mut input = Block::default();
    input[..8].copy_from_slice(&unit.to_le_bytes());
    input[8..12].copy_from_slice(&(block as u32).to_le_bytes());
    input[12..].copy_from_slice(&TAIL_DOMAIN);
    input
}

pub struct UnitCipher {
    codec: Codec,
    xts: Xts128<Aes256>,
    /// The tweak key, also used for partial-block keystreams.
    tweak_key: Aes256,
}

impl UnitCipher {
    pub fn new(codec: Codec, dek: &[u8; DEK_LEN]) -> UnitCipher {
        let (data_key, tweak_key) = dek.split_at(DEK_LEN / 2);
        let data = Aes256::new(data_key.into());
        let tweak_key = Aes256::new(tweak_key.into());
        UnitCipher {
            codec,
            xts: Xts128::new(data, tweak_key.clone()),
            tweak_key,
        }
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }

    /// Encrypt one unit in place. `buf` is the unit's plaintext, at most [`UNIT`] bytes.
    pub fn encrypt(&self, unit: u64, buf: &mut [u8]) {
        Self::check_len(buf);
        match self.codec {
            Codec::XtsStealing if buf.len() >= AES_BLOCK => {
                self.xts.encrypt_sector(buf, get_tweak_default(unit.into()))
            }
            Codec::XtsStealing => self.mask_tail(unit, buf),
            Codec::XtsTail => {
                let (full, tail) = buf.split_at_mut(buf.len() / AES_BLOCK * AES_BLOCK);
                if !full.is_empty() {
                    self.xts
                        .encrypt_sector(full, get_tweak_default(unit.into()));
                }
                self.xor_tail(unit, full.len() / AES_BLOCK, tail);
            }
        }
    }

    /// Decrypt one unit in place.
    pub fn decrypt(&self, unit: u64, buf: &mut [u8]) {
        Self::check_len(buf);
        match self.codec {
            Codec::XtsStealing if buf.len() >= AES_BLOCK => {
                self.xts.decrypt_sector(buf, get_tweak_default(unit.into()))
            }
            Codec::XtsStealing => self.mask_tail(unit, buf),
            Codec::XtsTail => {
                let (full, tail) = buf.split_at_mut(buf.len() / AES_BLOCK * AES_BLOCK);
                if !full.is_empty() {
                    self.xts
                        .decrypt_sector(full, get_tweak_default(unit.into()));
                }
                self.xor_tail(unit, full.len() / AES_BLOCK, tail);
            }
        }
    }

    fn check_len(buf: &[u8]) {
        assert!(
            !buf.is_empty() && buf.len() as u64 <= UNIT,
            "a data unit holds 1..={UNIT} bytes, got {}",
            buf.len()
        );
    }

    /// Codec 2: XOR a sub-block unit with a keystream block. Its input differs
    /// from every XTS tweak input (the top byte of a unit index below 2^120 is
    /// zero), and it depends on the length.
    fn mask_tail(&self, unit: u64, buf: &mut [u8]) {
        let mut block = Block::from(get_tweak_default(unit.into()));
        block[AES_BLOCK - 1] ^= 0x80 | buf.len() as u8;
        self.tweak_key.encrypt_block(&mut block);
        for (byte, pad) in buf.iter_mut().zip(block.iter()) {
            *byte ^= pad;
        }
    }

    /// Codec 3: XOR the partial block at `block` (fewer than 16 bytes, maybe
    /// none) with its length-independent keystream.
    fn xor_tail(&self, unit: u64, block: usize, tail: &mut [u8]) {
        debug_assert!(tail.len() < AES_BLOCK);
        if tail.is_empty() {
            return;
        }
        let mut pad = tail_input(unit, block);
        self.tweak_key.encrypt_block(&mut pad);
        for (byte, pad) in tail.iter_mut().zip(pad.iter()) {
            *byte ^= pad;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODECS: [Codec; 2] = [Codec::XtsStealing, Codec::XtsTail];

    fn cipher_with(codec: Codec, seed: u8) -> UnitCipher {
        UnitCipher::new(codec, &core::array::from_fn(|i| seed.wrapping_add(i as u8)))
    }

    fn cipher(seed: u8) -> UnitCipher {
        cipher_with(Codec::NEW_FILES, seed)
    }

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect()
    }

    fn encrypted(c: &UnitCipher, unit: u64, plain: &[u8]) -> Vec<u8> {
        let mut buf = plain.to_vec();
        c.encrypt(unit, &mut buf);
        buf
    }

    #[test]
    fn codec_ids_round_trip_and_new_files_follow_the_feature() {
        let expected = if cfg!(feature = "write-codec-3") {
            Codec::XtsTail
        } else {
            Codec::XtsStealing
        };
        assert_eq!(Codec::NEW_FILES, expected);
        assert_eq!(Codec::XtsStealing.id(), 2);
        assert_eq!(Codec::XtsTail.id(), 3);
        for codec in CODECS {
            assert_eq!(Codec::from_id(codec.id()), Some(codec));
        }
        for id in [0, 1, 4, 0xFF] {
            assert_eq!(Codec::from_id(id), None, "codec {id}");
        }
        assert_eq!(cipher(1).codec(), expected);
    }

    #[test]
    fn round_trips_every_length_class() {
        for codec in CODECS {
            let c = cipher_with(codec, 1);
            for len in [1, 3, 15, 16, 17, 31, 32, 100, 4095, 4096] {
                let plain = pattern(len, 5);
                let mut buf = encrypted(&c, 9, &plain);
                assert_eq!(buf.len(), len, "{codec:?}: length preserving");
                assert_ne!(buf, plain, "{codec:?}: len {len} encrypted");
                c.decrypt(9, &mut buf);
                assert_eq!(buf, plain, "{codec:?}: len {len}");
            }
        }
    }

    #[test]
    fn codec_3_round_trips_at_the_block_and_unit_edges() {
        // Lengths 0 and 4097 span no unit or two units; `file` covers them.
        let c = cipher_with(Codec::XtsTail, 2);
        for unit in [0, 1, 78_187_493_520] {
            for len in [1, 15, 16, 17, 31, 4095, 4096] {
                let plain = pattern(len, 9);
                let mut buf = encrypted(&c, unit, &plain);
                assert_ne!(buf, plain, "unit {unit} len {len} encrypted");
                c.decrypt(unit, &mut buf);
                assert_eq!(buf, plain, "unit {unit} len {len}");
            }
        }
    }

    #[test]
    fn codec_3_ciphertext_does_not_depend_on_the_unit_length() {
        // The fix for #206: every prefix of a unit encrypts to a prefix of the
        // unit's ciphertext, except that a partial block turns into an XTS
        // block once it is complete.
        let c = cipher_with(Codec::XtsTail, 3);
        let plain = pattern(4096, 7);
        let whole = encrypted(&c, 6, &plain);
        let edges = (1..=4096).filter(|len| *len <= 100 || *len >= 3990 || len % 61 == 0);
        for len in edges {
            let part = encrypted(&c, 6, &plain[..len]);
            let full = len / 16 * 16;
            assert_eq!(part[..full], whole[..full], "complete blocks, len {len}");
            if len % 16 != 0 {
                // The partial bytes are a prefix of the same keystream at any length.
                let longest = encrypted(&c, 6, &plain[..full + 15]);
                assert_eq!(part[full..], longest[full..len], "partial block, len {len}");
            }
        }
    }

    #[test]
    fn codec_2_ciphertext_still_depends_on_the_unit_length() {
        // The behaviour codec-2 files keep: ciphertext stealing moves the last
        // full block when the length changes.
        let c = cipher_with(Codec::XtsStealing, 3);
        let plain = pattern(4096, 7);
        let a = encrypted(&c, 6, &plain[..4001]);
        let b = encrypted(&c, 6, &plain[..4002]);
        assert_ne!(a[3984..4000], b[3984..4000]);
        assert_eq!(a[..3984], b[..3984]);
    }

    #[test]
    fn tail_keystream_inputs_are_domain_separated() {
        // The tweak key also encrypts XTS tweaks (byte 15 zero) and codec-2
        // sub-block masks (byte 15 = 0x81..=0x8F).
        for (unit, block) in [(0, 0), (u64::MAX, 255), (5, 17)] {
            let input = tail_input(unit, block);
            assert_eq!(input[15], b'L');
            assert_ne!(input[15], 0);
            assert!(!(0x81..=0x8F).contains(&input[15]));
            assert_eq!(&input[..8], &unit.to_le_bytes());
            assert_eq!(&input[8..12], &(block as u32).to_le_bytes());
        }
        // Different blocks and units get different keystreams.
        let c = cipher_with(Codec::XtsTail, 4);
        let ks = |unit, len| encrypted(&c, unit, &vec![0; len]);
        assert_ne!(ks(0, 1), ks(1, 1));
        assert_ne!(ks(0, 17)[16..], ks(0, 1)[..]);
        // A codec-3 sub-block unit is not the codec-2 mask.
        let old = cipher_with(Codec::XtsStealing, 4);
        assert_ne!(ks(0, 3), encrypted(&old, 0, &[0; 3]));
    }

    const KAT: &str = include_str!("testdata/xts-kat.txt");

    fn kat_cipher(codec: Codec) -> UnitCipher {
        let mut dek = [0u8; DEK_LEN];
        dek[..32].copy_from_slice(&hex(
            "2718281828459045235360287471352662497757247093699959574966967627",
        ));
        dek[32..].copy_from_slice(&hex(
            "3141592653589793238462643383279502884197169399375105820974944592",
        ));
        UnitCipher::new(codec, &dek)
    }

    #[test]
    fn known_answer_ieee_1619_vector_10() {
        // All 512 bytes of IEEE P1619/D16 XTS-AES-256 vector 10. Whole blocks
        // are plain XTS under both codecs.
        let expected = KAT.lines().find_map(|l| l.strip_prefix("v10 ")).unwrap();
        for codec in CODECS {
            let mut buf: Vec<u8> = (0..512).map(|i| i as u8).collect();
            kat_cipher(codec).encrypt(0xff, &mut buf);
            assert_eq!(buf, hex(expected), "{codec:?}");
            kat_cipher(codec).decrypt(0xff, &mut buf);
            assert_eq!(buf, (0..512).map(|i| i as u8).collect::<Vec<_>>());
        }
    }

    /// Check every `<prefix><unit> <len> <ciphertext>` line of the KAT file.
    fn check_known_answers(codec: Codec, prefix: &str) -> usize {
        let c = kat_cipher(codec);
        let mut checked = 0;
        for line in KAT.lines().filter_map(|l| l.strip_prefix(prefix)) {
            let fields: Vec<&str> = line.split(' ').collect();
            let (unit, len): (u64, usize) =
                (fields[0].parse().unwrap(), fields[1].parse().unwrap());
            let plain: Vec<u8> = (0..len).map(|i| ((7 * i + 3) % 256) as u8).collect();
            let mut buf = encrypted(&c, unit, &plain);
            let got = match fields[2].strip_prefix("sha256:") {
                Some(_) => {
                    use sha2::Digest;
                    format!("sha256:{:x}", sha2::Sha256::digest(&buf))
                }
                None => buf.iter().map(|b| format!("{b:02x}")).collect(),
            };
            assert_eq!(got, fields[2], "{prefix}unit {unit} len {len}");
            c.decrypt(unit, &mut buf);
            assert_eq!(buf, plain);
            checked += 1;
        }
        checked
    }

    #[test]
    fn known_answers_with_ciphertext_stealing() {
        // Codec 2: partial-block lengths pin the stealing layout, independently of xts-mode.
        assert_eq!(check_known_answers(Codec::XtsStealing, "kat "), 21);
    }

    #[test]
    fn known_answers_with_tail_keystream() {
        // Codec 3: complete blocks and the tail keystream, from an independent reference.
        assert_eq!(check_known_answers(Codec::XtsTail, "kat3 "), 30);
    }

    #[test]
    fn units_and_keys_are_independent() {
        for codec in CODECS {
            let plain = pattern(4096, 0);
            let c = cipher_with(codec, 1);
            assert_ne!(encrypted(&c, 0, &plain), encrypted(&c, 1, &plain));
            assert_ne!(
                encrypted(&c, 0, &plain),
                encrypted(&cipher_with(codec, 2), 0, &plain)
            );
            assert_eq!(
                encrypted(&c, 7, &plain),
                encrypted(&c, 7, &plain),
                "deterministic"
            );
        }
    }

    #[test]
    fn a_torn_unit_decrypts_to_old_and_new_sectors() {
        // Power loss mid-write keeps a prefix of 512-byte sectors from the new
        // version and the rest from the old one. Unlike an AEAD or wide-block
        // mode, XTS decrypts that to the same mix of plaintexts.
        for codec in CODECS {
            let c = cipher_with(codec, 3);
            let old = pattern(4096, 1);
            let new = pattern(4096, 2);
            let (old_ct, new_ct) = (encrypted(&c, 4, &old), encrypted(&c, 4, &new));
            for tear in (0..=4096).step_by(512) {
                let mut torn = [&new_ct[..tear], &old_ct[tear..]].concat();
                c.decrypt(4, &mut torn);
                assert_eq!(
                    torn,
                    [&new[..tear], &old[tear..]].concat(),
                    "{codec:?}: tear at {tear}"
                );
            }
        }
    }

    #[test]
    fn unchanged_sectors_reencrypt_identically() {
        // PostgreSQL rewrites the WAL tail page with identical bytes for the
        // records that are already durable; their ciphertext must not move.
        for codec in CODECS {
            let c = cipher_with(codec, 4);
            let before = pattern(4096, 1);
            let mut after = before.clone();
            after[3000..].fill(0xEE);
            let (a, b) = (encrypted(&c, 2, &before), encrypted(&c, 2, &after));
            assert_eq!(a[..2992], b[..2992], "{codec:?}");
        }
    }

    #[test]
    #[should_panic(expected = "a data unit holds")]
    fn oversized_units_are_a_bug() {
        cipher(1).encrypt(0, &mut [0u8; 4097]);
    }

    #[test]
    #[should_panic(expected = "a data unit holds")]
    fn empty_units_are_a_bug() {
        cipher(1).encrypt(0, &mut []);
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }
}
