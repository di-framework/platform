//! The WASI glue: re-exports the interfaces pglite imports and serves every
//! regular file under a preopen through [`crate::file`].
//!
//! - Directories, names, symlinks and metadata pass through unchanged.
//! - Host streams (stdio) and host pollables pass through. File streams are
//!   served from decrypted memory, with always-ready pollables.
//! - `wasi:cli/environment` is re-exported only to hide the key variables from
//!   the engine.
//! - Single-threaded, one instance per data directory: the same exclusive
//!   ownership pglite already requires. File headers are created and the
//!   cipher cache is filled without locking.

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
    classify, FileId, Header, HeaderError, HeaderState, DEK_LEN, HEADER_LEN, HEADER_USED,
};
use crate::keys::{is_key_variable, Kek, KeyRing};
use crate::marker::{self, Lock, RootDecision, MARKER_LEN, MARKER_NAME, MARKER_TMP_NAME};

type R<T> = Result<T, ErrorCode>;

/// Lets a deploy check that a composed provider really contains this layer;
/// the section survives `wac plug`, which nests the component unchanged.
/// `write-codec=N`: the codec this build creates new files with. 3 (#206) can
/// only be read by builds that know codec 3. Advisory: nothing parses the value
/// yet.
#[used]
#[link_section = "di-framework:pglite-encfs"]
static BUILD_MARKER: [u8; 40] = if cfg!(feature = "write-codec-3") {
    *b"format=1 codec=aes-256-xts write-codec=3"
} else {
    *b"format=1 codec=aes-256-xts write-codec=2"
};

/// Write buffers that stream writers may hand over at once.
const STREAM_WRITE_BUDGET: u64 = 1 << 20;

// ------------------------------------------------------------------ state

struct State {
    keys: KeyRing,
    /// Full header bytes → unwrapped cipher. Keyed by the whole header, not
    /// the file id, so every header in use has been authenticated.
    ciphers: RefCell<BTreeMap<[u8; HEADER_USED], Rc<UnitCipher>>>,
}

thread_local! {
    static STATE: OnceCell<Rc<State>> = const { OnceCell::new() };
    static LOGGED: RefCell<BTreeSet<&'static str>> = const { RefCell::new(BTreeSet::new()) };
}

