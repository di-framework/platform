//! The WASI glue: re-exports the interfaces pglite imports and serves every
//! regular file under a preopen through [`crate::file`].
//!
//! - Directories, names, symlinks and metadata pass through unchanged, except
//!   that the root's markers are out of reach (see [`marker::may_reach_marker`]).
//! - Host streams (stdio) and host pollables pass through. File streams are
//!   served from decrypted memory, with always-ready pollables.
//! - `wasi:cli/environment` is re-exported only to hide the key variables from
//!   the engine.
//! - Single-threaded, one instance per data directory: the same exclusive
//!   ownership pglite already requires. File headers are created and the
//!   cipher cache is filled without locking.
//! - Each preopen's marker fixes its mode ([`Mode`]). An XTS directory holds
//!   codec-2/3 files only; an integrity directory holds codec-4 files only
//!   (#200). A reservation marker in a root without data initialises an
//!   integrity directory; nothing else, no environment variable included,
//!   selects the mode.
//! - Codec-4 files keep per-file state ([`FileState`], design note 6.1),
//!   shared by every descriptor of the inode and keyed by its host identity
//!   (`metadata-hash`) and file id. It is kept while a descriptor is open or
//!   the file is dirty, and dropped when encfs unlinks or renames over the
//!   inode's last name.

mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "encfs",
        generate_all,
    });
}

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use zeroize::{Zeroize, Zeroizing};

use bindings::exports::wasi::cli::environment as xenv;
use bindings::exports::wasi::cli::stderr as xstderr;
use bindings::exports::wasi::cli::stdin as xstdin;
use bindings::exports::wasi::cli::stdout as xstdout;
use bindings::exports::wasi::clocks::monotonic_clock as xmono;
use bindings::exports::wasi::filesystem::preopens as xpre;
use bindings::exports::wasi::filesystem::types as xfs;
use bindings::exports::wasi::io::error as xerr;
use bindings::exports::wasi::io::poll as xpoll;
use bindings::exports::wasi::io::streams as xs;

use bindings::wasi::cli::environment as henv;
use bindings::wasi::cli::stderr as hstderr;
use bindings::wasi::cli::stdin as hstdin;
use bindings::wasi::cli::stdout as hstdout;
use bindings::wasi::clocks::monotonic_clock as hmono;
use bindings::wasi::filesystem::preopens as hpre;
use bindings::wasi::filesystem::types as hfs;
use bindings::wasi::io::error as herr;
use bindings::wasi::io::poll as hpoll;
use bindings::wasi::io::streams as hs;
use bindings::wasi::random::random as hrand;

use xfs::ErrorCode;

use crate::codec::{Codec, UnitCipher};
use crate::file::{logical_size, EncryptedFile, FileError, Storage};
use crate::header::{
    classify_in, FileId, Header, HeaderError, HeaderState, DEK_LEN, HEADER_LEN, HEADER_USED,
    NONCE_LEN,
};
use crate::keys::{is_key_variable, Kek, KeyRing};
use crate::marker::{
    self, Lock, Mode, RootDecision, MARKER_NAME, MARKER_READ_LEN, MARKER_TMP_NAME,
};
use crate::rotation;
use crate::slots::{SlotError, SlotFile, SlotKeys};
use crate::writer::{give_birth, Durable, FileState, IntegrityFile};

type R<T> = Result<T, ErrorCode>;

/// Lets a deploy check that a composed provider really contains this layer;
/// the section survives `wac plug`, which nests the component unchanged.
/// `write-codec=N`: the codec this build creates new files with in XTS
/// directories. 3 (#206) can only be read by builds that know codec 3.
/// `read-codecs=2,3,4 integrity=1`: this build reads codec 4 and creates
/// integrity directories from a reservation (#200, design note 9.3).
/// Advisory: nothing parses the value yet.
#[used]
#[link_section = "di-framework:pglite-encfs"]
static BUILD_MARKER: [u8; 70] = if cfg!(feature = "write-codec-3") {
    *b"format=1 codec=aes-256-xts write-codec=3 read-codecs=2,3,4 integrity=1"
} else {
    *b"format=1 codec=aes-256-xts write-codec=2 read-codecs=2,3,4 integrity=1"
};

/// Not read by encfs: the platform chooses the mode with a reservation
/// marker (design note 9.1). Its presence is only logged.
const IGNORED_INTEGRITY_VARIABLE: &str = "DI_PGLITE_INTEGRITY";

/// Write buffers that stream writers may hand over at once.
const STREAM_WRITE_BUDGET: u64 = 1 << 20;

// ------------------------------------------------------------------ state

struct State {
    keys: KeyRing,
    /// Full header bytes → unwrapped cipher. Keyed by the whole header, not
    /// the file id, so every header in use has been authenticated.
    ciphers: RefCell<BTreeMap<[u8; HEADER_USED], Rc<FileCipher>>>,
}

/// The keys of one file, by its codec.
enum FileCipher {
    /// Codecs 2 and 3 (boxed: the AES key schedules dwarf the slot keys).
    Xts(Box<UnitCipher>),
    /// Codec 4: the slot and record keys, and the file id they bind to.
    Slots { keys: SlotKeys, file_id: FileId },
}

impl FileCipher {
    fn new(header: &Header, dek: &[u8; DEK_LEN]) -> FileCipher {
        match header.codec() {
            Codec::TwoSlotAead => FileCipher::Slots {
                keys: SlotKeys::derive(dek),
                file_id: header.file_id(),
            },
            codec => FileCipher::Xts(Box::new(UnitCipher::new(codec, dek))),
        }
    }
}

thread_local! {
    static STATE: OnceCell<Rc<State>> = const { OnceCell::new() };
    static LOGGED: RefCell<BTreeSet<&'static str>> = const { RefCell::new(BTreeSet::new()) };
    /// The state of each codec-4 file in use, by the host identity of its
    /// inode (design note 6.1).
    static FILES: RefCell<BTreeMap<DirId, Rc<RefCell<FileState>>>> =
        const { RefCell::new(BTreeMap::new()) };
    /// Inodes in an integrity directory whose host sync failed while encfs
    /// held no state for them (A3, 6.5): every state filed for them later is
    /// fail-stopped, and no birth runs on them, until restart.
    static FAIL_STOPPED: RefCell<BTreeSet<DirId>> = const { RefCell::new(BTreeSet::new()) };
}

fn is_fail_stopped(id: &DirId) -> bool {
    FAIL_STOPPED.with(|failed| failed.borrow().contains(id))
}

/// Keys are read from the host environment once, on first use.
fn state() -> Rc<State> {
    STATE.with(|cell| {
        cell.get_or_init(|| {
            let environment = henv::get_environment();
            if environment
                .iter()
                .any(|(name, _)| name == IGNORED_INTEGRITY_VARIABLE)
            {
                log(&format!(
                    "{IGNORED_INTEGRITY_VARIABLE} is ignored: the platform chooses integrity mode with a reservation marker, never an environment variable"
                ));
            }
            let keys = KeyRing::from_environment(environment, &mut |m| log(&m));
            Rc::new(State {
                keys,
                ciphers: RefCell::default(),
            })
        })
        .clone()
    })
}

fn current_key(state: &State) -> R<&Kek> {
    state.keys.current().ok_or_else(|| {
        log_once("no-key", Lock::NoKey.message());
        ErrorCode::Access
    })
}

