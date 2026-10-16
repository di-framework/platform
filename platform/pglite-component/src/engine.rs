//! Socket-free transport to the engine component, linked into our artifact.
use crate::di_framework::pglite_engine::engine;
use crate::di_framework::pglite_engine_bootstrap::bootstrap;
use std::{
    cell::RefCell,
    collections::VecDeque,
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
};

/// Bundled PostgreSQL version this component was built against.
///
/// Must stay in sync with the engine source (`POSTGRES_SOURCE_TAG=REL_17_11`
/// in `scripts/tool-versions.env`), which `server_version()` in `lib.rs`
/// reports. The smoke consumer asserts `version.contains("17.11")`.
pub(crate) const POSTGRES_VERSION: &str = "17.11";
/// Major version recorded in `PG_VERSION` for a compatible data directory.
const POSTGRES_MAJOR: &str = "17";

/// Database that holds application data in data directories this provider
/// initializes (#212).
pub(crate) const DEDICATED_DATABASE: &str = "postgres";
/// Database that holds application data in data directories without the
/// marker: every directory initialized before #212, and any directory whose
/// first open stopped before the marker was written.
pub(crate) const LEGACY_DATABASE: &str = "template1";
/// Marker inside PGDATA (`<root>/data/`) that records that this provider
/// initialized the directory and keeps application data in
/// [`DEDICATED_DATABASE`]. Its content is that database name. Written and
/// read only through [`marker_path`], so the two cannot drift apart. It is
/// part of the data directory: back it up and restore it with PGDATA.
pub(crate) const DATABASE_MARKER: &str = "di-framework-database";

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    /// Database the engine booted into, and the directory's default.
    databases: Option<Databases>,
    busy: bool,
    poisoned: bool,
}

/// The databases chosen when the engine instance booted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Databases {
    /// What `open-options.database = none` means for this data directory.
    pub default: &'static str,
    /// What the single-user backend is connected to. Fixed for the lifetime
    /// of the engine instance.
    pub session: &'static str,
}
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

pub struct Transport {
    replies: VecDeque<u8>,
    pub fresh: bool,
    healthy: bool,
}

pub fn data_root(path: &str) -> Result<PathBuf, String> {
    let path = if path.is_empty() {
        "/data/pglite"
    } else {
        path
    };
    let root = Path::new(path);
    if !root.is_absolute()
        || root.components().any(|p| matches!(p, Component::ParentDir))
        || path.contains('\0')
    {
        return Err("database path must be an absolute directory inside a WASI preopen, without '..' or NUL".into());
    }
    Ok(root.components().collect())
}

/// Accept only names this engine can boot into.
///
/// `none` keeps the directory default (see [`default_database`]). Explicit
/// `postgres` and `template1` are allowed: initdb creates both, in old and new
/// data directories alike. `template0` is always refused: it is the pristine
/// template, and a single-user backend does not enforce `datallowconn`, so an
/// open would make it writable. Any other name is refused as well (a fixed
/// list rather than a catalog lookup, because the database must be chosen
/// before the backend starts).
pub(crate) fn requested_database(name: Option<&str>) -> Result<Option<&'static str>, String> {
    match name {
        None => Ok(None),
        Some(DEDICATED_DATABASE) => Ok(Some(DEDICATED_DATABASE)),
        Some(LEGACY_DATABASE) => Ok(Some(LEGACY_DATABASE)),
        Some("template0") => Err(
            "database \"template0\" cannot be opened: it is the read-only template".into(),
        ),
        Some(other) => Err(format!(
            "unsupported database {other:?}: this embedded engine opens only \"{DEDICATED_DATABASE}\" or \"{LEGACY_DATABASE}\""
        )),
    }
}

/// The database a later open in the same engine instance gets.
///
/// The single-user backend stays in the database it booted into, so a
/// request for any other database fails instead of silently using it.
pub(crate) fn reuse_database(
    booted: Databases,
    requested: Option<&'static str>,
) -> Result<&'static str, String> {
    let wanted = requested.unwrap_or(booted.default);
    if wanted == booted.session {
        Ok(wanted)
    } else {
        Err(format!(
            "this engine instance is connected to database \"{}\" and cannot switch to \"{wanted}\"; restart the component to open another database",
            booted.session
        ))
    }
}

/// Where the database marker lives: inside PGDATA, next to `PG_VERSION`.
pub(crate) fn marker_path(data: &Path) -> PathBuf {
    data.join(DATABASE_MARKER)
}

