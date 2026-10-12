//! The key marker at each preopen root and the decision it drives.
//!
//! Before pglite may touch a preopened directory, its `.di-encfs` marker
//! (magic + KCV) is compared with the configured keys. Every refusal locks the
//! whole preopen before any mutation. That matters: pglite re-extracts its
//! runtime files with `open(CREATE|TRUNCATE)` at every start, so a per-file
//! check alone would let a wrong-key start overwrite correctly encrypted files.

use crate::keys::{Kcv, KeyRing, KCV_LEN};

/// File name of the marker, hidden from listings of the root.
pub const MARKER_NAME: &str = ".di-encfs";
pub const MARKER_MAGIC: &[u8; 8] = b"DIPGKEY1";
pub const MARKER_LEN: usize = MARKER_MAGIC.len() + KCV_LEN;

/// Entries that do not make a root "non-empty": ext4 volume roots (PVCs)
/// always carry `lost+found`.
pub fn is_volume_metadata(name: &str) -> bool {
    name == "lost+found"
}

pub fn encode(kcv: &Kcv) -> [u8; MARKER_LEN] {
    let mut bytes = [0u8; MARKER_LEN];
    bytes[..MARKER_MAGIC.len()].copy_from_slice(MARKER_MAGIC);
    bytes[MARKER_MAGIC.len()..].copy_from_slice(kcv);
    bytes
}

/// What to do with a preopen root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootDecision {
    /// The marker matches the current key.
    Ready,
    /// Empty directory: write the marker for the current key, then use it.
    Initialize,
    /// The marker matches the previous key: re-wrap every file header under the
    /// current key, then flip the marker.
    Rotate,
    /// Refuse every operation on this preopen.
    Locked(Lock),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lock {
    /// `DI_PGLITE_KEY` is missing or invalid.
    NoKey,
    /// The marker matches neither configured key.
    WrongKey,
    /// Data without a marker: an unencrypted directory (refused, never migrated in place).
    Unencrypted,
    /// The marker exists but is not a marker.
    CorruptMarker,
}

impl Lock {
    /// Operator-facing reason; never contains key material.
    pub fn message(self) -> &'static str {
        match self {
            Lock::NoKey => {
                "DI_PGLITE_KEY is not set or invalid; refusing all file access (encryption at rest is required)"
            }
            Lock::WrongKey => {
                "the data directory was encrypted with a different key (key check value mismatch); refusing"
            }
            Lock::Unencrypted => {
                "the data directory has data but no encryption marker (an unencrypted directory); refusing. Migrate it offline into an empty directory first"
            }
            Lock::CorruptMarker => "the encryption marker (.di-encfs) is corrupt; refusing",
        }
    }

    /// Key problems are `access` errors; data that cannot be read is `io`.
    pub fn is_access_error(self) -> bool {
        matches!(self, Lock::NoKey | Lock::WrongKey)
    }
}

/// Decide from the marker contents (`None` when absent) and whether the root
/// has other entries (see [`is_volume_metadata`]).
pub fn decide(keys: &KeyRing, marker: Option<&[u8]>, has_data: bool) -> RootDecision {
    let Some(current) = keys.current() else {
        return RootDecision::Locked(Lock::NoKey);
    };
    let Some(marker) = marker else {
        return if has_data {
            RootDecision::Locked(Lock::Unencrypted)
        } else {
            RootDecision::Initialize
        };
    };
    if marker.len() != MARKER_LEN || &marker[..MARKER_MAGIC.len()] != MARKER_MAGIC {
        return RootDecision::Locked(Lock::CorruptMarker);
    }
    let kcv = &marker[MARKER_MAGIC.len()..];
    if current.matches(kcv) {
        RootDecision::Ready
    } else if keys
        .previous()
        .is_some_and(|previous| previous.matches(kcv))
    {
        RootDecision::Rotate
    } else {
        RootDecision::Locked(Lock::WrongKey)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Kek;

    fn kek(b: u8) -> Kek {
        Kek::derive(&[b; 32])
    }

    fn ring(current: Option<u8>, previous: Option<u8>) -> KeyRing {
        KeyRing::new(current.map(kek), previous.map(kek))
    }

    fn marker(b: u8) -> [u8; MARKER_LEN] {
        encode(kek(b).kcv())
    }

    #[test]
    fn matching_marker_is_ready() {
        assert_eq!(
            decide(&ring(Some(1), None), Some(&marker(1)), true),
            RootDecision::Ready
        );
        // The same key in both variables is not a rotation.
        assert_eq!(
            decide(&ring(Some(1), Some(1)), Some(&marker(1)), true),
            RootDecision::Ready
        );
    }

    #[test]
    fn empty_root_is_initialized_and_data_without_marker_is_refused() {
        assert_eq!(
            decide(&ring(Some(1), None), None, false),
            RootDecision::Initialize
        );
        assert_eq!(
            decide(&ring(Some(1), None), None, true),
            RootDecision::Locked(Lock::Unencrypted)
        );
        assert!(is_volume_metadata("lost+found"));
        assert!(!is_volume_metadata("pglite"));
    }

    #[test]
    fn missing_key_locks_everything() {
        for (m, data) in [(Some(&marker(1)[..]), true), (None, false), (None, true)] {
            assert_eq!(
                decide(&ring(None, Some(1)), m, data),
                RootDecision::Locked(Lock::NoKey)
            );
        }
    }

    #[test]
    fn wrong_key_locks_and_previous_key_rotates() {
        assert_eq!(
            decide(&ring(Some(2), None), Some(&marker(1)), true),
            RootDecision::Locked(Lock::WrongKey)
        );
        assert_eq!(
            decide(&ring(Some(2), Some(1)), Some(&marker(1)), true),
            RootDecision::Rotate
        );
        assert_eq!(
            decide(&ring(Some(2), Some(3)), Some(&marker(1)), true),
            RootDecision::Locked(Lock::WrongKey)
        );
        // After the marker flipped, the old key alone is refused.
        assert_eq!(
            decide(&ring(Some(1), None), Some(&marker(2)), true),
            RootDecision::Locked(Lock::WrongKey)
        );
    }

    #[test]
    fn corrupt_markers_are_refused() {
        let mut bad_magic = marker(1);
        bad_magic[0] ^= 1;
        for m in [&bad_magic[..], &marker(1)[..MARKER_LEN - 1], b""] {
            assert_eq!(
                decide(&ring(Some(1), None), Some(m), true),
                RootDecision::Locked(Lock::CorruptMarker)
            );
        }
    }

    #[test]
    fn lock_errors_map_to_access_or_io() {
        assert!(Lock::NoKey.is_access_error());
        assert!(Lock::WrongKey.is_access_error());
        assert!(!Lock::Unencrypted.is_access_error());
        assert!(!Lock::CorruptMarker.is_access_error());
        assert!(Lock::NoKey.message().contains("DI_PGLITE_KEY"));
    }
}