fn random<const N: usize>() -> [u8; N] {
    hrand::get_random_bytes(N as u64)
        .try_into()
        .expect("wasi:random returns the requested length")
}

fn log(message: &str) {
    let line = format!("pglite-encfs: {message}\n");
    let _ = hstderr::get_stderr().blocking_write_and_flush(line.as_bytes());
}

fn log_once(tag: &'static str, message: &str) {
    if LOGGED.with(|logged| logged.borrow_mut().insert(tag)) {
        log(message);
    }
}

// ------------------------------------------------------------------ type mapping

/// Both sides are generated from the same WIT; map them variant by variant.
macro_rules! same_enum {
    ($name:ident: $from:ident::$ty:ident => $to:ident { $($variant:ident),* $(,)? }) => {
        fn $name(value: $from::$ty) -> $to::$ty {
            match value { $($from::$ty::$variant => $to::$ty::$variant,)* }
        }
    };
}

same_enum!(guest_error: hfs::ErrorCode => xfs {
    Access, WouldBlock, Already, BadDescriptor, Busy, Deadlock, Quota, Exist, FileTooLarge,
    IllegalByteSequence, InProgress, Interrupted, Invalid, Io, IsDirectory, Loop, TooManyLinks,
    MessageSize, NameTooLong, NoDevice, NoEntry, NoLock, InsufficientMemory, InsufficientSpace,
    NotDirectory, NotEmpty, NotRecoverable, Unsupported, NoTty, NoSuchDevice, Overflow,
    NotPermitted, Pipe, ReadOnly, InvalidSeek, TextFileBusy, CrossDevice,
});
same_enum!(guest_type: hfs::DescriptorType => xfs {
    Unknown, BlockDevice, CharacterDevice, Directory, Fifo, SymbolicLink, RegularFile, Socket,
});
same_enum!(host_advice: xfs::Advice => hfs {
    Normal, Sequential, Random, WillNeed, DontNeed, NoReuse,
});

fn guest_flags(flags: hfs::DescriptorFlags) -> xfs::DescriptorFlags {
    xfs::DescriptorFlags::from_bits_retain(flags.bits())
}
fn host_flags(flags: xfs::DescriptorFlags) -> hfs::DescriptorFlags {
    hfs::DescriptorFlags::from_bits_retain(flags.bits())
}
fn host_path_flags(flags: xfs::PathFlags) -> hfs::PathFlags {
    hfs::PathFlags::from_bits_retain(flags.bits())
}
fn guest_stat(stat: hfs::DescriptorStat) -> xfs::DescriptorStat {
    let regular = stat.type_ == hfs::DescriptorType::RegularFile;
    xfs::DescriptorStat {
        type_: guest_type(stat.type_),
        link_count: stat.link_count,
        // XTS is length-preserving: a regular file's size is its size minus the header.
        size: if regular {
            logical_size(stat.size)
        } else {
            stat.size
        },
        data_access_timestamp: stat.data_access_timestamp,
        data_modification_timestamp: stat.data_modification_timestamp,
        status_change_timestamp: stat.status_change_timestamp,
    }
}

fn host(error: hfs::ErrorCode) -> ErrorCode {
    guest_error(error)
}

fn file_error(path: &str, error: FileError<hfs::ErrorCode>) -> ErrorCode {
    match error {
        FileError::Storage(code) => host(code),
        FileError::TooLarge => ErrorCode::FileTooLarge,
        FileError::Truncated => {
            log(&format!(
                "{path}: physical file is shorter than its size; refusing"
            ));
            ErrorCode::Io
        }
    }
}

fn slot_error(path: &str, error: SlotError<hfs::ErrorCode>) -> ErrorCode {
    match error {
        SlotError::Storage(code) => host(code),
        SlotError::Integrity(integrity) => {
            log(&format!("{path}: {}; refusing", integrity.describe()));
            ErrorCode::Io
        }
        SlotError::TooLarge => ErrorCode::FileTooLarge,
        SlotError::FailStopped => {
            log(&format!(
                "{path}: a host sync of this file failed earlier; refusing writes and syncs until restart"
            ));
            ErrorCode::Io
        }
    }
}

fn header_error(path: &str, error: HeaderError) -> ErrorCode {
    match error {
        HeaderError::WrongKey => {
            log_once(
                "wrong-key-file",
                &format!("{path}: encrypted with a different key; refusing"),
            );
            ErrorCode::Access
        }
        HeaderError::NotEncrypted => {
            log_once(
                "plain-file",
                &format!("{path}: no encryption header; refusing"),
            );
            ErrorCode::Io
        }
        HeaderError::Stub => {
            // The same refusal as plaintext, plus what the operator can do (#207).
            log(&format!(
                "{path}: no encryption header; refusing. The file is at most {HEADER_LEN} bytes, \
                 so it holds no encrypted data: unless it is a plaintext file placed here, it is \
                 a stub left by a failed header write (full disk, or a crash under ext4 \
                 data=writeback), and truncating it to 0 bytes is safe"
            ));
            ErrorCode::Io
        }
        HeaderError::Unsupported { version, codec } => {
            log(&format!(
                "{path}: unsupported header (format {version}, codec {codec}); refusing"
            ));
            ErrorCode::Io
        }
        HeaderError::Tampered => {
            log(&format!("{path}: file key does not authenticate; refusing"));
            ErrorCode::Io
        }
    }
}

// ------------------------------------------------------------------ host storage

/// Positional I/O on a host descriptor.
struct HostStorage<'a>(&'a hfs::Descriptor);

impl Storage for HostStorage<'_> {
    type Error = hfs::ErrorCode;

    fn size(&self) -> Result<u64, hfs::ErrorCode> {
        Ok(self.0.stat()?.size)
    }

    fn read_at(&self, mut offset: u64, len: u64) -> Result<Vec<u8>, hfs::ErrorCode> {
        let mut out = Vec::with_capacity(len as usize);
        while (out.len() as u64) < len {
            let (chunk, eof) = self.0.read(len - out.len() as u64, offset)?;
            offset += chunk.len() as u64;
            let done = eof || chunk.is_empty();
            out.extend_from_slice(&chunk);
            if done {
                break;
            }
        }
        Ok(out)
    }

    fn write_at(&self, mut offset: u64, mut data: &[u8]) -> Result<(), hfs::ErrorCode> {
        while !data.is_empty() {
            let written = self.0.write(data, offset)?;
            if written == 0 {
                return Err(hfs::ErrorCode::Io);
            }
            offset += written;
            data = &data[written as usize..];
        }
        Ok(())
    }

    fn set_len(&self, len: u64) -> Result<(), hfs::ErrorCode> {
        self.0.set_size(len)
    }
}

impl Durable for HostStorage<'_> {
    fn sync_data(&self) -> Result<(), hfs::ErrorCode> {
        self.0.sync_data()
    }

    fn sync_all(&self) -> Result<(), hfs::ErrorCode> {
        self.0.sync()
    }
}

fn read_header(descriptor: &hfs::Descriptor) -> Result<Vec<u8>, hfs::ErrorCode> {
    HostStorage(descriptor).read_at(0, HEADER_USED as u64)
}

// ------------------------------------------------------------------ files