/// Parse the marker content written by [`write_marker`].
pub(crate) fn parse_marker(content: &str) -> Result<&'static str, String> {
    match content.trim_end_matches(['\r', '\n']) {
        DEDICATED_DATABASE => Ok(DEDICATED_DATABASE),
        other => Err(format!(
            "unrecognized {DATABASE_MARKER} marker {other:?} in the data directory; expected \"{DEDICATED_DATABASE}\""
        )),
    }
}

/// The default database of an initialized data directory: no marker means
/// [`LEGACY_DATABASE`].
pub(crate) fn default_database(data: &Path) -> Result<&'static str, String> {
    let path = marker_path(data);
    match fs::read_to_string(&path) {
        Ok(content) => parse_marker(&content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LEGACY_DATABASE),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

/// Record that this directory keeps application data in
/// [`DEDICATED_DATABASE`] (atomic and durable; see [`write_atomic`]).
pub(crate) fn write_marker(data: &Path) -> Result<(), String> {
    write_atomic(
        &marker_path(data),
        format!("{DEDICATED_DATABASE}\n").as_bytes(),
        false,
    )
}

/// What `Transport::open` hands back to the session.
pub struct Opened {
    pub transport: Transport,
    pub password: String,
    /// The database the session must be connected to.
    pub database: &'static str,
}

impl Transport {
    pub fn open(path: &str, database: Option<&str>) -> Result<Opened, String> {
        let requested = requested_database(database)?;
        let root = data_root(path)?;
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if state.poisoned { return Err("engine is unusable; restart the component".into()); }
            if state.busy { return Err("one open connection per engine is supported; close the existing connection first".into()); }
            if state.root.as_ref().is_some_and(|old| old != &root) {
                return Err("one data directory per component instance is supported".into());
            }
            let (fresh, database) = match state.databases {
                Some(booted) => (false, reuse_database(booted, requested)?),
                None => {
                    // A partially initialized engine cannot be booted again in the same memory.
                    state.poisoned = true;
                    prepare_cluster(&root)?;
                    // The bootstrap instance (if it ran) belongs to this root now.
                    state.root = Some(root.clone());
                    state.poisoned = false;
                    // No engine runs while choosing, so a refusal here (for
                    // example a database with no data directory) leaves the
                    // instance usable for another open.
                    let chosen = choose_databases(&root.join("data"), requested)?;
                    state.poisoned = true;
                    start_serving(&root, chosen.session)?;
                    state.databases = Some(chosen);
                    state.poisoned = false;
                    (true, chosen.session)
                }
            };
            let password = fs::read_to_string(root.join("runtime/password")).map_err(|e| e.to_string())?;
            state.busy = true;
            Ok(Opened {
                transport: Self { replies: VecDeque::new(), fresh, healthy: false },
                password: password.trim_end_matches(['\r', '\n']).into(),
                database,
            })
        })
    }

    pub fn mark_healthy(&mut self) {
        self.healthy = true;
    }

    pub fn write_all(&mut self, payload: &[u8]) -> Result<(), String> {
        if !engine::write(payload) {
            return Err("request exceeds the engine's shared-memory buffer".into());
        }
        // interactive_one consumes this complete batch, including Sync. Do
        // not poll it: its prologue resets PostgreSQL's MessageContext.
        engine::step();
        let reply = engine::read();
        self.replies.extend(reply);
        Ok(())
    }

    pub fn poison(&mut self) {
        self.healthy = false;
    }

    pub fn read_exact(&mut self, out: &mut [u8]) -> Result<(), String> {
        if self.replies.len() < out.len() {
            self.healthy = false;
            return Err("incomplete response from embedded engine".into());
        }
        for byte in out {
            // Length was checked above, so a missing byte is unreachable;
            // return an error instead of panicking (`panic=abort` would trap
            // the whole engine).
            let next = self
                .replies
                .pop_front()
                .ok_or_else(|| "incomplete response from embedded engine".to_string())?;
            *byte = next;
        }
        Ok(())
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            state.busy = false;
            state.poisoned |= !self.healthy;
        });
    }
}

