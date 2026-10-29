//! The key marker at each preopen root and the decision it drives.
//!
//! Before pglite may touch a preopened directory, its `.di-encfs` marker
//! (magic + KCV) is compared with the configured keys. Every refusal locks the
//! whole preopen before any mutation. That matters: pglite re-extracts its
//! runtime files with `open(CREATE|TRUNCATE)` at every start, so a per-file
//! check alone would let a wrong-key start overwrite correctly encrypted files.
//!
//! The marker also fixes the directory's mode ([`Mode`]); nothing else does
//! (#200, design note section 9.1):
//!
//! - `DIPGKEY1 ‖ KCV` (24 bytes): an XTS directory (codecs 2 and 3).
//! - `DIPGKEY2 ‖ KCV ‖ flags` (25 bytes): an integrity directory. `flags` is a
//!   bit set: bit 0 = codec 4, bit 1 = reservation. A keyed marker has flags
//!   `0b01`. The reservation ([`RESERVATION`]: `DIPGKEY2`, 16 zero bytes,
//!   `0b11`) carries no key material: the platform writes it into a new, empty
//!   directory to ask for integrity. Any other flag bit fails closed.
//!
//! Every `DIPGKEY2` form is at least [`MARKER_LEN`] bytes long, so builds that
//! do not know it lock it as corrupt instead of initialising an XTS directory
//! over it. This build reads integrity directories but cannot create them: a
//! reservation in a root without data locks with [`Lock::IntegrityUnsupported`].

use crate::codec::Codec;
use crate::header::HEADER_LEN;
use crate::keys::{Kcv, KeyRing, KCV_LEN};
use crate::slots::PAIRS_START;

/// File name of the marker, hidden from listings of the root.
pub const MARKER_NAME: &str = ".di-encfs";
/// The marker is written here, synced, then renamed over [`MARKER_NAME`], so a
/// crash never leaves a partial marker in place.
pub const MARKER_TMP_NAME: &str = ".di-encfs.tmp";
pub const MARKER_MAGIC: &[u8; 8] = b"DIPGKEY1";
pub const MARKER_LEN: usize = MARKER_MAGIC.len() + KCV_LEN;
/// Magic of the integrity markers, keyed and reservation.
pub const MARKER2_MAGIC: &[u8; 8] = b"DIPGKEY2";
/// `DIPGKEY2 ‖ KCV ‖ flags`.
pub const MARKER2_LEN: usize = MARKER_LEN + 1;
/// Flag bit 0: the directory's files are codec 4.
pub const FLAG_CODEC4: u8 = 0b01;
/// Flag bit 1: a reservation; the KCV is unset and must be zero.
pub const FLAG_RESERVATION: u8 = 0b10;
/// How many bytes of a marker to read: one more than the longest form, so a
/// longer file is never mistaken for a valid marker.
pub const MARKER_READ_LEN: usize = MARKER2_LEN + 1;

/// The integrity reservation: `DIPGKEY2`, a zero KCV and flags `0b11`.
pub const RESERVATION: [u8; MARKER2_LEN] = *b"DIPGKEY2\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\x03";

/// How a directory's files are encrypted, fixed by its marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// AES-256-XTS files, codec 2 or 3 (`DIPGKEY1`).
    Xts,
    /// Codec-4 files only (keyed `DIPGKEY2`, #200).
    Integrity,
}

impl Mode {
    /// Whether a file of `codec` may live in a directory of this mode: a
    /// directory never mixes XTS and codec-4 files.
    pub fn admits(self, codec: Codec) -> bool {
        match self {
            Mode::Xts => codec.is_xts(),
            Mode::Integrity => codec == Codec::TwoSlotAead,
        }
    }

    /// A file no longer than this holds no data (see
    /// [`crate::header::classify_in`]): 4096 for XTS; 12288 in an integrity
    /// directory, after the header page and the two watermark pages (C8a).
    pub fn data_start(self) -> u64 {
        match self {
            Mode::Xts => HEADER_LEN,
            Mode::Integrity => PAIRS_START,
        }
    }
}

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

/// The keyed marker of a directory of `mode` under the key with `kcv`:
/// `DIPGKEY1 ‖ KCV`, or `DIPGKEY2 ‖ KCV ‖ 0b01`. Rotation writes the marker in
/// the directory's own mode, so an integrity directory keeps its flags.
pub fn encode(mode: Mode, kcv: &Kcv) -> Vec<u8> {
    let magic = match mode {
        Mode::Xts => MARKER_MAGIC,
        Mode::Integrity => MARKER2_MAGIC,
    };
    let mut bytes = [&magic[..], kcv].concat();
    if mode == Mode::Integrity {
        bytes.push(FLAG_CODEC4);
    }
    bytes
}

/// What a marker of at least [`MARKER_LEN`] bytes is.
#[derive(Debug, PartialEq, Eq)]
enum Form<'a> {
    Keyed { mode: Mode, kcv: &'a [u8] },
    Reservation,
    Corrupt,
}