/// An open regular file.
pub struct File {
    host: hfs::Descriptor,
    flags: xfs::DescriptorFlags,
    path: String,
    /// The mode of the preopen the file was opened under.
    mode: Mode,
    cipher: RefCell<Option<Rc<FileCipher>>>,
    /// A codec-4 file's state, shared with every descriptor of the inode,
    /// and the host identity it is filed under in [`FILES`].
    state: RefCell<Option<(DirId, Rc<RefCell<FileState>>)>>,
}

impl Drop for File {
    /// The last descriptor of a clean file drops its state (6.1); a dirty or
    /// fail-stopped file keeps it, so no `pending` bit and no fail-stop is
    /// lost (6.6 (c), (d)).
    fn drop(&mut self) {
        let Some((id, state)) = self.state.get_mut().take() else {
            return;
        };
        let keep = {
            let state = state.borrow();
            state.is_dirty() || state.has_failed()
        };
        if keep {
            return;
        }
        FILES.with(|files| {
            let mut files = files.borrow_mut();
            // Only this descriptor and the map hold it.
            if files
                .get(&id)
                .is_some_and(|filed| Rc::ptr_eq(filed, &state))
                && Rc::strong_count(&state) == 2
            {
                files.remove(&id);
            }
        });
    }
}

impl File {
    fn new(host: hfs::Descriptor, flags: xfs::DescriptorFlags, path: String, mode: Mode) -> File {
        File {
            host,
            flags,
            path,
            mode,
            cipher: RefCell::default(),
            state: RefCell::default(),
        }
    }

    fn writable(&self) -> bool {
        self.flags.contains(xfs::DescriptorFlags::WRITE)
    }

    fn physical_size(&self) -> R<u64> {
        Ok(self.host.stat().map_err(host)?.size)
    }

    /// The file's cipher, or `None` while it is fresh: empty, or left with a
    /// short or zero header by a crash during its creation (see
    /// [`classify_in`]). `access` for another key, `io` for plaintext, foreign
    /// or damaged files, and for a codec its directory's mode does not admit.
    fn cipher(&self) -> R<Option<Rc<FileCipher>>> {
        if let Some(cipher) = self.cipher.borrow().as_ref() {
            return Ok(Some(cipher.clone()));
        }
        let physical = self.physical_size()?;
        if physical == 0 {
            return Ok(None);
        }
        let start = read_header(&self.host).map_err(host)?;
        let header = match classify_in(&start, physical, self.mode)
            .map_err(|e| header_error(&self.path, e))?
        {
            HeaderState::Fresh => return Ok(None),
            HeaderState::Sealed(header) => header,
        };
        if !self.mode.admits(header.codec()) {
            // A directory never mixes XTS and codec-4 files (#200).
            log(&format!(
                "{}: codec {} file in an {} directory; refusing",
                self.path,
                header.codec().id(),
                match self.mode {
                    Mode::Xts => "XTS",
                    Mode::Integrity => "integrity",
                }
            ));
            return Err(ErrorCode::Io);
        }
        let state = state();
        let kek = current_key(&state)?;
        let cached = state.ciphers.borrow().get(header.as_bytes()).cloned();
        let cipher = match cached {
            // The same bytes were authenticated under the current key before.
            Some(cipher) => cipher,
            None => {
                let dek = header.open(kek).map_err(|e| header_error(&self.path, e))?;
                let cipher = Rc::new(FileCipher::new(&header, &dek));
                state
                    .ciphers
                    .borrow_mut()
                    .insert(*header.as_bytes(), cipher.clone());
                cipher
            }
        };
        *self.cipher.borrow_mut() = Some(cipher.clone());
        Ok(Some(cipher))
    }

    /// The XTS cipher for a write, sealing a fresh header first. The header is
    /// synced before any data can follow it, so a crash never leaves data
    /// behind a missing header.
    fn cipher_for_write(&self) -> R<Rc<FileCipher>> {
        if let Some(cipher) = self.cipher()? {
            return Ok(cipher);
        }
        let state = state();
        let kek = current_key(&state)?;
        let file_id: FileId = random();
        let dek = Zeroizing::new(random::<DEK_LEN>());
        let header = Header::seal(kek, Codec::NEW_FILES, &file_id, &dek, &random());
        let mut block = vec![0u8; HEADER_LEN as usize];
        block[..HEADER_USED].copy_from_slice(header.as_bytes());
        HostStorage(&self.host).write_at(0, &block).map_err(host)?;
        self.host.sync_data().map_err(host)?;
        let cipher = Rc::new(FileCipher::Xts(Box::new(UnitCipher::new(
            Codec::NEW_FILES,
            &dek,
        ))));
        state
            .ciphers
            .borrow_mut()
            .insert(*header.as_bytes(), cipher.clone());
        *self.cipher.borrow_mut() = Some(cipher.clone());
        Ok(cipher)
    }

    /// The host identity of the file's inode (design note 6.1). Codec-4
    /// state cannot be shared safely without it, so its absence is `io`.
    fn host_id(&self) -> R<DirId> {
        self.host.metadata_hash().map(dir_id).map_err(|error| {
            log(&format!(
                "{}: the host cannot identify the file ({error:?}); refusing",
                self.path
            ));
            ErrorCode::Io
        })
    }

    /// Bring a codec-4 file into existence (5.6 "Birth"): the header page
    /// and both record pages as one 12 KiB block, record 0 sealed as
    /// `seq = 1, D = 0`, synced before any pair is written. A failed sync
    /// files the state fail-stopped (A3), so no pair ever follows a header
    /// and record 0 that may not have reached the disk.
    fn birth(&self) -> R<Rc<FileCipher>> {
        let state = state();
        let kek = current_key(&state)?;
        let id = self.host_id()?;
        if is_fail_stopped(&id) {
            return Err(slot_error(&self.path, SlotError::FailStopped));
        }
        let file_id: FileId = random();
        let dek = Zeroizing::new(random::<DEK_LEN>());
        let header = Header::seal(kek, Codec::TwoSlotAead, &file_id, &dek, &random());
        let keys = SlotKeys::derive(&dek);
        let storage = HostStorage(&self.host);
        let (born, failure) =
            match give_birth(&storage, &keys, file_id, header.as_bytes(), &random()) {
                Ok(born) => (born, None),
                Err((error, None)) => return Err(host(error)),
                Err((error, Some(failed))) => (*failed, Some(error)),
            };
        let cipher = Rc::new(FileCipher::Slots { keys, file_id });
        state
            .ciphers
            .borrow_mut()
            .insert(*header.as_bytes(), cipher.clone());
        *self.cipher.borrow_mut() = Some(cipher.clone());
        let filed = Rc::new(RefCell::new(born));
        FILES.with(|files| files.borrow_mut().insert(id, filed.clone()));
        *self.state.borrow_mut() = Some((id, filed));
        match failure {
            Some(error) => Err(host(error)),
            None => Ok(cipher),
        }
    }

    /// A3 for a host sync of a file in an integrity directory that failed
    /// while encfs held no state for it: the inode is fail-stopped until
    /// restart (6.5). An inode the host cannot identify gets no state
    /// either, so nothing can be written to it.
    fn fail_stop(&self) {
        if let Ok(id) = self.host_id() {
            log(&format!(
                "{}: a host sync failed; refusing writes and syncs until restart",
                self.path
            ));
            FAIL_STOPPED.with(|failed| failed.borrow_mut().insert(id));
        }
    }