fn install_asset(runtime: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let path = runtime.join(name);
    // Version-aware: byte comparison refreshes stale assets after an upgrade
    // and heals truncated files left by a crash mid-boot. Skipping only when
    // bytes already match keeps warm boots fast.
    if fs::read(&path).ok().as_deref() == Some(bytes) {
        return Ok(());
    }
    // The bootstrap password is a secret: restrict it even if the host mount
    // defaults to world-readable files.
    let secret = name == "password" || name.ends_with("/password");
    write_atomic(&path, bytes, secret)
}

/// Atomic install: write to a temp file in the same directory, fsync it,
/// then rename over the destination and fsync the directory, so a crash
/// never leaves a truncated file that later boots would mistake for valid.
fn write_atomic(path: &Path, bytes: &[u8], secret: bool) -> Result<(), String> {
    // `parent()` is `None` only for a bare prefix (`""`/`/`); callers always
    // pass a file below a directory. Never panic here: `panic=abort` would
    // trap the whole engine.
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid file path: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("create directory {}: {e}", parent.display()))?;
    let tmp = {
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(OsStr::new(".di-tmp"));
        PathBuf::from(tmp)
    };
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    if secret {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
    }
    fs::File::open(&tmp)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("install {}: {e}", path.display()))?;
    // Make the rename durable: sync the file and its containing directory.
    fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync {}: {e}", path.display()))?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync dir {}: {e}", parent.display()))?;
    Ok(())
}

/// The calls a boot needs from one instance of the engine component.
struct EngineInstance {
    set_env: fn(&str, &str) -> i32,
    start: fn(&[String]) -> i32,
    initdb: fn() -> i32,
    backend: fn(),
}

/// Serves every session. Always boots on an existing cluster.
const SERVING_ENGINE: EngineInstance = EngineInstance {
    set_env: engine::set_env,
    start: engine::start,
    initdb: engine::initdb,
    backend: engine::backend,
};

/// Single-use: runs initdb on an empty data directory and is never used again.
const BOOTSTRAP_ENGINE: EngineInstance = EngineInstance {
    set_env: bootstrap::set_env,
    start: bootstrap::start,
    initdb: bootstrap::initdb,
    backend: bootstrap::backend,
};

/// Configure and start `instance`, then run its initdb step: a full initdb
/// on an empty PGDATA, or only the "cluster exists" check on an existing one.
///
/// `database` becomes `PGDATABASE`. On an existing cluster the engine's
/// backend boots the single-user session into that database. Right after a
/// fresh initdb the engine ignores it: that first backend runs initdb's
/// post-bootstrap SQL in `template1` and stays there.
fn start_engine(
    instance: &EngineInstance,
    runtime: &Path,
    data: &Path,
    database: &str,
) -> Result<(), String> {
    let runtime_str = runtime.to_str().ok_or("invalid runtime path")?;
    let data_str = data.to_str().ok_or("invalid data path")?;
    for (name, value) in [
        ("ENVIRONMENT", "wasm32_wasi_preview1"),
        ("PREFIX", runtime_str),
        ("PGDATA", data_str),
        ("PGSYSCONFDIR", runtime_str),
        ("PGUSER", "postgres"),
        ("PGDATABASE", database),
        ("SHM", "./../shm"),
        ("MODE", "REACT"),
        ("REPL", "N"),
        ("PGCLIENTENCODING", "UTF8"),
        ("LC_CTYPE", "en_US.UTF-8"),
        ("TZ", "UTC"),
        ("PGTZ", "UTC"),
    ] {
        if (instance.set_env)(name, value) != 0 {
            return Err(format!("set engine environment: {name}"));
        }
    }
    let args = vec![
        format!("{runtime_str}/bin/postgres"),
        "--single".into(),
        "postgres".into(),
    ];
    if (instance.start)(&args) != 0 {
        return Err("engine startup failed".into());
    }
    let rc = (instance.initdb)();
    if rc & 1 != 0 || !data.join("PG_VERSION").exists() {
        return Err(format!("initdb failed ({rc}): no PG_VERSION"));
    }
    ensure_durability(data)
}

