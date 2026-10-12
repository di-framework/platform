//! Master keys from the environment and the keys derived from them.
//!
//! ```text
//! master (32 bytes, env DI_PGLITE_KEY, base64)
//!   └─ HKDF-SHA256(salt = "di-framework/encfs/v1")
//!        ├─ info "kek"             → key-encryption key (XChaCha20-Poly1305), wraps file DEKs
//!        └─ info "key-check-value" → 16-byte KCV in file headers and the root marker
//! ```
//!
//! The master key is decoded once and wiped as soon as the KEK and KCV are
//! derived. Only the KCV, a one-way HKDF output, is ever written to disk.
//! Nothing in this module formats key material into a message.

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine as _;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

/// Environment variable holding the current master key.
pub const KEY_ENV: &str = "DI_PGLITE_KEY";
/// Environment variable holding the previous master key during a rotation.
pub const PREVIOUS_KEY_ENV: &str = "DI_PGLITE_KEY_PREVIOUS";

/// Master key length in bytes.
pub const MASTER_KEY_LEN: usize = 32;
/// Key-check value length in bytes.
pub const KCV_LEN: usize = 16;

/// Key-check value: identifies a master key without revealing it.
pub type Kcv = [u8; KCV_LEN];

const HKDF_SALT: &[u8] = b"di-framework/encfs/v1";
const HKDF_INFO_KEK: &[u8] = b"kek";
const HKDF_INFO_KCV: &[u8] = b"key-check-value";

/// Whether an environment variable carries key material and must be hidden
/// from the engine.
pub fn is_key_variable(name: &str) -> bool {
    name == KEY_ENV || name == PREVIOUS_KEY_ENV
}

/// Why a key variable was rejected. Never includes the value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    NotBase64,
    WrongLength,
}

impl KeyError {
    /// Operator-facing message naming the variable, not its value.
    pub fn message(self, variable: &str) -> String {
        match self {
            KeyError::NotBase64 => format!("{variable} is not valid base64; ignoring it"),
            KeyError::WrongLength => {
                format!("{variable} must be base64 of exactly {MASTER_KEY_LEN} bytes; ignoring it")
            }
        }
    }
}

const fn lenient(alphabet: &alphabet::Alphabet) -> GeneralPurpose {
    GeneralPurpose::new(
        alphabet,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    )
}

/// Standard and URL-safe alphabets, padded or not: `openssl rand -base64 32`
/// and Node's `randomBytes(32).toString('base64url')` both work.
const ENGINES: [GeneralPurpose; 2] = [lenient(&alphabet::STANDARD), lenient(&alphabet::URL_SAFE)];

/// Decode a base64 master key. Surrounding whitespace is ignored.
pub fn parse_master_key(text: &str) -> Result<Zeroizing<[u8; MASTER_KEY_LEN]>, KeyError> {
    let text = text.trim();
    let decoded = ENGINES
        .iter()
        .find_map(|engine| engine.decode(text).ok().map(Zeroizing::new))
        .ok_or(KeyError::NotBase64)?;
    if decoded.len() != MASTER_KEY_LEN {
        return Err(KeyError::WrongLength);
    }
    let mut key = Zeroizing::new([0u8; MASTER_KEY_LEN]);
    key.copy_from_slice(&decoded);
    Ok(key)
}

/// Key-encryption key and key-check value derived from one master key.
pub struct Kek {
    kcv: Kcv,
    cipher: XChaCha20Poly1305,
}

impl Kek {
    pub fn derive(master: &[u8; MASTER_KEY_LEN]) -> Kek {
        let hkdf = Hkdf::<Sha256>::new(Some(HKDF_SALT), master);
        let mut key = Zeroizing::new([0u8; 32]);
        let mut kcv = [0u8; KCV_LEN];
        // Both lengths are far below HKDF-SHA256's 8160-byte limit.
        hkdf.expand(HKDF_INFO_KEK, key.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        hkdf.expand(HKDF_INFO_KCV, &mut kcv)
            .expect("16 bytes is a valid HKDF-SHA256 output length");
        let cipher = XChaCha20Poly1305::new(key.as_ref().into());
        Kek { kcv, cipher }
    }

    pub fn kcv(&self) -> &Kcv {
        &self.kcv
    }

    pub(crate) fn cipher(&self) -> &XChaCha20Poly1305 {
        &self.cipher
    }

    /// Whether `kcv` identifies this key.
    pub fn matches(&self, kcv: &[u8]) -> bool {
        self.kcv.as_slice() == kcv
    }
}

/// The current key (required for any file access) and, during a rotation, the
/// previous one.
#[derive(Default)]
pub struct KeyRing {
    current: Option<Kek>,
    previous: Option<Kek>,
}

impl KeyRing {
    pub fn new(current: Option<Kek>, previous: Option<Kek>) -> KeyRing {
        KeyRing { current, previous }
    }