    /// The state of this codec-4 file: this descriptor's, another
    /// descriptor's of the same inode, or read from disk (5.3).
    fn file_state(&self, keys: &SlotKeys, file_id: FileId) -> R<Rc<RefCell<FileState>>> {
        if let Some((_, state)) = self.state.borrow().as_ref() {
            return Ok(state.clone());
        }
        let id = self.host_id()?;
        let filed = FILES
            .with(|files| files.borrow().get(&id).cloned())
            .filter(|state| state.borrow().file_id() == file_id);
        let state = match filed {
            Some(state) => state,
            None => {
                let storage = HostStorage(&self.host);
                let layout = SlotFile {
                    keys,
                    file_id,
                    storage: &storage,
                }
                .layout()
                .map_err(|e| slot_error(&self.path, e))?;
                let state = Rc::new(RefCell::new(FileState::loaded(file_id, layout)));
                FILES.with(|files| files.borrow_mut().insert(id, state.clone()));
                state
            }
        };
        if is_fail_stopped(&id) {
            state.borrow_mut().fail_stop();
        }
        *self.state.borrow_mut() = Some((id, state.clone()));
        Ok(state)
    }

    /// Run `op` on this codec-4 file through its state. `None` while the
    /// file is fresh, unless `birth` asks to create it first.
    fn integrity<T>(
        &self,
        birth: bool,
        op: impl FnOnce(
            &mut IntegrityFile<HostStorage, fn() -> [u8; NONCE_LEN]>,
        ) -> Result<T, SlotError<hfs::ErrorCode>>,
    ) -> R<Option<T>> {
        let cipher = match self.cipher()? {
            Some(cipher) => cipher,
            None if birth => self.birth()?,
            None => return Ok(None),
        };
        let FileCipher::Slots { keys, file_id } = &*cipher else {
            // `cipher` refuses XTS files in an integrity directory.
            return Err(ErrorCode::Io);
        };
        let state = self.file_state(keys, *file_id)?;
        let storage = HostStorage(&self.host);
        let mut nonces: fn() -> [u8; NONCE_LEN] = random::<NONCE_LEN>;
        let mut state = state.borrow_mut();
        let mut file = IntegrityFile {
            file: SlotFile {
                keys,
                file_id: *file_id,
                storage: &storage,
            },
            state: &mut state,
            nonces: &mut nonces,
            writable: self.writable(),
        };
        op(&mut file)
            .map(Some)
            .map_err(|e| slot_error(&self.path, e))
    }

    fn size(&self) -> R<u64> {
        match self.mode {
            // Length-preserving: no key needed.
            Mode::Xts => Ok(logical_size(self.physical_size()?)),
            Mode::Integrity => Ok(self.integrity(false, |f| Ok(f.size()))?.unwrap_or(0)),
        }
    }

    fn read(&self, len: u64, offset: u64) -> R<(Vec<u8>, bool)> {
        if self.mode == Mode::Integrity {
            return Ok(self
                .integrity(false, |f| f.read(len, offset))?
                .unwrap_or((Vec::new(), true)));
        }
        let Some(cipher) = self.cipher()? else {
            return Ok((Vec::new(), true));
        };
        let FileCipher::Xts(cipher) = &*cipher else {
            return Err(ErrorCode::Io);
        };
        let storage = HostStorage(&self.host);
        EncryptedFile {
            cipher,
            storage: &storage,
        }
        .read(len, offset)
        .map_err(|e| file_error(&self.path, e))
    }

    /// The XTS cipher of a file in an XTS directory.
    fn xts<'c>(&self, cipher: &'c FileCipher) -> R<&'c UnitCipher> {
        match cipher {
            FileCipher::Xts(cipher) => Ok(cipher),
            // `cipher` refuses codec-4 files in an XTS directory.
            FileCipher::Slots { .. } => Err(ErrorCode::Io),
        }
    }

    fn write(&self, data: &[u8], offset: u64) -> R<u64> {
        if !self.writable() {
            return Err(ErrorCode::BadDescriptor);
        }
        if data.is_empty() {
            return Ok(0);
        }
        if self.mode == Mode::Integrity {
            self.integrity(true, |f| f.write(offset, data))?;
            return Ok(data.len() as u64);
        }
        let cipher = self.cipher_for_write()?;
        let storage = HostStorage(&self.host);
        EncryptedFile {
            cipher: self.xts(&cipher)?,
            storage: &storage,
        }
        .write(offset, data)
        .map_err(|e| file_error(&self.path, e))?;
        Ok(data.len() as u64)
    }

    fn set_size(&self, size: u64) -> R<()> {
        if !self.writable() {
            return Err(ErrorCode::BadDescriptor);
        }
        if self.mode == Mode::Integrity {
            self.integrity(size > 0, |f| f.set_size(size))?;
            return Ok(());
        }
        let cipher = match self.cipher()? {
            Some(cipher) => cipher,
            None if size == 0 => return Ok(()),
            None => self.cipher_for_write()?,
        };
        let storage = HostStorage(&self.host);
        EncryptedFile {
            cipher: self.xts(&cipher)?,
            storage: &storage,
        }
        .set_size(size)
        .map_err(|e| file_error(&self.path, e))
    }

    /// `sync` (`all`) or `sync-data`. For a codec-4 file every successful
    /// sync, through any descriptor of the inode, clears the `pending` bits
    /// and advances the watermark (6.3 "Sync"); a failed one stops writes
    /// (A3). A file with no state has nothing pending, but a failed sync of
    /// it still stops every later write and birth (6.5).
    fn sync(&self, all: bool) -> R<()> {
        let passthrough = || {
            if all {
                self.host.sync()
            } else {
                self.host.sync_data()
            }
            .map_err(host)
        };
        if self.mode == Mode::Xts {
            return passthrough();
        }
        let filed = match self.state.borrow().as_ref() {
            Some((_, state)) => Some(state.clone()),
            None => match self.cipher()?.as_deref() {
                Some(FileCipher::Slots { file_id, .. }) => {
                    let id = self.host_id()?;
                    FILES
                        .with(|files| files.borrow().get(&id).cloned())
                        .filter(|state| state.borrow().file_id() == *file_id)
                }
                _ => None,
            },
        };
        if filed.is_none() {
            return passthrough().inspect_err(|_| self.fail_stop());
        }
        self.integrity(false, |f| f.sync(all))?;
        Ok(())
    }
}

/// Forget the state of an inode encfs is about to remove (design note 6.1),
/// so a reused inode number never inherits it. Only when `path` names the
/// inode's last link: with another name left, the inode lives on.
fn doomed_inode(dir: &hfs::Descriptor, path: &str) -> Option<DirId> {
    let stat = dir.stat_at(hfs::PathFlags::empty(), path).ok()?;
    (stat.type_ == hfs::DescriptorType::RegularFile && stat.link_count == 1)
        .then(|| {
            dir.metadata_hash_at(hfs::PathFlags::empty(), path)
                .ok()
                .map(dir_id)
        })
        .flatten()
}

fn forget_inode(id: Option<DirId>) {
    if let Some(id) = id {
        FILES.with(|files| files.borrow_mut().remove(&id));
        FAIL_STOPPED.with(|failed| failed.borrow_mut().remove(&id));
    }
}

// ------------------------------------------------------------------ preopen roots