/// initdb's WASI defaults favor speed. Require durable writes on the mounted
/// filesystem before starting the backend, on both fresh and reused clusters.
fn ensure_durability(data: &Path) -> Result<(), String> {
    let conf = data.join("postgresql.conf");
    let mut config = fs::read_to_string(&conf).map_err(|e| e.to_string())?;
    const DURABILITY_MARKER: &str = "di-framework embedded durability";
    const DURABILITY: &str =
        "\n# di-framework embedded durability\nfsync = on\nsynchronous_commit = on\nfull_page_writes = on\n";
    // `contains` (not `ends_with`): an operator may append settings after our
    // block, and a crash-retry must not duplicate the block on every boot.
    if !config.contains(DURABILITY_MARKER) {
        config.push_str(DURABILITY);
        fs::write(&conf, config).map_err(|e| e.to_string())?;
        fs::File::open(&conf)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create a cluster in the empty `data` directory with the single-use
/// bootstrap engine instance, then write the database marker.
///
/// Crash windows (each one leaves the directory safe on the next boot):
/// 1. During initdb, before `PG_VERSION` and `global/pg_control` both exist:
///    `prepare_cluster` refuses the directory ("nonempty but has no PG_VERSION" or
///    "incomplete cluster") until the operator removes it. Unchanged by #212.
/// 2. After initdb, before or during the post-bootstrap SQL that the
///    bootstrap backend runs: there is no marker, so later boots use
///    `template1`. The catalogs may be incomplete, as before #212.
/// 3. After the post-bootstrap SQL, before the marker rename is durable: no
///    marker, so the directory is treated as a legacy one and uses
///    `template1` from then on. No application session has run yet (they
///    start only after this function returns), so nothing is stranded in
///    `postgres`; the cost is that this directory keeps the pre-#212 layout.
/// 4. After the marker is durable: every later boot uses `postgres`. The
///    first application session runs only after this point, so a directory
///    without the marker never has application data in `postgres`.
///
/// The marker is never written for a directory that already had
/// `PG_VERSION` when this boot started, so legacy directories (data in
/// `template1`) never flip.
fn initialize_cluster(root: &Path, runtime: &Path, data: &Path) -> Result<(), String> {
    start_engine(&BOOTSTRAP_ENGINE, runtime, data, LEGACY_DATABASE)?;
    // Runs initdb's post-bootstrap SQL, which creates `template0` and
    // `postgres` from a `template1` session. This instance is not used again.
    (BOOTSTRAP_ENGINE.backend)();
    // initdb may skip its syncs in embedded builds (the bootstrap backend
    // runs with fsync off). Flush the whole cluster before the marker so the
    // marker never outlives the catalogs it describes.
    sync_tree(data)?;
    fs::File::open(root)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync database root: {e}"))?;
    write_marker(data)
}

/// Install the runtime, validate PGDATA, and create the cluster with the
/// bootstrap instance when PGDATA is empty. Starts no serving engine.
fn prepare_cluster(root: &Path) -> Result<(), String> {
    let runtime = root.join("runtime");
    let data = root.join("data");
    fs::create_dir_all(&runtime).map_err(|e| format!("create runtime directory: {e}"))?;
    for (name, bytes) in ASSETS {
        install_asset(&runtime, name, bytes)?;
    }
    // Persist directory entries for newly installed assets.
    fs::File::open(&runtime)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync runtime directory: {e}"))?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let initializing = if data.join("PG_VERSION").exists() {
        let version = fs::read_to_string(data.join("PG_VERSION")).map_err(|e| e.to_string())?;
        check_data_version(&version)?;
        if !data.join("global/pg_control").is_file() {
            return Err(
                "incomplete cluster; restore or remove the failed initialization before retrying"
                    .into(),
            );
        }
        false
    } else if fs::read_dir(&data)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err(
            "data directory is nonempty but has no PG_VERSION; refusing to initialize it".into(),
        );
    } else {
        true
    };
    if initializing {
        initialize_cluster(root, &runtime, &data)?;
    }
    Ok(())
}

/// Directory of a built-in database under PGDATA. initdb (PostgreSQL 15
/// and later) creates them with fixed OIDs: `template1` = 1 and
/// `postgres` = 5 (`PostgresDbOid`).
pub(crate) fn database_dir(name: &str) -> Option<&'static str> {
    match name {
        LEGACY_DATABASE => Some("base/1"),
        DEDICATED_DATABASE => Some("base/5"),
        _ => None,
    }
}