fn form(marker: &[u8]) -> Form<'_> {
    if marker.len() == MARKER_LEN && marker.starts_with(MARKER_MAGIC) {
        return Form::Keyed {
            mode: Mode::Xts,
            kcv: &marker[MARKER_MAGIC.len()..],
        };
    }
    if marker.len() != MARKER2_LEN || !marker.starts_with(MARKER2_MAGIC) {
        return Form::Corrupt;
    }
    let kcv = &marker[MARKER2_MAGIC.len()..MARKER_LEN];
    match marker[MARKER_LEN] {
        FLAG_CODEC4 => Form::Keyed {
            mode: Mode::Integrity,
            kcv,
        },
        _ if marker == RESERVATION => Form::Reservation,
        // Unknown bits, or a reservation with a KCV: fail closed.
        _ => Form::Corrupt,
    }
}

/// What to do with a preopen root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RootDecision {
    /// The marker matches the current key.
    Ready(Mode),
    /// Empty directory: write the XTS marker for the current key, then use it.
    Initialize,
    /// The marker matches the previous key: re-wrap every file header under the
    /// current key, then flip the marker in the same mode.
    Rotate(Mode),
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
    /// The marker exists but is not a marker this build knows: another magic
    /// or length, unknown `DIPGKEY2` flags, or a reservation with a KCV.
    CorruptMarker,
    /// An integrity reservation in a root without data. Initialising it needs
    /// the codec-4 writer, which this build does not have (#200).
    IntegrityUnsupported,
    /// An integrity reservation next to data: something other than encfs
    /// wrote into a reserved directory.
    ReservedWithData,
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
            Lock::IntegrityUnsupported => {
                "the data directory is reserved for integrity mode (codec 4); this build reads integrity directories but cannot initialise one, so it refuses. Deploy an encfs build with the codec-4 writer"
            }
            Lock::ReservedWithData => {
                "the data directory is reserved for integrity mode (codec 4) but already holds data that encfs did not write; refusing"
            }
        }
    }

    /// Key problems are `access` errors; data that cannot be read is `io`.
    pub fn is_access_error(self) -> bool {
        matches!(self, Lock::NoKey | Lock::WrongKey)
    }
}