/// Check a preopen before pglite may touch it (see [`crate::marker`]), and
/// return its mode.
fn open_root(dir: &hfs::Descriptor) -> Result<Mode, ErrorCode> {
    let state = state();
    let marker = read_marker(dir)?;
    let has_data = root_has_data(dir)?;
    match marker::decide(&state.keys, marker.as_deref(), has_data) {
        RootDecision::Ready(mode) => Ok(mode),
        // An empty root, or a reservation in a root without data: the keyed
        // marker of that mode replaces whatever was there by rename.
        RootDecision::Initialize(mode) => {
            write_marker(dir, mode, current_key(&state)?)?;
            Ok(mode)
        }
        RootDecision::Rotate(mode) => {
            let (current, previous) = (
                current_key(&state)?,
                state.keys.previous().ok_or(ErrorCode::Access)?,
            );
            let sweep = rewrap_tree(dir, mode, previous, current)?;
            dir.sync().map_err(host)?;
            // The marker keeps its mode (and an integrity marker its flags).
            write_marker(dir, mode, current)?;
            log(&sweep.completion_message());
            Ok(mode)
        }
        RootDecision::Locked(lock) => {
            log_once("root-locked", lock.message());
            Err(if lock.is_access_error() {
                ErrorCode::Access
            } else {
                ErrorCode::Io
            })
        }
    }
}

fn read_marker(dir: &hfs::Descriptor) -> R<Option<Vec<u8>>> {
    match dir.open_at(
        hfs::PathFlags::empty(),
        MARKER_NAME,
        hfs::OpenFlags::empty(),
        hfs::DescriptorFlags::READ,
    ) {
        Ok(file) => HostStorage(&file)
            .read_at(0, MARKER_READ_LEN as u64)
            .map(Some)
            .map_err(host),
        Err(hfs::ErrorCode::NoEntry) => Ok(None),
        Err(error) => Err(host(error)),
    }
}

/// Whether the root has entries other than volume metadata and our markers.
fn root_has_data(dir: &hfs::Descriptor) -> R<bool> {
    let entries = dir.read_directory().map_err(host)?;
    while let Some(entry) = entries.read_directory_entry().map_err(host)? {
        if !marker::is_volume_metadata(&entry.name) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Write the marker of a `mode` directory for `kek` atomically: a synced
/// temporary file renamed over the marker, then a directory sync.
fn write_marker(dir: &hfs::Descriptor, mode: Mode, kek: &Kek) -> R<()> {
    let file = dir
        .open_at(
            hfs::PathFlags::empty(),
            MARKER_TMP_NAME,
            hfs::OpenFlags::CREATE | hfs::OpenFlags::TRUNCATE,
            hfs::DescriptorFlags::READ | hfs::DescriptorFlags::WRITE,
        )
        .map_err(host)?;
    HostStorage(&file)
        .write_at(0, &marker::encode(mode, kek.kcv()))
        .map_err(host)?;
    file.sync().map_err(host)?;
    dir.rename_at(MARKER_TMP_NAME, dir, MARKER_NAME)
        .map_err(host)?;
    dir.sync().map_err(host)
}

/// Lines logged for entries a rotation left in `lost+found`, before a summary.
const SKIPPED_LOG_LIMIT: usize = 50;

/// Run the rotation sweep (see [`crate::rotation`]) over a preopen root.
fn rewrap_tree(dir: &hfs::Descriptor, mode: Mode, from: &Kek, to: &Kek) -> R<rotation::Sweep> {
    let sweep = rotation::rewrap_tree(&HostDir::Borrowed(dir), mode, from, to, &mut || random())
        .map_err(|error| match error {
            rotation::SweepError::Host(error) => host(error),
            rotation::SweepError::Header { path, error } => header_error(&path, error),
        })?;
    for skipped in sweep.skipped.iter().take(SKIPPED_LOG_LIMIT) {
        log(&format!(
            "{}: left as it was during key rotation: {}",
            skipped.path,
            skipped.reason.describe()
        ));
    }
    if sweep.skipped.len() > SKIPPED_LOG_LIMIT {
        log(&format!(
            "... and {} more entries in {} left as they were",
            sweep.skipped.len() - SKIPPED_LOG_LIMIT,
            marker::LOST_AND_FOUND
        ));
    }
    Ok(sweep)
}

/// A host directory for the rotation sweep: the preopen itself, or one it opened.
enum HostDir<'a> {
    Borrowed(&'a hfs::Descriptor),
    Owned(hfs::Descriptor),
}

impl HostDir<'_> {
    fn get(&self) -> &hfs::Descriptor {
        match self {
            HostDir::Borrowed(dir) => dir,
            HostDir::Owned(dir) => dir,
        }
    }
}

impl rotation::Dir for HostDir<'_> {
    type Error = hfs::ErrorCode;
    type File = hfs::Descriptor;

    fn entries(&self) -> Result<Vec<(String, rotation::EntryType)>, hfs::ErrorCode> {
        let stream = self.get().read_directory()?;
        let mut entries = Vec::new();
        while let Some(entry) = stream.read_directory_entry()? {
            let kind = match entry.type_ {
                hfs::DescriptorType::Directory => rotation::EntryType::Directory,
                hfs::DescriptorType::RegularFile => rotation::EntryType::RegularFile,
                _ => rotation::EntryType::Other,
            };
            entries.push((entry.name, kind));
        }
        Ok(entries)
    }

    fn open_dir(&self, name: &str) -> Result<Self, hfs::ErrorCode> {
        self.get()
            .open_at(
                hfs::PathFlags::empty(),
                name,
                hfs::OpenFlags::DIRECTORY,
                hfs::DescriptorFlags::READ,
            )
            .map(HostDir::Owned)
    }

    fn open_file(&self, name: &str) -> Result<hfs::Descriptor, hfs::ErrorCode> {
        self.get().open_at(
            hfs::PathFlags::empty(),
            name,
            hfs::OpenFlags::empty(),
            hfs::DescriptorFlags::READ | hfs::DescriptorFlags::WRITE,
        )
    }
}

impl rotation::File for hfs::Descriptor {
    type Error = hfs::ErrorCode;

    fn physical_size(&self) -> Result<u64, hfs::ErrorCode> {
        Ok(self.stat()?.size)
    }

    fn read_start(&self) -> Result<Vec<u8>, hfs::ErrorCode> {
        read_header(self)
    }

    fn write_header(&self, header: &Header) -> Result<(), hfs::ErrorCode> {
        HostStorage(self).write_at(0, header.as_bytes())?;
        self.sync()
    }
}

// ------------------------------------------------------------------ resources

pub enum Error {
    Host(herr::Error),
    Fs(ErrorCode),
}

pub enum Pollable {
    Host(hpoll::Pollable),
    Ready,
}

pub enum InputStream {
    Host(hs::InputStream),
    File { file: Rc<File>, position: Cell<u64> },
}

pub enum OutputStream {
    Host(hs::OutputStream),
    File {
        file: Rc<File>,
        position: Cell<u64>,
        append: bool,
    },
}

pub enum Descriptor {
    /// Directories and other non-regular files pass through.
    Passthrough {
        host: hfs::Descriptor,
        flags: xfs::DescriptorFlags,
        /// This descriptor names the preopen root: its listing hides the markers.
        root: bool,
        /// The preopen root's identity, `None` if the host could not tell.
        root_id: Option<DirId>,
        /// The preopen's mode, from its marker.
        mode: Mode,
    },
    /// A preopen that failed its key check: data and namespace operations fail.
    Locked {
        host: hfs::Descriptor,
        error: ErrorCode,
    },
    File(Rc<File>),
}