    /// Read both key variables from `environment`, wiping every value it
    /// consumes. Rejected values are reported through `warn` by variable name.
    pub fn from_environment(
        environment: Vec<(String, String)>,
        warn: &mut dyn FnMut(String),
    ) -> KeyRing {
        let mut ring = KeyRing::default();
        for (name, mut value) in environment {
            let slot = match name.as_str() {
                KEY_ENV => Some(&mut ring.current),
                PREVIOUS_KEY_ENV => Some(&mut ring.previous),
                _ => None,
            };
            if let Some(slot) = slot {
                match parse_master_key(&value) {
                    Ok(master) => *slot = Some(Kek::derive(&master)),
                    Err(error) => warn(error.message(&name)),
                }
            }
            // The host copied every variable into this module's memory; wipe
            // them all, not only the key variables.
            value.zeroize();
        }
        ring
    }

    pub fn current(&self) -> Option<&Kek> {
        self.current.as_ref()
    }

    pub fn previous(&self) -> Option<&Kek> {
        self.previous.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: [u8; 32] = [7; 32];
    const KEY_B: [u8; 32] = [9; 32];

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn parses_standard_and_url_safe_base64_with_or_without_padding() {
        let key: Vec<u8> = (0u8..32)
            .map(|i| i.wrapping_mul(37).wrapping_add(250))
            .collect();
        let standard = base64::engine::general_purpose::STANDARD.encode(&key);
        let url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&key);
        assert!(
            standard.contains('+') || standard.contains('/'),
            "fixture exercises the alphabet"
        );
        for text in [
            standard.clone(),
            standard.trim_end_matches('=').to_owned(),
            url,
            format!(" {standard}\n"),
        ] {
            assert_eq!(
                parse_master_key(&text).unwrap().as_slice(),
                key.as_slice(),
                "{text:?}"
            );
        }
    }

    #[test]
    fn rejects_bad_keys_without_echoing_them() {
        assert_eq!(
            parse_master_key("not base64 !!").unwrap_err(),
            KeyError::NotBase64
        );
        assert_eq!(
            parse_master_key(&b64(&[1; 16])).unwrap_err(),
            KeyError::WrongLength
        );
        assert_eq!(
            parse_master_key(&b64(&[1; 33])).unwrap_err(),
            KeyError::WrongLength
        );
        assert_eq!(parse_master_key("").unwrap_err(), KeyError::WrongLength);
        let secret = b64(&[1; 16]);
        for error in [KeyError::NotBase64, KeyError::WrongLength] {
            let message = error.message(KEY_ENV);
            assert!(message.contains(KEY_ENV));
            assert!(!message.contains(&secret));
        }
    }

    #[test]
    fn derivation_is_deterministic_and_key_specific() {
        let a = Kek::derive(&KEY_A);
        assert_eq!(a.kcv(), Kek::derive(&KEY_A).kcv());
        assert_ne!(a.kcv(), Kek::derive(&KEY_B).kcv());
        assert!(a.matches(Kek::derive(&KEY_A).kcv()));
        assert!(!a.matches(Kek::derive(&KEY_B).kcv()));
        // The KCV is not the key or a prefix of it.
        assert_ne!(a.kcv().as_slice(), &KEY_A[..KCV_LEN]);
    }

    #[test]
    fn known_answer_kcv() {
        // Pins the derivation: changing salt or info strings would orphan every volume.
        let kcv = Kek::derive(&[0; 32]).kcv().to_vec();
        let hkdf = Hkdf::<Sha256>::new(Some(b"di-framework/encfs/v1"), &[0; 32]);
        let mut expected = [0u8; 16];
        hkdf.expand(b"key-check-value", &mut expected).unwrap();
        assert_eq!(kcv, expected);
    }

    #[test]
    fn key_ring_reads_both_variables_and_reports_bad_ones_by_name() {
        let mut warnings = Vec::new();
        let ring = KeyRing::from_environment(
            vec![
                ("PATH".into(), "/bin".into()),
                (KEY_ENV.into(), b64(&KEY_A)),
                (PREVIOUS_KEY_ENV.into(), b64(&KEY_B)),
            ],
            &mut |w| warnings.push(w),
        );
        assert!(warnings.is_empty());
        assert_eq!(ring.current().unwrap().kcv(), Kek::derive(&KEY_A).kcv());
        assert_eq!(ring.previous().unwrap().kcv(), Kek::derive(&KEY_B).kcv());

        let ring = KeyRing::from_environment(
            vec![
                (KEY_ENV.into(), "short".into()),
                (PREVIOUS_KEY_ENV.into(), "@@".into()),
            ],
            &mut |w| warnings.push(w),
        );
        assert!(ring.current().is_none() && ring.previous().is_none());
        assert_eq!(warnings.len(), 2);
        assert!(warnings[0].starts_with(KEY_ENV) && warnings[1].starts_with(PREVIOUS_KEY_ENV));
        assert!(!warnings
            .iter()
            .any(|w| w.contains("short") || w.contains("@@")));
    }

    #[test]
    fn only_the_key_variables_are_hidden() {
        assert!(is_key_variable(KEY_ENV));
        assert!(is_key_variable(PREVIOUS_KEY_ENV));
        assert!(!is_key_variable("DI_PGLITE_KEY_FILE"));
        assert!(!is_key_variable("PGDATA"));
    }
}