/// Decide from the marker contents (`None` when absent; read up to
/// [`MARKER_READ_LEN`] bytes) and whether the root has other entries (see
/// [`is_volume_metadata`]). This is the table of section 9.1 of the #200
/// design note, for a build that reads codec 4 but cannot create it.
///
/// An empty or short marker in a root without data is what a crash during the
/// first start could leave behind before markers were written atomically; it
/// is initialized again rather than reported as corrupt. A reservation is
/// written by rename and is never short.
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
    let (mode, kcv) = match form(marker) {
        Form::Keyed { mode, kcv } => (mode, kcv),
        Form::Reservation if has_data => return RootDecision::Locked(Lock::ReservedWithData),
        Form::Reservation => return RootDecision::Locked(Lock::IntegrityUnsupported),
        Form::Corrupt => return RootDecision::Locked(Lock::CorruptMarker),
    };
    if current.matches(kcv) {
        RootDecision::Ready(mode)
    } else if keys
        .previous()
        .is_some_and(|previous| previous.matches(kcv))
    {
        RootDecision::Rotate(mode)
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
        encode(Mode::Xts, kek(b).kcv()).try_into().unwrap()
    }

    fn integrity(b: u8) -> [u8; MARKER2_LEN] {
        encode(Mode::Integrity, kek(b).kcv()).try_into().unwrap()
    }

    #[test]
    fn matching_marker_is_ready() {
        assert_eq!(
            decide(&ring(Some(1), None), Some(&marker(1)), true),
            RootDecision::Ready(Mode::Xts)
        );
        // The same key in both variables is not a rotation.
        assert_eq!(
            decide(&ring(Some(1), Some(1)), Some(&marker(1)), true),
            RootDecision::Ready(Mode::Xts)
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
            RootDecision::Rotate(Mode::Xts)
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
    fn integrity_marker_layout() {
        let keyed = integrity(1);
        assert_eq!(&keyed[..8], b"DIPGKEY2");
        assert_eq!(&keyed[8..24], kek(1).kcv());
        assert_eq!(keyed[24], 0b01);
        assert_eq!(&RESERVATION[..8], b"DIPGKEY2");
        assert_eq!(RESERVATION[8..24], [0; 16]);
        assert_eq!(RESERVATION[24], 0b11);
        assert_eq!(MARKER_READ_LEN, 26);
        // The format constraint of section 9.1: every DIPGKEY2 form is at
        // least MARKER_LEN bytes, so older builds never re-initialise it.
        assert!(keyed.len() >= MARKER_LEN && RESERVATION.len() >= MARKER_LEN);
    }

    /// The marker rule of every build before this one (`decide` at
    /// `src/marker.rs:192-221` on `origin/main` `d182bea`), frozen.
    fn decide_without_codec_4(marker: &[u8], has_data: bool) -> Option<Lock> {
        if marker.len() < MARKER_LEN && !has_data {
            return None;
        }
        (marker.len() != MARKER_LEN || !marker.starts_with(MARKER_MAGIC))
            .then_some(Lock::CorruptMarker)
    }

    #[test]
    fn older_builds_lock_every_integrity_marker() {
        // G6: a build without codec 4 refuses an integrity directory and a
        // reservation before it writes anything, with or without data.
        let mut longer = integrity(1).to_vec();
        longer.push(0);
        for m in [&integrity(1)[..], &RESERVATION[..], &longer[..]] {
            for has_data in [false, true] {
                assert_eq!(
                    decide_without_codec_4(m, has_data),
                    Some(Lock::CorruptMarker),
                    "{m:?} {has_data}"
                );
            }
        }
    }

    #[test]
    fn keyed_integrity_markers_decide_by_kcv() {
        for has_data in [false, true] {
            assert_eq!(
                decide(&ring(Some(1), None), Some(&integrity(1)), has_data),
                RootDecision::Ready(Mode::Integrity)
            );
            assert_eq!(
                decide(&ring(Some(2), Some(1)), Some(&integrity(1)), has_data),
                RootDecision::Rotate(Mode::Integrity)
            );
            assert_eq!(
                decide(&ring(Some(2), Some(3)), Some(&integrity(1)), has_data),
                RootDecision::Locked(Lock::WrongKey)
            );
            assert_eq!(
                decide(&ring(None, Some(1)), Some(&integrity(1)), has_data),
                RootDecision::Locked(Lock::NoKey)
            );
        }
    }

    #[test]
    fn a_reservation_locks_in_this_build() {
        // Reader release (section 9.3 step 1): never an XTS directory in a
        // reserved root.
        assert_eq!(
            decide(&ring(Some(1), None), Some(&RESERVATION), false),
            RootDecision::Locked(Lock::IntegrityUnsupported)
        );
        assert_eq!(
            decide(&ring(Some(1), None), Some(&RESERVATION), true),
            RootDecision::Locked(Lock::ReservedWithData)
        );
        assert_eq!(
            decide(&ring(None, None), Some(&RESERVATION), false),
            RootDecision::Locked(Lock::NoKey)
        );
        for lock in [Lock::IntegrityUnsupported, Lock::ReservedWithData] {
            assert!(!lock.is_access_error());
            assert!(lock.message().contains("integrity mode (codec 4)"));
        }
    }

    #[test]
    fn unknown_integrity_marker_forms_fail_closed() {
        let mut cases: Vec<Vec<u8>> = Vec::new();
        // Every flags byte but 0b01 and the reservation's 0b11, keyed or not.
        for flags in (0..=u8::MAX).filter(|f| *f != FLAG_CODEC4) {
            let mut keyed = integrity(1);
            keyed[MARKER_LEN] = flags;
            cases.push(keyed.to_vec());
            if flags != FLAG_CODEC4 | FLAG_RESERVATION {
                let mut reserved = RESERVATION;
                reserved[MARKER_LEN] = flags;
                cases.push(reserved.to_vec());
            }
        }
        // A reservation with a non-zero KCV, in any byte.
        for at in MARKER2_MAGIC.len()..MARKER_LEN {
            let mut reserved = RESERVATION;
            reserved[at] = 1;
            cases.push(reserved.to_vec());
        }
        // Another length: DIPGKEY2 at 24 or 26 bytes, DIPGKEY1 at 25.
        cases.push(integrity(1)[..MARKER_LEN].to_vec());
        cases.push([&integrity(1)[..], &[0]].concat());
        cases.push([&RESERVATION[..], &[0]].concat());
        cases.push([&marker(1)[..], &[FLAG_CODEC4]].concat());
        for m in &cases {
            for has_data in [false, true] {
                assert_eq!(
                    decide(&ring(Some(1), None), Some(m), has_data),
                    RootDecision::Locked(Lock::CorruptMarker),
                    "{m:?} {has_data}"
                );
            }
        }
    }

    #[test]
    fn mode_admits_only_its_own_codecs() {
        assert!(Mode::Xts.admits(Codec::XtsStealing) && Mode::Xts.admits(Codec::XtsTail));
        assert!(!Mode::Xts.admits(Codec::TwoSlotAead));
        assert!(Mode::Integrity.admits(Codec::TwoSlotAead));
        assert!(!Mode::Integrity.admits(Codec::XtsStealing));
        assert!(!Mode::Integrity.admits(Codec::XtsTail));
        assert_eq!(Mode::Xts.data_start(), 4096);
        assert_eq!(Mode::Integrity.data_start(), 12288);
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