pub struct DirectoryEntryStream {
    host: hfs::DirectoryEntryStream,
    hide_marker: bool,
}

fn host_stream_error(error: hs::StreamError) -> xs::StreamError {
    match error {
        hs::StreamError::LastOperationFailed(e) => {
            xs::StreamError::LastOperationFailed(xerr::Error::new(Error::Host(e)))
        }
        hs::StreamError::Closed => xs::StreamError::Closed,
    }
}

fn fs_stream_error(code: ErrorCode) -> xs::StreamError {
    xs::StreamError::LastOperationFailed(xerr::Error::new(Error::Fs(code)))
}

fn ready() -> xpoll::Pollable {
    xpoll::Pollable::new(Pollable::Ready)
}

struct Component;

impl xerr::Guest for Component {
    type Error = Error;
}
impl xerr::GuestError for Error {}

impl xpoll::Guest for Component {
    type Pollable = Pollable;

    fn poll(list: Vec<xpoll::PollableBorrow<'_>>) -> Vec<u32> {
        let mut ready = Vec::new();
        let (mut host, mut index) = (Vec::new(), Vec::new());
        for (i, pollable) in list.iter().enumerate() {
            match pollable.get::<Pollable>() {
                Pollable::Ready => ready.push(i as u32),
                Pollable::Host(p) => {
                    host.push(p);
                    index.push(i as u32);
                }
            }
        }
        if !ready.is_empty() {
            return ready;
        }
        hpoll::poll(&host)
            .into_iter()
            .map(|j| index[j as usize])
            .collect()
    }
}

impl xpoll::GuestPollable for Pollable {
    fn block(&self) {
        if let Pollable::Host(p) = self {
            p.block()
        }
    }
}

impl xs::Guest for Component {
    type InputStream = InputStream;
    type OutputStream = OutputStream;
}

impl InputStream {
    fn read_from(&self, len: u64, blocking: bool) -> Result<Vec<u8>, xs::StreamError> {
        match self {
            InputStream::Host(h) => if blocking {
                h.blocking_read(len)
            } else {
                h.read(len)
            }
            .map_err(host_stream_error),
            InputStream::File { file, position } => {
                if len == 0 {
                    return Ok(Vec::new());
                }
                let (data, _) = file.read(len, position.get()).map_err(fs_stream_error)?;
                if data.is_empty() {
                    return Err(xs::StreamError::Closed);
                }
                position.set(position.get() + data.len() as u64);
                Ok(data)
            }
        }
    }
}

impl xs::GuestInputStream for InputStream {
    fn read(&self, len: u64) -> Result<Vec<u8>, xs::StreamError> {
        self.read_from(len, false)
    }
    fn blocking_read(&self, len: u64) -> Result<Vec<u8>, xs::StreamError> {
        self.read_from(len, true)
    }
    fn subscribe(&self) -> xpoll::Pollable {
        match self {
            InputStream::Host(h) => xpoll::Pollable::new(Pollable::Host(h.subscribe())),
            InputStream::File { .. } => ready(),
        }
    }
}

impl OutputStream {
    fn write_to(&self, data: &[u8]) -> Result<(), xs::StreamError> {
        match self {
            OutputStream::Host(h) => h.write(data).map_err(host_stream_error),
            OutputStream::File {
                file,
                position,
                append,
            } => {
                let at = if *append {
                    file.size().map_err(fs_stream_error)?
                } else {
                    position.get()
                };
                let written = file.write(data, at).map_err(fs_stream_error)?;
                position.set(at + written);
                Ok(())
            }
        }
    }
}

impl xs::GuestOutputStream for OutputStream {
    fn check_write(&self) -> Result<u64, xs::StreamError> {
        match self {
            OutputStream::Host(h) => h.check_write().map_err(host_stream_error),
            OutputStream::File { .. } => Ok(STREAM_WRITE_BUDGET),
        }
    }
    fn write(&self, contents: Vec<u8>) -> Result<(), xs::StreamError> {
        self.write_to(&contents)
    }
    fn blocking_flush(&self) -> Result<(), xs::StreamError> {
        match self {
            OutputStream::Host(h) => h.blocking_flush().map_err(host_stream_error),
            OutputStream::File { .. } => Ok(()),
        }
    }
    fn subscribe(&self) -> xpoll::Pollable {
        match self {
            OutputStream::Host(h) => xpoll::Pollable::new(Pollable::Host(h.subscribe())),
            OutputStream::File { .. } => ready(),
        }
    }
    fn blocking_write_and_flush(&self, contents: Vec<u8>) -> Result<(), xs::StreamError> {
        match self {
            OutputStream::Host(h) => h
                .blocking_write_and_flush(&contents)
                .map_err(host_stream_error),
            OutputStream::File { .. } => self.write_to(&contents),
        }
    }
}

impl xmono::Guest for Component {
    fn subscribe_duration(when: u64) -> xpoll::Pollable {
        xpoll::Pollable::new(Pollable::Host(hmono::subscribe_duration(when)))
    }
    fn now() -> u64 {
        hmono::now()
    }
    fn subscribe_instant(when: u64) -> xpoll::Pollable {
        xpoll::Pollable::new(Pollable::Host(hmono::subscribe_instant(when)))
    }
}

impl xstdout::Guest for Component {
    fn get_stdout() -> xs::OutputStream {
        xs::OutputStream::new(OutputStream::Host(hstdout::get_stdout()))
    }
}
impl xstderr::Guest for Component {
    fn get_stderr() -> xs::OutputStream {
        xs::OutputStream::new(OutputStream::Host(hstderr::get_stderr()))
    }
}
impl xstdin::Guest for Component {
    fn get_stdin() -> xs::InputStream {
        xs::InputStream::new(InputStream::Host(hstdin::get_stdin()))
    }
}

impl xenv::Guest for Component {
    /// The engine never sees the key variables; their copies are wiped.
    fn get_environment() -> Vec<(String, String)> {
        let mut visible = Vec::new();
        for (name, mut value) in henv::get_environment() {
            if is_key_variable(&name) {
                value.zeroize();
            } else {
                visible.push((name, value));
            }
        }
        visible
    }
    fn get_arguments() -> Vec<String> {
        henv::get_arguments()
    }
}

impl xpre::Guest for Component {
    fn get_directories() -> Vec<(xfs::Descriptor, String)> {
        hpre::get_directories()
            .into_iter()
            .map(|(dir, path)| {
                let descriptor = match open_root(&dir) {
                    Ok(mode) => {
                        let flags = dir
                            .get_flags()
                            .map(guest_flags)
                            .unwrap_or(xfs::DescriptorFlags::READ);
                        let root_id = dir.metadata_hash().ok().map(dir_id);
                        Descriptor::Passthrough {
                            host: dir,
                            flags,
                            root: true,
                            root_id,
                            mode,
                        }
                    }
                    Err(error) => Descriptor::Locked { host: dir, error },
                };
                (xfs::Descriptor::new(descriptor), path)
            })
            .collect()
    }
}

// ------------------------------------------------------------------ filesystem

impl Descriptor {
    fn host(&self) -> &hfs::Descriptor {
        match self {
            Descriptor::Passthrough { host, .. } | Descriptor::Locked { host, .. } => host,
            Descriptor::File(file) => &file.host,
        }
    }