/// Pick the session database of an initialized cluster.
///
/// Decided after initdb and before the serving backend starts, from the
/// marker that `initialize_cluster` writes, so the first session of a new
/// directory already runs in `postgres`.
///
/// A database whose fixed-OID directory is missing is refused here, with
/// `open-failed` instead of a FATAL error that traps the component. This is a
/// filesystem check, not a catalog lookup, so it is incomplete in both
/// directions:
/// - In crash window 2, `CREATE DATABASE postgres` (FILE_COPY) copies
///   `base/1` to `base/5` before it commits the `pg_database` row. A crash in
///   between leaves `base/5` without a `postgres` database: the check passes
///   and an explicit `postgres` open still traps. Only an initdb that crashed
///   partway through produces this state; such a directory must be re-created
///   or restored, not used.
/// - A `postgres` database that was dropped and re-created (new OID) or moved
///   to another tablespace has no `base/5` and is refused although it exists.
pub(crate) fn choose_databases(
    data: &Path,
    requested: Option<&'static str>,
) -> Result<Databases, String> {
    let default = default_database(data)?;
    let session = requested.unwrap_or(default);
    let present = database_dir(session).is_some_and(|dir| data.join(dir).is_dir());
    if !present {
        return Err(format!(
            "database \"{session}\" has no data directory at {} (initdb crashed before creating it, or the database was re-created with a different OID or moved to another tablespace); open template1, or re-create or restore the data directory",
            database_dir(session).unwrap_or("base/?")
        ));
    }
    Ok(Databases { default, session })
}

/// Boot the serving engine on the prepared cluster in `session`.
fn start_serving(root: &Path, session: &str) -> Result<(), String> {
    start_engine(
        &SERVING_ENGINE,
        &root.join("runtime"),
        &root.join("data"),
        session,
    )?;
    (SERVING_ENGINE.backend)();
    Ok(())
}

/// README section that explains moving a database between major versions.
const MAJOR_UPGRADE_DOCS: &str =
    "platform/pglite-component/README.md#upgrading-across-postgresql-major-versions";

/// Refuse a data directory written by another PostgreSQL major version.
///
/// `found` is the content of `PG_VERSION`. The error names the version found,
/// the version this engine needs, and where the upgrade steps are documented.
fn check_data_version(found: &str) -> Result<(), String> {
    let found = found.trim();
    if found == POSTGRES_MAJOR {
        return Ok(());
    }
    let found = if found.is_empty() { "(empty)" } else { found };
    Err(format!(
        "incompatible PostgreSQL data directory: PG_VERSION is {found}, but this provider \
         bundles PostgreSQL {POSTGRES_VERSION} and opens only major version {POSTGRES_MAJOR} \
         data directories; see {MAJOR_UPGRADE_DOCS}"
    ))
}

