//! The key-rotation sweep: re-wrap every file header from the previous key to
//! the current one before the root marker flips (see README "Rotation").
//!
//! The sweep is strict everywhere pglite writes: a header that cannot be
//! re-wrapped aborts it, and the marker stays on the previous key. The root's
//! `lost+found` is the exception. fsck reconnects orphaned inodes there, so it
//! can hold sealed files recovered from the data directory next to fragments
//! that are not encfs files at all. That directory is swept best-effort: what
//! can be re-wrapped is, everything else is left as it was and reported, and
//! nothing there aborts the rotation (#207).
//!
//! Paths in errors and reports are relative to the preopen root, so the
//! operator can find the exact file (relation file names repeat across
//! databases).

use crate::header::{classify_in, Header, HeaderError, HeaderState, NONCE_LEN};
use crate::keys::Kek;
use crate::marker::{is_marker_name, Mode, LOST_AND_FOUND};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryType {
    Directory,
    RegularFile,
    /// Symlinks and anything else: never followed, never touched.
    Other,
}

/// A directory the sweep can walk.
pub trait Dir: Sized {
    type Error;
    type File: File<Error = Self::Error>;

    fn entries(&self) -> Result<Vec<(String, EntryType)>, Self::Error>;
    fn open_dir(&self, name: &str) -> Result<Self, Self::Error>;
    /// Open a regular file for reading and writing.
    fn open_file(&self, name: &str) -> Result<Self::File, Self::Error>;
}

/// A regular file the sweep can re-wrap.
pub trait File {
    type Error;

    fn physical_size(&self) -> Result<u64, Self::Error>;
    /// The first bytes of the file, up to [`crate::header::HEADER_USED`].
    fn read_start(&self) -> Result<Vec<u8>, Self::Error>;
    /// Overwrite the header in place and sync the file.
    fn write_header(&self, header: &Header) -> Result<(), Self::Error>;
}

/// Why the strict part of the sweep stopped. The marker is not flipped.
#[derive(Debug, PartialEq, Eq)]
pub enum SweepError<E> {
    Host(E),
    Header { path: String, error: HeaderError },
}

/// An entry under `lost+found` that was left as it was.
#[derive(Debug, PartialEq, Eq)]
pub struct Skipped {
    /// Relative to the preopen root.
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// No header: an fsck fragment, a stub, or an empty or fresh file.
    NoHeader,
    /// Sealed under a key that is neither the previous nor the current one.
    OtherKey,
    /// A header this build does not read.
    Unsupported,
    /// Under the previous key, but the wrap does not authenticate.
    Tampered,
    /// Could not be listed, opened, read or re-written.
    Io,
}

impl SkipReason {
    /// Whether the entry may still be wrapped under the previous key, so that
    /// key is still needed to recover it.
    pub fn may_need_previous_key(self) -> bool {
        matches!(
            self,
            SkipReason::Unsupported | SkipReason::Tampered | SkipReason::Io
        )
    }

    pub fn describe(self) -> &'static str {
        match self {
            SkipReason::NoHeader => "no encryption header (not an encfs file, or no data)",
            SkipReason::OtherKey => {
                "wrapped under a key that is neither the current nor the previous one"
            }
            SkipReason::Unsupported => "unsupported header; it may still be under the previous key",
            SkipReason::Tampered => {
                "its key check value is the previous key's but the file key does not authenticate"
            }
            SkipReason::Io => {
                "could not be read or re-written; it may still be under the previous key"
            }
        }
    }
}

/// What a completed sweep did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Sweep {
    pub rewrapped: usize,
    pub skipped: Vec<Skipped>,
}

impl Sweep {
    /// Skipped entries that may still need the previous key.
    pub fn stranded(&self) -> usize {
        self.skipped
            .iter()
            .filter(|s| s.reason.may_need_previous_key())
            .count()
    }

    /// The line logged once the marker has flipped. It only says the previous
    /// key can be removed when nothing may still be wrapped under it.
    pub fn completion_message(&self) -> String {
        let mut message = format!(
            "key rotation complete: re-wrapped {} file keys",
            self.rewrapped
        );
        if !self.skipped.is_empty() {
            message.push_str(&format!(
                "; left {} entries in {LOST_AND_FOUND} as they were",
                self.skipped.len()
            ));
        }
        match self.stranded() {
            0 => message.push_str("; DI_PGLITE_KEY_PREVIOUS can be removed"),
            n => message.push_str(&format!(
                "; {n} of them may still be wrapped under the previous key: keep a copy of \
                 DI_PGLITE_KEY_PREVIOUS until they are recovered or deleted"
            )),
        }
        message
    }
}