    /// Fail data and namespace operations on a locked preopen, and keep the
    /// markers out of reach from every directory descriptor, however the path
    /// gets to the root (see [`marker::may_reach_marker`]).
    fn guard(&self, path: Option<&str>) -> R<()> {
        match self {
            Descriptor::Locked { error, .. } => Err(*error),
            Descriptor::Passthrough {
                host,
                root,
                root_id,
                ..
            } if path.is_some_and(|path| {
                marker::may_reach_marker(&HostNamespace(host), root_id.as_ref(), *root, path)
            }) =>
            {
                Err(ErrorCode::Access)
            }
            _ => Ok(()),
        }
    }

    fn passthrough(&self) -> R<&hfs::Descriptor> {
        self.guard(None)?;
        Ok(self.host())
    }

    fn is_root(&self) -> bool {
        matches!(self, Descriptor::Passthrough { root: true, .. })
    }

    fn root_id(&self) -> Option<DirId> {
        match self {
            Descriptor::Passthrough { root_id, .. } => *root_id,
            _ => None,
        }
    }

    /// The mode of the preopen this descriptor was opened under. A locked
    /// preopen has none; [`Descriptor::guard`] refuses it first.
    fn mode(&self) -> Mode {
        match self {
            Descriptor::Passthrough { mode, .. } => *mode,
            Descriptor::File(file) => file.mode,
            Descriptor::Locked { .. } => Mode::Xts,
        }
    }

    /// The logical size of the regular file at `path` in an integrity
    /// directory: codec-4 sizes need the file's slots (design note 5.3).
    fn integrity_size_at(&self, path_flags: xfs::PathFlags, path: &str) -> R<u64> {
        let fd = self
            .host()
            .open_at(
                host_path_flags(path_flags),
                path,
                hfs::OpenFlags::empty(),
                hfs::DescriptorFlags::READ,
            )
            .map_err(host)?;
        File::new(
            fd,
            xfs::DescriptorFlags::READ,
            path.to_string(),
            Mode::Integrity,
        )
        .size()
    }
}

/// What the host identifies a file or directory by: its `metadata-hash`.
/// wasmtime-wasi 48.0.1, the pinned host, derives it from the device and
/// inode numbers (`meta_identity` in `src/filesystem/unix.rs`), hashed with
/// `std::collections::hash_map::DefaultHasher::new()`, whose keys are fixed,
/// and the upper half is the lower one xor a constant
/// (`MetadataHashValue::new` in `src/filesystem.rs`). Writes do not change
/// it; a host built with another Rust release may hash differently, which
/// only matters within one instance (6.1).
type DirId = (u64, u64);

fn dir_id(hash: hfs::MetadataHashValue) -> DirId {
    (hash.lower, hash.upper)
}

/// Path lookups for the marker guard, resolved by the host itself, so `..`
/// and symlinks are followed exactly as the guarded operation follows them.
struct HostNamespace<'a>(&'a hfs::Descriptor);

impl marker::Namespace for HostNamespace<'_> {
    type Id = DirId;

    fn identity(&self, path: &str) -> Option<DirId> {
        let hash = if path.is_empty() {
            self.0.metadata_hash()
        } else {
            self.0
                .metadata_hash_at(hfs::PathFlags::SYMLINK_FOLLOW, path)
        };
        hash.ok().map(dir_id)
    }
}

/// Whether `dir` may be the preopen root. Paths alone miss a symlink back to
/// it, so compare what the host identifies them by. A failed or unknown
/// lookup answers yes: treating a directory as the root only hides and guards
/// the marker names in it.
fn may_be_root(dir: &hfs::Descriptor, root_id: Option<DirId>) -> bool {
    match (dir.metadata_hash(), root_id) {
        (Ok(hash), Some(root)) => dir_id(hash) == root,
        _ => true,
    }
}

impl xfs::Guest for Component {
    type Descriptor = Descriptor;
    type DirectoryEntryStream = DirectoryEntryStream;

    fn filesystem_error_code(err: xerr::ErrorBorrow<'_>) -> Option<ErrorCode> {
        match err.get::<Error>() {
            Error::Host(e) => hfs::filesystem_error_code(e).map(host),
            Error::Fs(code) => Some(*code),
        }
    }
}

impl xfs::GuestDirectoryEntryStream for DirectoryEntryStream {
    fn read_directory_entry(&self) -> R<Option<xfs::DirectoryEntry>> {
        loop {
            match self.host.read_directory_entry().map_err(host)? {
                Some(entry) if self.hide_marker && marker::is_reserved_name(&entry.name) => {
                    continue
                }
                entry => {
                    return Ok(entry.map(|e| xfs::DirectoryEntry {
                        type_: guest_type(e.type_),
                        name: e.name,
                    }))
                }
            }
        }
    }
}

impl xfs::GuestDescriptor for Descriptor {
    fn read_via_stream(&self, offset: u64) -> R<xs::InputStream> {
        match self {
            Descriptor::File(file) => Ok(xs::InputStream::new(InputStream::File {
                file: file.clone(),
                position: Cell::new(offset),
            })),
            _ => Ok(xs::InputStream::new(InputStream::Host(
                self.passthrough()?.read_via_stream(offset).map_err(host)?,
            ))),
        }
    }

    fn write_via_stream(&self, offset: u64) -> R<xs::OutputStream> {
        match self {
            Descriptor::File(file) if !file.writable() => Err(ErrorCode::BadDescriptor),
            Descriptor::File(file) => Ok(xs::OutputStream::new(OutputStream::File {
                file: file.clone(),
                position: Cell::new(offset),
                append: false,
            })),
            _ => Ok(xs::OutputStream::new(OutputStream::Host(
                self.passthrough()?.write_via_stream(offset).map_err(host)?,
            ))),
        }
    }

    fn append_via_stream(&self) -> R<xs::OutputStream> {
        match self {
            Descriptor::File(file) if !file.writable() => Err(ErrorCode::BadDescriptor),
            Descriptor::File(file) => Ok(xs::OutputStream::new(OutputStream::File {
                file: file.clone(),
                position: Cell::new(0),
                append: true,
            })),
            _ => Ok(xs::OutputStream::new(OutputStream::Host(
                self.passthrough()?.append_via_stream().map_err(host)?,
            ))),
        }
    }

    fn advise(&self, offset: u64, length: u64, advice: xfs::Advice) -> R<()> {
        match self {
            // Offsets are logical and advice is only a hint: drop it for files.
            Descriptor::File(_) => Ok(()),
            _ => self
                .passthrough()?
                .advise(offset, length, host_advice(advice))
                .map_err(host),
        }
    }

    fn sync_data(&self) -> R<()> {
        match self {
            Descriptor::File(file) => file.sync(false),
            _ => self.host().sync_data().map_err(host),
        }
    }

    fn get_flags(&self) -> R<xfs::DescriptorFlags> {
        match self {
            Descriptor::File(file) => Ok(file.flags),
            Descriptor::Passthrough { flags, .. } => Ok(*flags),
            Descriptor::Locked { .. } => Ok(xfs::DescriptorFlags::READ),
        }
    }

    fn get_type(&self) -> R<xfs::DescriptorType> {
        self.host().get_type().map(guest_type).map_err(host)
    }

