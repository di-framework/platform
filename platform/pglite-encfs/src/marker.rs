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
/// The marker is written here, synced, then renamed over [`MARKER_NAME`], so a
/// crash never leaves a partial marker in place.
pub const MARKER_TMP_NAME: &str = ".di-encfs.tmp";
pub const MARKER_MAGIC: &[u8; 8] = b"DIPGKEY1";
pub const MARKER_LEN: usize = MARKER_MAGIC.len() + KCV_LEN;

/// The directory ext4 volume roots (PVCs) always carry. fsck reconnects
/// orphaned inodes there, so on an encrypted volume it can hold sealed files
/// as well as fragments; see [`crate::rotation`].
pub const LOST_AND_FOUND: &str = "lost+found";

/// Entries that do not make a root "non-empty": `lost+found`, and the marker
/// files, which are ours.
pub fn is_volume_metadata(name: &str) -> bool {
    name == LOST_AND_FOUND || is_marker_name(name)
}

/// The marker or its temporary file, exactly as encfs writes them.
pub fn is_marker_name(name: &str) -> bool {
    name == MARKER_NAME || name == MARKER_TMP_NAME
}

/// A name pglite may not use: the marker or its temporary file in any ASCII
/// case. On a case-insensitive volume (APFS by default) `.DI-ENCFS` names the
/// marker; pglite never needs such a name, so refusing it everywhere costs
/// nothing on a case-sensitive one.
pub fn is_reserved_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(MARKER_NAME) || name.eq_ignore_ascii_case(MARKER_TMP_NAME)
}

/// The components of `path`, relative to a preopen root, with `.`, `..` and
/// repeated slashes resolved. `..` never climbs above the root: the host
/// refuses such paths, and treating them as the root keeps the checks below
/// on the safe side.
fn normalize(path: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            name => parts.push(name),
        }
    }
    parts
}

/// Whether `path`, relative to a preopen root, names a marker file once `.`,
/// `..` and repeated slashes are resolved. pglite must never reach them.
pub fn is_marker_path(path: &str) -> bool {
    matches!(normalize(path).as_slice(), [name] if is_reserved_name(name))
}

/// Whether `path`, relative to a preopen root, names the root itself once
/// normalized (`.`, `pglite/..`, ...). A descriptor opened that way must keep
/// the root's marker guard and listing filter (#207).
pub fn is_root_path(path: &str) -> bool {
    normalize(path).is_empty()
}

/// The directory part of `path` when its last component is a reserved name
/// (see [`is_reserved_name`]):
/// `a/link/.di-encfs` gives `a/link`, `.di-encfs` gives `""` (the descriptor
/// itself). Trailing slashes are ignored. The directory part is returned as
/// written, so the host resolves its `..` and symlinks exactly as it would
/// for the operation itself (#349).
pub fn marker_parent(path: &str) -> Option<&str> {
    let path = path.trim_end_matches('/');
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    is_reserved_name(name).then_some(parent)
}

/// Whether any component of `path` is a marker name. Used for symlink
/// targets: the directory such a link would resolve in is only known when
/// it is followed, so a link that names a marker is never created (#349).
pub fn names_marker(path: &str) -> bool {
    path.split('/').any(is_reserved_name)
}

/// What a guarded directory descriptor can tell about the directories its
/// paths lead to.
pub trait Namespace {
    /// What the host identifies a directory by (device and inode).
    type Id: PartialEq;

    /// The identity of what `path` resolves to from this descriptor, with
    /// every symlink followed; `""` is the descriptor itself. `None` when the
    /// lookup fails.
    fn identity(&self, path: &str) -> Option<Self::Id>;
}