/// Re-wrap every header under the preopen root `root`, a directory of
/// `mode`, from `from` to `to`. Headers already under `to` are skipped, so an
/// interrupted sweep resumes. The markers are not visited; `lost+found` at
/// the root is swept best-effort. A re-wrap writes only the header's used
/// bytes, so a codec-4 file's watermark pages are never touched.
pub fn rewrap_tree<D: Dir>(
    root: &D,
    mode: Mode,
    from: &Kek,
    to: &Kek,
    nonce: &mut dyn FnMut() -> [u8; NONCE_LEN],
) -> Result<Sweep, SweepError<D::Error>> {
    let mut sweeper = Sweeper {
        mode,
        from,
        to,
        nonce,
        sweep: Sweep::default(),
    };
    sweeper.strict(root, "")?;
    Ok(sweeper.sweep)
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

enum Outcome {
    Rewrapped,
    AlreadyCurrent,
    NoHeader,
}

enum Failure<E> {
    Host(E),
    Header(HeaderError),
}

struct Sweeper<'a> {
    mode: Mode,
    from: &'a Kek,
    to: &'a Kek,
    nonce: &'a mut dyn FnMut() -> [u8; NONCE_LEN],
    sweep: Sweep,
}

impl Sweeper<'_> {
    fn strict<D: Dir>(&mut self, dir: &D, prefix: &str) -> Result<(), SweepError<D::Error>> {
        for (name, kind) in dir.entries().map_err(SweepError::Host)? {
            let path = join(prefix, &name);
            if prefix.is_empty() {
                if is_marker_name(&name) {
                    continue;
                }
                if name == LOST_AND_FOUND {
                    self.salvage_entry(dir, &name, kind, &path);
                    continue;
                }
            }
            match kind {
                EntryType::Directory => {
                    let sub = dir.open_dir(&name).map_err(SweepError::Host)?;
                    self.strict(&sub, &path)?;
                }
                EntryType::RegularFile => {
                    let file = dir.open_file(&name).map_err(SweepError::Host)?;
                    match self.rewrap_file(&file) {
                        Ok(Outcome::Rewrapped) => self.sweep.rewrapped += 1,
                        // A file left fresh by a crash has no key to re-wrap.
                        Ok(Outcome::AlreadyCurrent | Outcome::NoHeader) => {}
                        Err(Failure::Host(error)) => return Err(SweepError::Host(error)),
                        Err(Failure::Header(error)) => {
                            return Err(SweepError::Header { path, error })
                        }
                    }
                }
                EntryType::Other => {}
            }
        }
        Ok(())
    }

    /// Best-effort sweep of one entry under `lost+found`: never fails.
    fn salvage_entry<D: Dir>(&mut self, dir: &D, name: &str, kind: EntryType, path: &str) {
        let reason = match kind {
            EntryType::Directory => match dir.open_dir(name) {
                Ok(sub) => return self.salvage_dir(&sub, path),
                Err(_) => SkipReason::Io,
            },
            EntryType::RegularFile => match dir.open_file(name).map(|f| self.rewrap_file(&f)) {
                Ok(Ok(Outcome::Rewrapped)) => return self.sweep.rewrapped += 1,
                Ok(Ok(Outcome::AlreadyCurrent)) => return,
                Ok(Ok(Outcome::NoHeader)) => SkipReason::NoHeader,
                Ok(Err(Failure::Header(error))) => match error {
                    HeaderError::NotEncrypted | HeaderError::Stub => SkipReason::NoHeader,
                    HeaderError::WrongKey => SkipReason::OtherKey,
                    HeaderError::Unsupported { .. } => SkipReason::Unsupported,
                    HeaderError::Tampered => SkipReason::Tampered,
                },
                Ok(Err(Failure::Host(_))) | Err(_) => SkipReason::Io,
            },
            EntryType::Other => return,
        };
        self.sweep.skipped.push(Skipped {
            path: path.to_string(),
            reason,
        });
    }

    fn salvage_dir<D: Dir>(&mut self, dir: &D, prefix: &str) {
        match dir.entries() {
            Ok(entries) => {
                for (name, kind) in entries {
                    self.salvage_entry(dir, &name, kind, &join(prefix, &name));
                }
            }
            Err(_) => self.sweep.skipped.push(Skipped {
                path: prefix.to_string(),
                reason: SkipReason::Io,
            }),
        }
    }

    fn rewrap_file<F: File>(&mut self, file: &F) -> Result<Outcome, Failure<F::Error>> {
        let physical = file.physical_size().map_err(Failure::Host)?;
        if physical == 0 {
            return Ok(Outcome::NoHeader);
        }
        let start = file.read_start().map_err(Failure::Host)?;
        let header = match classify_in(&start, physical, self.mode).map_err(Failure::Header)? {
            HeaderState::Fresh => return Ok(Outcome::NoHeader),
            HeaderState::Sealed(header) => header,
        };
        if self.to.matches(header.kcv()) {
            return Ok(Outcome::AlreadyCurrent);
        }
        let rewrapped = header
            .rewrap(self.from, self.to, &(self.nonce)())
            .map_err(Failure::Header)?;
        file.write_header(&rewrapped).map_err(Failure::Host)?;
        Ok(Outcome::Rewrapped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::Codec;
    use crate::header::{HEADER_LEN, HEADER_USED};
    use crate::marker::{MARKER_NAME, MARKER_TMP_NAME};
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// An in-memory tree: directories, files, and entries that fail to open.
    enum Node {
        Dir(BTreeMap<String, Node>),
        File(RefCell<Vec<u8>>),
        Symlink,
        Unreadable(EntryType),
    }

    struct MemDir<'a>(&'a BTreeMap<String, Node>);
    struct MemFile<'a>(&'a RefCell<Vec<u8>>);

    impl<'a> Dir for MemDir<'a> {
        type Error = &'static str;
        type File = MemFile<'a>;

        fn entries(&self) -> Result<Vec<(String, EntryType)>, Self::Error> {
            Ok(self
                .0
                .iter()
                .map(|(name, node)| {
                    let kind = match node {
                        Node::Dir(_) => EntryType::Directory,
                        Node::File(_) => EntryType::RegularFile,
                        Node::Symlink => EntryType::Other,
                        Node::Unreadable(kind) => *kind,
                    };
                    (name.clone(), kind)
                })
                .collect())
        }

        fn open_dir(&self, name: &str) -> Result<Self, Self::Error> {
            match self.0.get(name) {
                Some(Node::Dir(entries)) => Ok(MemDir(entries)),
                _ => Err("access"),
            }
        }

        fn open_file(&self, name: &str) -> Result<MemFile<'a>, Self::Error> {
            match self.0.get(name) {
                Some(Node::File(bytes)) => Ok(MemFile(bytes)),
                _ => Err("access"),
            }
        }
    }

    impl File for MemFile<'_> {
        type Error = &'static str;

        fn physical_size(&self) -> Result<u64, Self::Error> {
            Ok(self.0.borrow().len() as u64)
        }

        fn read_start(&self) -> Result<Vec<u8>, Self::Error> {
            let bytes = self.0.borrow();
            Ok(bytes[..bytes.len().min(HEADER_USED)].to_vec())
        }

        fn write_header(&self, header: &Header) -> Result<(), Self::Error> {
            self.0.borrow_mut()[..HEADER_USED].copy_from_slice(header.as_bytes());
            Ok(())
        }
    }

    fn kek(b: u8) -> Kek {
        Kek::derive(&[b; 32])
    }

    /// A sealed file under `key` with one data unit.
    fn sealed(key: u8, id: u8) -> Node {
        let header = Header::seal(&kek(key), Codec::NEW_FILES, &[id; 16], &[id; 64], &[7; 24]);
        let mut bytes = vec![0u8; HEADER_LEN as usize + 4096];
        bytes[..HEADER_USED].copy_from_slice(header.as_bytes());
        Node::File(RefCell::new(bytes))
    }

    fn file(bytes: &[u8]) -> Node {
        Node::File(RefCell::new(bytes.to_vec()))
    }

    fn dir<const N: usize>(entries: [(&str, Node); N]) -> Node {
        Node::Dir(
            entries
                .into_iter()
                .map(|(name, node)| (name.to_string(), node))
                .collect(),
        )
    }

    fn entries(node: &Node) -> &BTreeMap<String, Node> {
        match node {
            Node::Dir(entries) => entries,
            _ => panic!("not a directory"),
        }
    }

    fn at<'a>(node: &'a Node, path: &str) -> &'a Node {
        path.split('/')
            .fold(node, |node, name| &entries(node)[name])
    }

    fn kcv_of(node: &Node) -> Vec<u8> {
        match node {
            Node::File(bytes) => bytes.borrow()[32..48].to_vec(),
            _ => panic!("not a file"),
        }
    }

    fn sweep(root: &Node) -> Result<Sweep, SweepError<&'static str>> {
        sweep_in(root, Mode::Xts)
    }

    fn sweep_in(root: &Node, mode: Mode) -> Result<Sweep, SweepError<&'static str>> {
        rewrap_tree(&MemDir(entries(root)), mode, &kek(1), &kek(2), &mut || {
            [9; NONCE_LEN]
        })
    }

    #[test]
    fn integrity_directories_rotate_without_touching_the_watermark_pages() {
        // A codec-4 file: header page, two record pages, one pair. Rotation
        // rewrites the header's used bytes only (#200 section 10).
        let header = Header::seal(&kek(1), Codec::TwoSlotAead, &[4; 16], &[4; 64], &[7; 24]);
        let mut bytes: Vec<u8> = (0..12288 + 200).map(|i| (i % 251) as u8).collect();
        bytes[..HEADER_USED].copy_from_slice(header.as_bytes());
        bytes[HEADER_USED..HEADER_LEN as usize].fill(0);
        let tree = dir([
            ("PG_VERSION", file(&bytes)),
            // A crash during a birth in an integrity directory: zero header,
            // no room for a pair yet (C8a). XTS would refuse it as plaintext.
            ("fresh", file(&[0u8; 12288])),
        ]);
        let swept = sweep_in(&tree, Mode::Integrity).unwrap();
        assert_eq!(swept.rewrapped, 1);
        let Node::File(after) = at(&tree, "PG_VERSION") else {
            panic!("not a file")
        };
        let after = after.borrow();
        assert_eq!(&after[32..48], kek(2).kcv());
        assert_eq!(after[HEADER_USED..], bytes[HEADER_USED..]);
        let rotated = Header::parse(&after[..HEADER_USED]).unwrap();
        assert_eq!(rotated.codec(), Codec::TwoSlotAead);
        assert_eq!(rotated.open(&kek(2)).unwrap().as_slice(), &[4; 64]);
        // The same zero file is refused in an XTS directory.
        let tree = dir([("fresh", file(&[0u8; 12288]))]);
        assert_eq!(
            sweep_in(&tree, Mode::Xts).unwrap_err(),
            SweepError::Header {
                path: "fresh".into(),
                error: HeaderError::NotEncrypted
            }
        );
    }

    fn data_tree(lost_and_found: Node) -> Node {
        dir([
            (MARKER_NAME, file(b"DIPGKEY1 not a header")),
            (MARKER_TMP_NAME, file(b"x")),
            (
                "pglite",
                dir([
                    ("PG_VERSION", sealed(1, 1)),
                    ("fresh", file(&[0u8; 100])),
                    ("empty", file(b"")),
                    ("current", sealed(2, 2)),
                    ("link", Node::Symlink),
                ]),
            ),
            ("lost+found", lost_and_found),
        ])
    }

    #[test]
    fn rewraps_every_header_and_resumes() {
        let root = data_tree(dir([]));
        let done = sweep(&root).unwrap();
        assert_eq!(done.rewrapped, 1);
        assert!(done.skipped.is_empty());
        assert_eq!(kcv_of(at(&root, "pglite/PG_VERSION")), kek(2).kcv());
        // The markers are left alone; a resumed sweep finds nothing to do.
        assert_eq!(sweep(&root).unwrap(), Sweep::default());
        assert!(done
            .completion_message()
            .ends_with("re-wrapped 1 file keys; DI_PGLITE_KEY_PREVIOUS can be removed"));
    }

    #[test]
    fn a_strict_failure_names_the_path_from_the_root() {
        // W1 of the #342 review: relation file names repeat across databases,
        // so the operator must get the full relative path.
        let root = dir([(
            "pglite",
            dir([(
                "data",
                dir([(
                    "base",
                    dir([
                        ("1", dir([("1259", sealed(1, 1))])),
                        ("5", dir([("1259", file(b"stub"))])),
                    ]),
                )]),
            )]),
        )]);
        assert_eq!(
            sweep(&root),
            Err(SweepError::Header {
                path: "pglite/data/base/5/1259".into(),
                error: HeaderError::Stub,
            })
        );
        let root = dir([("pglite", dir([("other", sealed(3, 1))]))]);
        assert_eq!(
            sweep(&root),
            Err(SweepError::Header {
                path: "pglite/other".into(),
                error: HeaderError::WrongKey,
            })
        );
        let root = dir([("pglite", Node::Unreadable(EntryType::Directory))]);
        assert_eq!(sweep(&root), Err(SweepError::Host("access")));
    }

    #[test]
    fn lost_and_found_is_salvaged_without_aborting() {
        // fsck reconnects orphaned encfs files as #<inode>: they are re-wrapped.
        // Fragments and anything else are counted and left as they were.
        let mut tampered = sealed(1, 4);
        if let Node::File(bytes) = &mut tampered {
            bytes.get_mut()[100] ^= 1;
        }
        let root = data_tree(dir([
            ("#12", sealed(1, 3)),
            ("#13", file(b"fsck fragment")),
            ("#14", tampered),
            ("#15", sealed(3, 5)),
            ("#16", Node::Unreadable(EntryType::RegularFile)),
            (
                "#17",
                dir([("#18", sealed(1, 6)), ("#19", file(&[0u8; 10]))]),
            ),
            ("#20", Node::Unreadable(EntryType::Directory)),
            ("#21", sealed(2, 7)),
            ("#22", Node::Symlink),
        ]));
        let done = sweep(&root).unwrap();
        assert_eq!(done.rewrapped, 3, "PG_VERSION, #12, #17/#18");
        assert_eq!(kcv_of(at(&root, "lost+found/#12")), kek(2).kcv());
        assert_eq!(kcv_of(at(&root, "lost+found/#17/#18")), kek(2).kcv());
        let skipped: Vec<(&str, SkipReason)> = done
            .skipped
            .iter()
            .map(|s| (s.path.as_str(), s.reason))
            .collect();
        assert_eq!(
            skipped,
            [
                ("lost+found/#13", SkipReason::NoHeader),
                ("lost+found/#14", SkipReason::Tampered),
                ("lost+found/#15", SkipReason::OtherKey),
                ("lost+found/#16", SkipReason::Io),
                ("lost+found/#17/#19", SkipReason::NoHeader),
                ("lost+found/#20", SkipReason::Io),
            ]
        );
        // The garbage fragment is untouched.
        match at(&root, "lost+found/#13") {
            Node::File(bytes) => assert_eq!(&bytes.borrow()[..], b"fsck fragment"),
            _ => unreachable!(),
        }
        // #14, #16 and #20 may still be under the previous key.
        assert_eq!(done.stranded(), 3);
        let message = done.completion_message();
        assert!(message.contains("re-wrapped 3 file keys; left 6 entries in lost+found"));
        assert!(message.contains("3 of them may still be wrapped under the previous key"));
        assert!(!message.contains("can be removed"), "{message}");
    }

    #[test]
    fn only_garbage_in_lost_and_found_still_allows_removing_the_previous_key() {
        let root = data_tree(dir([
            ("#13", file(b"fsck fragment")),
            ("#15", sealed(3, 5)),
        ]));
        let done = sweep(&root).unwrap();
        assert_eq!(done.skipped.len(), 2);
        assert_eq!(done.stranded(), 0);
        assert!(done.completion_message().ends_with(
            "left 2 entries in lost+found as they were; DI_PGLITE_KEY_PREVIOUS can be removed"
        ));
        // An unreadable lost+found itself is reported, and keeps the previous key.
        let root = data_tree(Node::Unreadable(EntryType::Directory));
        let done = sweep(&root).unwrap();
        assert_eq!(
            done.skipped,
            [Skipped {
                path: "lost+found".into(),
                reason: SkipReason::Io
            }]
        );
        assert!(!done.completion_message().contains("can be removed"));
    }

    #[test]
    fn lost_and_found_is_only_special_at_the_root() {
        let root = dir([(
            "pglite",
            dir([("lost+found", dir([("x", file(b"plain"))]))]),
        )]);
        assert_eq!(
            sweep(&root),
            Err(SweepError::Header {
                path: "pglite/lost+found/x".into(),
                error: HeaderError::Stub,
            })
        );
    }

    #[test]
    fn reasons_that_may_need_the_previous_key() {
        for (reason, needed) in [
            (SkipReason::NoHeader, false),
            (SkipReason::OtherKey, false),
            (SkipReason::Unsupported, true),
            (SkipReason::Tampered, true),
            (SkipReason::Io, true),
        ] {
            assert_eq!(reason.may_need_previous_key(), needed, "{reason:?}");
            assert!(!reason.describe().is_empty());
        }
    }
}
