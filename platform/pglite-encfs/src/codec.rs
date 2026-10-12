//! AES-256-XTS over fixed 4 KiB data units (the fscrypt/LUKS model).
//!
//! - Tweak = unit index, so identical plaintext in different units encrypts
//!   differently.
//! - Length-preserving: a unit's ciphertext is exactly as long as its plaintext.
//! - Each 16-byte block is encrypted independently under its (unit, block)
//!   tweak, and the mode is deterministic. A write torn at any sector boundary
//!   therefore decrypts to old sectors followed by new ones, which is exactly
//!   what PostgreSQL's crash recovery expects from a plain disk.
//! - A final partial unit of 16 bytes or more uses ciphertext stealing.
//! - A final unit shorter than one AES block (tiny files such as `PG_VERSION`)
//!   is XORed with `AES_k2(tweak(unit) ^ (0x80 | len) << 120)`. That is
//!   deterministic: two versions of such a tail with the same length leak their
//!   XOR. Relation and WAL files are always whole units.
//!
//! No integrity: XTS does not detect tampering (see #200 for the AEAD mode).

use aes::cipher::{BlockEncrypt, KeyInit};
use aes::{Aes256, Block};
use xts_mode::{get_tweak_default, Xts128};

use crate::header::DEK_LEN;

/// Data unit size in bytes.
pub const UNIT: u64 = 4096;
const AES_BLOCK: usize = 16;

pub struct UnitCipher {
    xts: Xts128<Aes256>,
    /// The tweak key, also used for sub-block tails.
    tweak_key: Aes256,
}

impl UnitCipher {
    pub fn new(dek: &[u8; DEK_LEN]) -> UnitCipher {
        let (data_key, tweak_key) = dek.split_at(DEK_LEN / 2);
        let data = Aes256::new(data_key.into());
        let tweak_key = Aes256::new(tweak_key.into());
        UnitCipher {
            xts: Xts128::new(data, tweak_key.clone()),
            tweak_key,
        }
    }

    /// Encrypt one unit in place. `buf` is the unit's plaintext, at most [`UNIT`] bytes.
    pub fn encrypt(&self, unit: u64, buf: &mut [u8]) {
        Self::check_len(buf);
        if buf.len() >= AES_BLOCK {
            self.xts.encrypt_sector(buf, get_tweak_default(unit.into()));
        } else {
            self.mask_tail(unit, buf);
        }
    }

    /// Decrypt one unit in place.
    pub fn decrypt(&self, unit: u64, buf: &mut [u8]) {
        Self::check_len(buf);
        if buf.len() >= AES_BLOCK {
            self.xts.decrypt_sector(buf, get_tweak_default(unit.into()));
        } else {
            self.mask_tail(unit, buf);
        }
    }

    fn check_len(buf: &[u8]) {
        assert!(
            !buf.is_empty() && buf.len() as u64 <= UNIT,
            "a data unit holds 1..={UNIT} bytes, got {}",
            buf.len()
        );
    }

    /// XOR a sub-block unit with a keystream block. Its input differs from
    /// every XTS tweak input (the top byte of a unit index below 2^120 is zero),
    /// and it depends on the length.
    fn mask_tail(&self, unit: u64, buf: &mut [u8]) {
        let mut block = Block::from(get_tweak_default(unit.into()));
        block[AES_BLOCK - 1] ^= 0x80 | buf.len() as u8;
        self.tweak_key.encrypt_block(&mut block);
        for (byte, pad) in buf.iter_mut().zip(block.iter()) {
            *byte ^= pad;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher(seed: u8) -> UnitCipher {
        UnitCipher::new(&core::array::from_fn(|i| seed.wrapping_add(i as u8)))
    }

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect()
    }

    #[test]
    fn round_trips_every_length_class() {
        let c = cipher(1);
        for len in [1, 3, 15, 16, 17, 31, 32, 100, 4095, 4096] {
            let plain = pattern(len, 5);
            let mut buf = plain.clone();
            c.encrypt(9, &mut buf);
            assert_eq!(buf.len(), len, "length preserving");
            assert_ne!(buf, plain, "len {len} encrypted");
            c.decrypt(9, &mut buf);
            assert_eq!(buf, plain, "len {len}");
        }
    }

    #[test]
    fn known_answer_ieee_1619_vector_10() {
        // IEEE P1619/D16 XTS-AES-256 vector 10: key1 = 2718281828..., key2 = 3141592653...,
        // data unit sequence number 0xff, 512 bytes of 00..ff 00..ff.
        let key1 = hex("2718281828459045235360287471352662497757247093699959574966967627");
        let key2 = hex("3141592653589793238462643383279502884197169399375105820974944592");
        let mut dek = [0u8; DEK_LEN];
        dek[..32].copy_from_slice(&key1);
        dek[32..].copy_from_slice(&key2);
        let mut buf: Vec<u8> = (0..512).map(|i| i as u8).collect();
        UnitCipher::new(&dek).encrypt(0xff, &mut buf);
        assert_eq!(
            buf[..32],
            hex("1c3b3a102f770386e4836c99e370cf9bea00803f5e482357a4ae12d414a3e63b")[..]
        );
    }

    #[test]
    fn units_and_keys_are_independent() {
        let plain = pattern(4096, 0);
        let enc = |c: &UnitCipher, unit| {
            let mut b = plain.clone();
            c.encrypt(unit, &mut b);
            b
        };
        let c = cipher(1);
        assert_ne!(enc(&c, 0), enc(&c, 1));
        assert_ne!(enc(&c, 0), enc(&cipher(2), 0));
        assert_eq!(enc(&c, 7), enc(&c, 7), "deterministic");
    }

    #[test]
    fn a_torn_unit_decrypts_to_old_and_new_sectors() {
        // Power loss mid-write keeps a prefix of 512-byte sectors from the new
        // version and the rest from the old one. Unlike an AEAD or wide-block
        // mode, XTS decrypts that to the same mix of plaintexts.
        let c = cipher(3);
        let old = pattern(4096, 1);
        let new = pattern(4096, 2);
        let (mut old_ct, mut new_ct) = (old.clone(), new.clone());
        c.encrypt(4, &mut old_ct);
        c.encrypt(4, &mut new_ct);
        for tear in (0..=4096).step_by(512) {
            let mut torn = [&new_ct[..tear], &old_ct[tear..]].concat();
            c.decrypt(4, &mut torn);
            assert_eq!(
                torn,
                [&new[..tear], &old[tear..]].concat(),
                "tear at {tear}"
            );
        }
    }

    #[test]
    fn unchanged_sectors_reencrypt_identically() {
        // PostgreSQL rewrites the WAL tail page with identical bytes for the
        // records that are already durable; their ciphertext must not move.
        let c = cipher(4);
        let before = pattern(4096, 1);
        let mut after = before.clone();
        after[3000..].fill(0xEE);
        let (mut a, mut b) = (before, after);
        c.encrypt(2, &mut a);
        c.encrypt(2, &mut b);
        assert_eq!(a[..2992], b[..2992]);
    }

    #[test]
    #[should_panic(expected = "a data unit holds")]
    fn oversized_units_are_a_bug() {
        cipher(1).encrypt(0, &mut [0u8; 4097]);
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }
}