fn sync_tree(dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            fs::File::open(entry.path())
                .and_then(|f| f.sync_all())
                .map_err(|e| format!("sync initial database: {e}"))?;
        }
    }
    fs::File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync database directory: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        check_data_version, choose_databases, data_root, database_dir, default_database,
        marker_path, parse_marker, requested_database, reuse_database, write_marker, Databases,
        DATABASE_MARKER, DEDICATED_DATABASE, LEGACY_DATABASE, POSTGRES_MAJOR, POSTGRES_VERSION,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A fresh, empty directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "df-pglite-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn requested_database_allows_postgres_and_template1_only() {
        assert_eq!(requested_database(None), Ok(None));
        assert_eq!(requested_database(Some("postgres")), Ok(Some("postgres")));
        assert_eq!(requested_database(Some("template1")), Ok(Some("template1")));
        let err = requested_database(Some("template0")).unwrap_err();
        assert!(err.contains("\"template0\" cannot be opened"), "{err}");
        for name in ["orders", "", "Postgres", "template1 ", "postgres\0"] {
            let err = requested_database(Some(name)).unwrap_err();
            assert!(err.starts_with("unsupported database"), "{name:?}: {err}");
        }
    }

    #[test]
    fn missing_marker_means_template1() {
        let dir = TempDir::new("no-marker");
        assert_eq!(default_database(&dir.0), Ok(LEGACY_DATABASE));
    }

    #[test]
    fn marker_is_written_atomically_where_it_is_read() {
        let dir = TempDir::new("marker");
        write_marker(&dir.0).unwrap();
        assert_eq!(marker_path(&dir.0), dir.0.join(DATABASE_MARKER));
        assert_eq!(
            fs::read_to_string(dir.0.join(DATABASE_MARKER)).unwrap(),
            "postgres\n"
        );
        assert_eq!(default_database(&dir.0), Ok(DEDICATED_DATABASE));
        // No temp file is left behind after the rename.
        let names: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec![DATABASE_MARKER.to_string()]);
        // Rewriting is idempotent.
        write_marker(&dir.0).unwrap();
        assert_eq!(default_database(&dir.0), Ok(DEDICATED_DATABASE));
    }

    #[test]
    fn unknown_marker_content_is_refused() {
        assert_eq!(parse_marker("postgres"), Ok("postgres"));
        assert_eq!(parse_marker("postgres\r\n"), Ok("postgres"));
        for content in ["", "template1\n", "orders\n", "postgres extra"] {
            let err = parse_marker(content).unwrap_err();
            assert!(
                err.contains("unrecognized di-framework-database marker"),
                "{err}"
            );
        }
        let dir = TempDir::new("bad-marker");
        fs::write(dir.0.join(DATABASE_MARKER), "template0\n").unwrap();
        assert!(default_database(&dir.0).is_err());
    }

    #[test]
    fn a_missing_database_is_refused_before_boot() {
        let dir = TempDir::new("choose");
        let data = &dir.0;
        // Crash window 2: template1 exists, postgres was never created.
        fs::create_dir_all(data.join("base/1")).unwrap();
        assert_eq!(
            choose_databases(data, None),
            Ok(Databases {
                default: "template1",
                session: "template1"
            })
        );
        let err = choose_databases(data, Some("postgres")).unwrap_err();
        assert!(
            err.starts_with("database \"postgres\" has no data directory at base/5"),
            "{err}"
        );
        // A marked directory whose postgres directory is gone fails the same way.
        write_marker(data).unwrap();
        assert!(choose_databases(data, None).is_err());
        fs::create_dir_all(data.join("base/5")).unwrap();
        assert_eq!(
            choose_databases(data, None),
            Ok(Databases {
                default: "postgres",
                session: "postgres"
            })
        );
        assert_eq!(
            choose_databases(data, Some("template1")),
            Ok(Databases {
                default: "postgres",
                session: "template1"
            })
        );
        assert_eq!(database_dir("template0"), None);
    }

    #[test]
    fn later_opens_must_match_the_booted_database() {
        let fresh = Databases {
            default: "postgres",
            session: "postgres",
        };
        assert_eq!(reuse_database(fresh, None), Ok("postgres"));
        assert_eq!(reuse_database(fresh, Some("postgres")), Ok("postgres"));
        let err = reuse_database(fresh, Some("template1")).unwrap_err();
        assert!(err.contains("connected to database \"postgres\""), "{err}");
        assert!(err.contains("cannot switch to \"template1\""), "{err}");

        let legacy = Databases {
            default: "template1",
            session: "template1",
        };
        assert_eq!(reuse_database(legacy, None), Ok("template1"));
        assert!(reuse_database(legacy, Some("postgres")).is_err());

        // Booted with an explicit override: `none` means the directory
        // default, which this instance is not connected to.
        let overridden = Databases {
            default: "postgres",
            session: "template1",
        };
        assert_eq!(
            reuse_database(overridden, Some("template1")),
            Ok("template1")
        );
        assert!(reuse_database(overridden, None).is_err());
    }

    #[test]
    fn data_version_must_match_the_bundled_major() {
        assert_eq!(POSTGRES_VERSION, "17.11");
        assert_eq!(check_data_version(POSTGRES_MAJOR), Ok(()));
        assert_eq!(check_data_version("17\n"), Ok(()));

        let err = check_data_version("16\n").unwrap_err();
        assert_eq!(
            err,
            "incompatible PostgreSQL data directory: PG_VERSION is 16, but this provider \
             bundles PostgreSQL 17.11 and opens only major version 17 data directories; \
             see platform/pglite-component/README.md#upgrading-across-postgresql-major-versions"
        );
        assert!(check_data_version("18").unwrap_err().contains("PG_VERSION is 18,"));
        assert!(check_data_version("  ").unwrap_err().contains("PG_VERSION is (empty),"));
    }

    #[test]
    fn roots_are_absolute_and_do_not_traverse() {
        assert_eq!(data_root("").unwrap(), Path::new("/data/pglite"));
        assert_eq!(
            data_root("/data/./orders/").unwrap(),
            Path::new("/data/orders")
        );
        for path in [
            "orders",
            "localhost:5432",
            "/data/../orders",
            "/data/with\0nul",
        ] {
            assert!(data_root(path).is_err());
        }
    }
}