/// Keys are read from the host environment once, on first use.
fn state() -> Rc<State> {
    STATE.with(|cell| {
        cell.get_or_init(|| {
            let keys = KeyRing::from_environment(henv::get_environment(), &mut |m| log(&m));
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

fn read_header(descriptor: &hfs::Descriptor) -> Result<Vec<u8>, hfs::ErrorCode> {
    HostStorage(descriptor).read_at(0, HEADER_USED as u64)
}

// ------------------------------------------------------------------ files

/// An open regular file.
pub struct File {
    host: hfs::Descriptor,
    flags: xfs::DescriptorFlags,
    path: String,
    cipher: RefCell<Option<Rc<UnitCipher>>>,
}

impl File {
    fn writable(&self) -> bool {
        self.flags.contains(xfs::DescriptorFlags::WRITE)
    }

    fn physical_size(&self) -> R<u64> {
        Ok(self.host.stat().map_err(host)?.size)
    }

    /// The file's cipher, or `None` while it is fresh: empty, or left with a
    /// short or zero header by a crash during its creation (see [`classify`]).
    /// `access` for another key, `io` for plaintext, foreign or damaged files.
    fn cipher(&self) -> R<Option<Rc<UnitCipher>>> {
        if let Some(cipher) = self.cipher.borrow().as_ref() {
            return Ok(Some(cipher.clone()));
        }
        let physical = self.physical_size()?;
        if physical == 0 {
            return Ok(None);
        }
        let start = read_header(&self.host).map_err(host)?;
        let header = match classify(&start, physical).map_err(|e| header_error(&self.path, e))? {
            HeaderState::Fresh => return Ok(None),
            HeaderState::Sealed(header) => header,
        };
        let state = state();
        let kek = current_key(&state)?;
        let cached = state.ciphers.borrow().get(header.as_bytes()).cloned();
        let cipher = match cached {
            // The same bytes were authenticated under the current key before.
            Some(cipher) => cipher,
            None => {
                let dek = header.open(kek).map_err(|e| header_error(&self.path, e))?;
                let cipher = Rc::new(UnitCipher::new(header.codec(), &dek));
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

    /// The cipher for a write, sealing a fresh header first. The header is
    /// synced before any data can follow it, so a crash never leaves data
    /// behind a missing header.
    fn cipher_for_write(&self) -> R<Rc<UnitCipher>> {
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
        let cipher = Rc::new(UnitCipher::new(Codec::NEW_FILES, &dek));
        state
            .ciphers
            .borrow_mut()
            .insert(*header.as_bytes(), cipher.clone());
        *self.cipher.borrow_mut() = Some(cipher.clone());
        Ok(cipher)
    }

    fn size(&self) -> R<u64> {
        Ok(logical_size(self.physical_size()?))
    }

    fn read(&self, len: u64, offset: u64) -> R<(Vec<u8>, bool)> {
        let Some(cipher) = self.cipher()? else {
            return Ok((Vec::new(), true));
        };
        let storage = HostStorage(&self.host);
        EncryptedFile {
            cipher: &cipher,
            storage: &storage,
        }
        .read(len, offset)
        .map_err(|e| file_error(&self.path, e))
    }

    fn write(&self, data: &[u8], offset: u64) -> R<u64> {
        if !self.writable() {
            return Err(ErrorCode::BadDescriptor);
        }
        if data.is_empty() {
            return Ok(0);
        }
        let cipher = self.cipher_for_write()?;
        let storage = HostStorage(&self.host);
        EncryptedFile {
            cipher: &cipher,
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
        let cipher = match self.cipher()? {
            Some(cipher) => cipher,
            None if size == 0 => return Ok(()),
            None => self.cipher_for_write()?,
        };
        let storage = HostStorage(&self.host);
        EncryptedFile {
            cipher: &cipher,
            storage: &storage,
        }
        .set_size(size)
        .map_err(|e| file_error(&self.path, e))
    }
}

// ------------------------------------------------------------------ preopen roots

/// Check a preopen before pglite may touch it (see [`crate::marker`]).
fn open_root(dir: &hfs::Descriptor) -> Result<(), ErrorCode> {
    let state = state();
    let marker = read_marker(dir)?;
    let has_data = root_has_data(dir)?;
    match marker::decide(&state.keys, marker.as_deref(), has_data) {
        RootDecision::Ready => Ok(()),
        RootDecision::Initialize => write_marker(dir, current_key(&state)?),
        RootDecision::Rotate => {
            let (current, previous) = (
                current_key(&state)?,
                state.keys.previous().ok_or(ErrorCode::Access)?,
            );
            let count = rewrap_tree(dir, previous, current, true)?;
            dir.sync().map_err(host)?;
            write_marker(dir, current)?;
            log(&format!(
                "key rotation complete: re-wrapped {count} file keys; DI_PGLITE_KEY_PREVIOUS can be removed"
            ));
            Ok(())
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
            .read_at(0, MARKER_LEN as u64 + 1)
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

/// Write the marker for `kek` atomically: a synced temporary file renamed
/// over the marker, then a directory sync.
fn write_marker(dir: &hfs::Descriptor, kek: &Kek) -> R<()> {
    let file = dir
        .open_at(
            hfs::PathFlags::empty(),
            MARKER_TMP_NAME,
            hfs::OpenFlags::CREATE | hfs::OpenFlags::TRUNCATE,
            hfs::DescriptorFlags::READ | hfs::DescriptorFlags::WRITE,
        )
        .map_err(host)?;
    HostStorage(&file)
        .write_at(0, &marker::encode(kek.kcv()))
        .map_err(host)?;
    file.sync().map_err(host)?;
    dir.rename_at(MARKER_TMP_NAME, dir, MARKER_NAME)
        .map_err(host)?;
    dir.sync().map_err(host)
}

/// Re-wrap every file header under `from` to `to`; returns how many changed.
/// Headers already under `to` are skipped, so an interrupted sweep resumes.
/// The markers and the root's `lost+found` (fsck fragments, never encfs
/// files) are not visited.
fn rewrap_tree(dir: &hfs::Descriptor, from: &Kek, to: &Kek, root: bool) -> R<usize> {
    let mut count = 0;
    let entries = dir.read_directory().map_err(host)?;
    while let Some(entry) = entries.read_directory_entry().map_err(host)? {
        if marker::is_skipped_by_rotation(&entry.name, root) {
            continue;
        }
        match entry.type_ {
            hfs::DescriptorType::Directory => {
                let sub = dir
                    .open_at(
                        hfs::PathFlags::empty(),
                        &entry.name,
                        hfs::OpenFlags::DIRECTORY,
                        hfs::DescriptorFlags::READ,
                    )
                    .map_err(host)?;
                count += rewrap_tree(&sub, from, to, false)?;
            }
            hfs::DescriptorType::RegularFile => {
                let file = dir
                    .open_at(
                        hfs::PathFlags::empty(),
                        &entry.name,
                        hfs::OpenFlags::empty(),
                        hfs::DescriptorFlags::READ | hfs::DescriptorFlags::WRITE,
                    )
                    .map_err(host)?;
                let physical = file.stat().map_err(host)?.size;
                if physical == 0 {
                    continue;
                }
                let start = read_header(&file).map_err(host)?;
                // A file left fresh by a crash has no key to re-wrap.
                let header =
                    match classify(&start, physical).map_err(|e| header_error(&entry.name, e))? {
                        HeaderState::Fresh => continue,
                        HeaderState::Sealed(header) => header,
                    };
                if to.matches(header.kcv()) {
                    continue;
                }
                let rewrapped = header
                    .rewrap(from, to, &random())
                    .map_err(|e| header_error(&entry.name, e))?;
                HostStorage(&file)
                    .write_at(0, rewrapped.as_bytes())
                    .map_err(host)?;
                file.sync().map_err(host)?;
                count += 1;
            }
            _ => {}
        }
    }
    Ok(count)
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
        root: bool,
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
                    Ok(()) => {
                        let flags = dir
                            .get_flags()
                            .map(guest_flags)
                            .unwrap_or(xfs::DescriptorFlags::READ);
                        Descriptor::Passthrough {
                            host: dir,
                            flags,
                            root: true,
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
    /// marker out of reach at the root.
    fn guard(&self, path: Option<&str>) -> R<()> {
        match self {
            Descriptor::Locked { error, .. } => Err(*error),
            Descriptor::Passthrough { root: true, .. }
                if path.is_some_and(marker::is_marker_path) =>
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
}

/// Whether two host descriptors may name the same directory. Paths alone miss
/// a symlink back to the root, so compare what the host identifies them by. A
/// failed lookup answers yes: treating a directory as the root only hides and
/// guards the marker names in it.
fn may_be_same_directory(a: &hfs::Descriptor, b: &hfs::Descriptor) -> bool {
    match (a.metadata_hash(), b.metadata_hash()) {
        (Ok(a), Ok(b)) => a.lower == b.lower && a.upper == b.upper,
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
                Some(entry)
                    if self.hide_marker
                        && (entry.name == MARKER_NAME || entry.name == MARKER_TMP_NAME) =>
                {
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
        self.host().sync_data().map_err(host)
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
        self.host().sync().map_err(host)
    }

    fn create_directory_at(&self, path: String) -> R<()> {
        self.guard(Some(&path))?;
        self.host().create_directory_at(&path).map_err(host)
    }

    fn stat(&self) -> R<xfs::DescriptorStat> {
        self.host().stat().map(guest_stat).map_err(host)
    }

    fn stat_at(&self, path_flags: xfs::PathFlags, path: String) -> R<xfs::DescriptorStat> {
        self.guard(Some(&path))?;
        self.host()
            .stat_at(host_path_flags(path_flags), &path)
            .map(guest_stat)
            .map_err(host)
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
            // The root reopened (`.`, `pglite/..`, a symlink to it) keeps the
            // marker guard and listing filter (#207).
            let root = self.is_root()
                && stat.type_ == hfs::DescriptorType::Directory
                && (marker::is_root_path(&path) || may_be_same_directory(&fd, self.host()));
            return Ok(xfs::Descriptor::new(Descriptor::Passthrough {
                host: fd,
                flags,
                root,
            }));
        }
        let file = File {
            host: fd,
            flags,
            path,
            cipher: RefCell::default(),
        };
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
        self.host()
            .rename_at(&old_path, target.host(), &new_path)
            .map_err(host)
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
        self.host().symlink_at(&old_path, &new_path).map_err(host)
    }

    fn unlink_file_at(&self, path: String) -> R<()> {
        self.guard(Some(&path))?;
        self.host().unlink_file_at(&path).map_err(host)
    }
}

bindings::export!(Component with_types_in bindings);