    fn set_size(&self, size: u64) -> R<()> {
        match self {
            Descriptor::File(file) => file.set_size(size),
            _ => self.passthrough()?.set_size(size).map_err(host),
        }
    }

    fn read(&self, length: u64, offset: u64) -> R<(Vec<u8>, bool)> {
        match self {
            Descriptor::File(file) => file.read(length, offset),
            _ => self.passthrough()?.read(length, offset).map_err(host),
        }
    }

    fn write(&self, buffer: Vec<u8>, offset: u64) -> R<u64> {
        match self {
            Descriptor::File(file) => file.write(&buffer, offset),
            _ => self.passthrough()?.write(&buffer, offset).map_err(host),
        }
    }

    fn read_directory(&self) -> R<xfs::DirectoryEntryStream> {
        let hide_marker = self.is_root();
        let stream = self.passthrough()?.read_directory().map_err(host)?;
        Ok(xfs::DirectoryEntryStream::new(DirectoryEntryStream {
            host: stream,
            hide_marker,
        }))
    }

    fn sync(&self) -> R<()> {
        match self {
            Descriptor::File(file) => file.sync(true),
            _ => self.host().sync().map_err(host),
        }
    }

    fn create_directory_at(&self, path: String) -> R<()> {
        self.guard(Some(&path))?;
        self.host().create_directory_at(&path).map_err(host)
    }

    fn stat(&self) -> R<xfs::DescriptorStat> {
        let stat = self.host().stat().map(guest_stat).map_err(host)?;
        match self {
            Descriptor::File(file) if file.mode == Mode::Integrity => Ok(xfs::DescriptorStat {
                size: file.size()?,
                ..stat
            }),
            _ => Ok(stat),
        }
    }

    fn stat_at(&self, path_flags: xfs::PathFlags, path: String) -> R<xfs::DescriptorStat> {
        self.guard(Some(&path))?;
        let stat = self
            .host()
            .stat_at(host_path_flags(path_flags), &path)
            .map(guest_stat)
            .map_err(host)?;
        if self.mode() == Mode::Integrity && stat.type_ == xfs::DescriptorType::RegularFile {
            // A file in use: its state has the size (5.3).
            let filed = self
                .host()
                .metadata_hash_at(host_path_flags(path_flags), &path)
                .ok()
                .and_then(|hash| FILES.with(|files| files.borrow().get(&dir_id(hash)).cloned()));
            let size = match filed {
                Some(state) => state.borrow().size(),
                None => self.integrity_size_at(path_flags, &path)?,
            };
            return Ok(xfs::DescriptorStat { size, ..stat });
        }
        Ok(stat)
    }

    fn open_at(
        &self,
        path_flags: xfs::PathFlags,
        path: String,
        open_flags: xfs::OpenFlags,
        flags: xfs::DescriptorFlags,
    ) -> R<xfs::Descriptor> {
        self.guard(Some(&path))?;
        // Truncation keeps the header, so it happens here, after the key check.
        let truncate = open_flags.contains(xfs::OpenFlags::TRUNCATE);
        let mut host_open = hfs::OpenFlags::from_bits_retain(open_flags.bits());
        host_open.remove(hfs::OpenFlags::TRUNCATE);
        let mut host_access = host_flags(flags);
        if flags.contains(xfs::DescriptorFlags::WRITE) {
            // Partial-unit writes read the unit first.
            host_access |= hfs::DescriptorFlags::READ;
        }
        let fd = self
            .host()
            .open_at(host_path_flags(path_flags), &path, host_open, host_access)
            .map_err(host)?;
        let stat = fd.stat().map_err(host)?;
        if stat.type_ != hfs::DescriptorType::RegularFile {
            // The root reopened (`.`, `pglite/..`, a symlink to it anywhere in
            // the path, from any descriptor) keeps the listing filter (#207,
            // #349).
            let root_id = self.root_id();
            let root = stat.type_ == hfs::DescriptorType::Directory
                && ((self.is_root() && marker::is_root_path(&path)) || may_be_root(&fd, root_id));
            return Ok(xfs::Descriptor::new(Descriptor::Passthrough {
                host: fd,
                flags,
                root,
                root_id,
                mode: self.mode(),
            }));
        }
        let file = File::new(fd, flags, path, self.mode());
        // Refuse another key's or a plaintext file before anything can change it.
        if file.cipher()?.is_none() {
            current_key(&state())?;
        }
        if truncate {
            file.set_size(0)?;
        }
        Ok(xfs::Descriptor::new(Descriptor::File(Rc::new(file))))
    }

    fn rename_at(
        &self,
        old_path: String,
        new_descriptor: xfs::DescriptorBorrow<'_>,
        new_path: String,
    ) -> R<()> {
        self.guard(Some(&old_path))?;
        let target = new_descriptor.get::<Descriptor>();
        target.guard(Some(&new_path))?;
        // An XTS directory never holds codec-4 files and an integrity one
        // never holds XTS files: a rename between preopens of different
        // modes would mix them (#200).
        if self.mode() != target.mode() {
            return Err(ErrorCode::CrossDevice);
        }
        // A rename over a codec-4 file removes that inode, unless both names
        // are links to the same one.
        let doomed = (target.mode() == Mode::Integrity)
            .then(|| doomed_inode(target.host(), &new_path))
            .flatten()
            .filter(|&doomed| {
                self.host()
                    .metadata_hash_at(hfs::PathFlags::empty(), &old_path)
                    .map_or(true, |hash| dir_id(hash) != doomed)
            });
        self.host()
            .rename_at(&old_path, target.host(), &new_path)
            .map_err(host)?;
        forget_inode(doomed);
        Ok(())
    }

    fn metadata_hash(&self) -> R<xfs::MetadataHashValue> {
        let hash = self.host().metadata_hash().map_err(host)?;
        Ok(xfs::MetadataHashValue {
            lower: hash.lower,
            upper: hash.upper,
        })
    }

    fn metadata_hash_at(
        &self,
        path_flags: xfs::PathFlags,
        path: String,
    ) -> R<xfs::MetadataHashValue> {
        self.guard(Some(&path))?;
        let hash = self
            .host()
            .metadata_hash_at(host_path_flags(path_flags), &path)
            .map_err(host)?;
        Ok(xfs::MetadataHashValue {
            lower: hash.lower,
            upper: hash.upper,
        })
    }

    fn readlink_at(&self, path: String) -> R<String> {
        self.guard(Some(&path))?;
        self.host().readlink_at(&path).map_err(host)
    }

    fn remove_directory_at(&self, path: String) -> R<()> {
        self.guard(Some(&path))?;
        self.host().remove_directory_at(&path).map_err(host)
    }

    fn symlink_at(&self, old_path: String, new_path: String) -> R<()> {
        self.guard(Some(&new_path))?;
        // A link's target is resolved only when it is followed, from wherever
        // the link then is, so a target naming a marker is never created (#349).
        if marker::names_marker(&old_path) {
            return Err(ErrorCode::Access);
        }
        self.host().symlink_at(&old_path, &new_path).map_err(host)
    }

    fn unlink_file_at(&self, path: String) -> R<()> {
        self.guard(Some(&path))?;
        let doomed = (self.mode() == Mode::Integrity)
            .then(|| doomed_inode(self.host(), &path))
            .flatten();
        self.host().unlink_file_at(&path).map_err(host)?;
        forget_inode(doomed);
        Ok(())
    }
}

bindings::export!(Component with_types_in bindings);