/// Whether `path`, relative to `dir`, may name a marker file of the preopen
/// whose root has identity `root` (`None` when unknown).
///
/// The directory that would hold the marker name is resolved by the host,
/// so `.`, `..` and symlinks anywhere in the path, including chains of them,
/// are followed exactly as the operation would follow them. If it is the
/// root, or cannot be identified, the path is refused (#207, #349).
pub fn may_reach_marker<N: Namespace>(
    dir: &N,
    root: Option<&N::Id>,
    dir_is_root: bool,
    path: &str,
) -> bool {
    if dir_is_root && is_marker_path(path) {
        return true;
    }
    let Some(parent) = marker_parent(path) else {
        return false;
    };
    match (root, dir.identity(parent)) {
        (Some(root), Some(id)) => id == *root,
        _ => true,
    }
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
///
/// An empty or short marker in a root without data is what a crash during the
/// first start could leave behind before markers were written atomically; it
/// is initialized again rather than reported as corrupt.
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
    if marker.len() < MARKER_LEN && !has_data {
        return RootDecision::Initialize;
    }
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
        // A full-length marker with the wrong magic is corrupt even in an empty root.
        assert_eq!(
            decide(&ring(Some(1), None), Some(&bad_magic), false),
            RootDecision::Locked(Lock::CorruptMarker)
        );
    }

    #[test]
    fn a_partial_marker_in_an_empty_root_is_initialized_again() {
        // W3 of the #201 review: a crash during the first start.
        for m in [&b""[..], &marker(1)[..MARKER_LEN - 1], &marker(1)[..8]] {
            assert_eq!(
                decide(&ring(Some(1), None), Some(m), false),
                RootDecision::Initialize
            );
        }
        assert_eq!(
            decide(&ring(None, None), Some(b""), false),
            RootDecision::Locked(Lock::NoKey)
        );
        assert!(is_volume_metadata(MARKER_NAME) && is_volume_metadata(MARKER_TMP_NAME));
    }

    #[test]
    fn marker_paths_are_recognized_after_normalization() {
        for path in [
            ".di-encfs",
            "./.di-encfs",
            ".//.di-encfs",
            "pglite/../.di-encfs",
            "pglite/data/../../.di-encfs",
            "/.di-encfs",
            ".di-encfs.tmp",
            "../.di-encfs",
        ] {
            assert!(is_marker_path(path), "{path}");
        }
        for path in [
            "pglite/.di-encfs",
            ".di-encfs2",
            "pglite",
            "",
            ".",
            "a/../b/.di-encfs",
        ] {
            assert!(!is_marker_path(path), "{path}");
        }
    }

    #[test]
    fn root_paths_are_recognized_after_normalization() {
        // #207: `open-at(".")` on the root must yield a guarded root descriptor.
        for path in [
            "",
            ".",
            "./",
            "/",
            "//",
            "..",
            "pglite/..",
            "pglite/data/../..",
            "./pglite/../.",
        ] {
            assert!(is_root_path(path), "{path}");
        }
        for path in [
            "pglite",
            "pglite/data/..",
            "./pglite",
            ".di-encfs",
            "lost+found",
        ] {
            assert!(!is_root_path(path), "{path}");
        }
    }

    /// Directory identities as the host would report them after following
    /// every symlink: `a/up` links to the root, `a/c1 -> c2 -> ..` is a chain
    /// to the root, `a/ok` links to `b`, an ordinary directory.
    struct Tree(&'static [(&'static str, u32)]);

    impl Namespace for Tree {
        type Id = u32;

        fn identity(&self, path: &str) -> Option<u32> {
            self.0.iter().find(|(p, _)| *p == path).map(|(_, id)| *id)
        }
    }

    const ROOT: u32 = 1;
    const FROM_ROOT: Tree = Tree(&[
        ("", ROOT),
        ("a", 2),
        ("a/up", ROOT),
        ("a/up/", ROOT),
        ("a/up/.", ROOT),
        ("a/c1", ROOT),
        ("a/c2", ROOT),
        ("a/c1/a/c1", ROOT),
        ("a/ok", 3),
        ("b", 3),
        ("pglite/..", ROOT),
    ]);
    /// The same tree seen from a descriptor opened on `a`.
    const FROM_A: Tree = Tree(&[("", 2), ("up", ROOT), ("c1", ROOT), ("ok", 3)]);
    /// A descriptor opened on `a/up`: the root under another path.
    const FROM_UP: Tree = Tree(&[("", ROOT), ("ok", 2)]);

    #[test]
    fn marker_parents_are_split_off_as_written() {
        assert_eq!(marker_parent(".di-encfs"), Some(""));
        assert_eq!(marker_parent(".di-encfs.tmp"), Some(""));
        assert_eq!(marker_parent("a/up/.di-encfs"), Some("a/up"));
        assert_eq!(marker_parent("a/up/.di-encfs//"), Some("a/up"));
        assert_eq!(marker_parent("a/up//.di-encfs"), Some("a/up/"));
        assert_eq!(marker_parent("a/../.di-encfs"), Some("a/.."));
        assert_eq!(marker_parent("a/.di-encfs/x"), None);
        assert_eq!(marker_parent("a/up/.di-encfs2"), None);
        assert_eq!(marker_parent("a/up"), None);
        assert_eq!(marker_parent(""), None);
        assert!(names_marker("../.di-encfs") && names_marker("x/.di-encfs.tmp/y"));
        assert!(!names_marker("..") && !names_marker("data/.di-encfs2"));
    }

    #[test]
    fn marker_names_are_reserved_in_any_case() {
        for name in [
            ".di-encfs",
            ".DI-ENCFS",
            ".Di-EncFs",
            ".di-encfs.TMP",
            ".DI-ENCFS.TMP",
        ] {
            assert!(is_reserved_name(name), "{name}");
        }
        for name in [".di-encfs2", "di-encfs", ".di-encfs.tmp2", ".dı-encfs"] {
            assert!(!is_reserved_name(name), "{name}");
        }
        // Only the exact names are the marker files encfs writes and skips.
        assert!(is_marker_name(".di-encfs") && !is_marker_name(".DI-ENCFS"));
        assert!(is_marker_path(".DI-ENCFS") && is_marker_path("pglite/../.Di-Encfs.Tmp"));
        assert_eq!(marker_parent("a/up/.DI-ENCFS"), Some("a/up"));
        assert!(names_marker("../.DI-ENCFS"));
        assert!(may_reach_marker(
            &FROM_ROOT,
            Some(&ROOT),
            true,
            "a/up/.DI-ENCFS"
        ));
        assert!(may_reach_marker(
            &FROM_A,
            Some(&ROOT),
            false,
            "c1/.di-ENCFS.tmp"
        ));
        assert!(!may_reach_marker(
            &FROM_ROOT,
            Some(&ROOT),
            true,
            "a/ok/.DI-ENCFS"
        ));
    }

    #[test]
    fn a_symlink_anywhere_in_the_path_cannot_reach_the_marker() {
        // #349: a symlink to the root partway through the path, and a chain.
        for path in [
            ".di-encfs",
            "a/up/.di-encfs",
            "a/up/.di-encfs.tmp",
            "a/up/.di-encfs/",
            "a/up//.di-encfs",
            "a/up/./.di-encfs",
            "a/c1/.di-encfs",
            "a/c2/.di-encfs",
            "a/c1/a/c1/.di-encfs",
            "pglite/../.di-encfs",
        ] {
            assert!(
                may_reach_marker(&FROM_ROOT, Some(&ROOT), true, path),
                "{path}"
            );
        }
        // From a descriptor that is not the root, through a link to it.
        for path in ["up/.di-encfs", "c1/.di-encfs", "up/.di-encfs.tmp"] {
            assert!(
                may_reach_marker(&FROM_A, Some(&ROOT), false, path),
                "{path}"
            );
        }
        // A descriptor that names the root under another path.
        assert!(may_reach_marker(&FROM_UP, Some(&ROOT), false, ".di-encfs"));
        assert!(!may_reach_marker(
            &FROM_UP,
            Some(&ROOT),
            false,
            "ok/.di-encfs"
        ));
    }

    #[test]
    fn ordinary_paths_and_symlinks_keep_working() {
        for path in [
            "a/ok/.di-encfs",
            "b/.di-encfs",
            "a/up",
            "a/up/pglite",
            "a/ok/file",
            "a/c1/data",
            ".di-encfs2",
        ] {
            assert!(
                !may_reach_marker(&FROM_ROOT, Some(&ROOT), true, path),
                "{path}"
            );
        }
        assert!(!may_reach_marker(
            &FROM_A,
            Some(&ROOT),
            false,
            "ok/.di-encfs"
        ));
        assert!(!may_reach_marker(&FROM_A, Some(&ROOT), false, ".di-encfs"));
    }

    #[test]
    fn an_unknown_directory_or_root_is_refused() {
        // A failed lookup (missing directory, a link out of the preopen) and
        // an unknown root identity both fail closed, for marker names only.
        assert!(may_reach_marker(
            &FROM_ROOT,
            Some(&ROOT),
            true,
            "gone/.di-encfs"
        ));
        assert!(may_reach_marker(
            &FROM_ROOT,
            Some(&ROOT),
            true,
            "../.di-encfs"
        ));
        assert!(may_reach_marker(&FROM_A, None, false, "ok/.di-encfs"));
        assert!(!may_reach_marker(&FROM_A, None, false, "ok/file"));
        assert!(!may_reach_marker(
            &FROM_ROOT,
            Some(&ROOT),
            true,
            "gone/file"
        ));
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
