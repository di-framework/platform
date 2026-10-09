//! Socket-free transport to the engine component, linked into our artifact.
use crate::di_framework::pglite_engine::engine;
use std::{
    cell::RefCell,
    collections::VecDeque,
    ffi::OsStr,
    fs,
    path::{Component, Path, PathBuf},
};

/// Bundled PostgreSQL major version this component was built against.
///
/// Must stay in sync with the engine recipe (`PG_VERSION=17.5` in
/// `scripts/build-engine.sh` via `PGLITE_SOURCE_REF`) and with
/// `server_version()` in `lib.rs`. The smoke consumer asserts
/// `version.contains("17.5")`.
pub(crate) const POSTGRES_VERSION: &str = "17.5";
/// Major version recorded in `PG_VERSION` for a compatible data directory.
const POSTGRES_MAJOR: &str = "17";

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

#[derive(Default)]
struct State {
    root: Option<PathBuf>,
    busy: bool,
    poisoned: bool,
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

impl Transport {
    pub fn open(path: &str, database: &str) -> Result<(Self, String), String> {
        if database != "template1" {
            return Err(
                "this embedded engine currently supports only the template1 database".into(),
            );
        }
        let root = data_root(path)?;
        STATE.with(|state| {
            let mut state = state.borrow_mut();
            if state.poisoned { return Err("engine is unusable; restart the component".into()); }
            if state.busy { return Err("one open connection per engine is supported; close the existing connection first".into()); }
            if state.root.as_ref().is_some_and(|old| old != &root) {
                return Err("one data directory per component instance is supported".into());
            }
            let fresh = state.root.is_none();
            if fresh {
                // A partially initialized engine cannot be booted again in the same memory.
                state.poisoned = true;
                boot(&root)?;
                state.root = Some(root.clone());
                state.poisoned = false;
            }
            let password = fs::read_to_string(root.join("runtime/password")).map_err(|e| e.to_string())?;
            state.busy = true;
            Ok((Self { replies: VecDeque::new(), fresh, healthy: false }, password.trim_end_matches(['\r', '\n']).into()))
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
    // `parent()` is `None` only for a bare prefix (`""`/`/`); asset names are
    // always relative (`share/...`, `runtime/password`, ...). Never panic here:
    // `panic=abort` would trap the whole engine.
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid asset path: {name:?}"))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("create asset dir {}: {e}", parent.display()))?;
    // Atomic install: write to a temp file in the same directory, fsync it,
    // then rename over the destination so a crash never leaves a truncated
    // file that later boots would mistake for valid.
    let tmp = {
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(OsStr::new(".di-tmp"));
        PathBuf::from(tmp)
    };
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    // The bootstrap password is a secret: restrict it even if the host mount
    // defaults to world-readable files.
    if name == "password" || name.ends_with("/password") {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
    }
    fs::File::open(&tmp)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("install {}: {e}", path.display()))?;
    // Make the rename durable: sync the file and its containing directory.
    fs::File::open(&path)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync {}: {e}", path.display()))?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync dir {}: {e}", parent.display()))?;
    Ok(())
}

fn boot(root: &Path) -> Result<(), String> {
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
    if data.join("PG_VERSION").exists() {
        let version = fs::read_to_string(data.join("PG_VERSION")).map_err(|e| e.to_string())?;
        if version.trim() != POSTGRES_MAJOR {
            return Err(format!(
                "incompatible PostgreSQL data version: {}",
                version.trim()
            ));
        }
        if !data.join("global/pg_control").is_file() {
            return Err(
                "incomplete cluster; restore or remove the failed initialization before retrying"
                    .into(),
            );
        }
    } else if fs::read_dir(&data)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err(
            "data directory is nonempty but has no PG_VERSION; refusing to initialize it".into(),
        );
    }
    let runtime_str = runtime.to_str().ok_or("invalid runtime path")?;
    let data_str = data.to_str().ok_or("invalid data path")?;
    for (name, value) in [
        ("ENVIRONMENT", "wasm32_wasi_preview1"),
        ("PREFIX", runtime_str),
        ("PGDATA", data_str),
        ("PGSYSCONFDIR", runtime_str),
        ("PGUSER", "postgres"),
        ("PGDATABASE", "template1"),
        ("SHM", "./../shm"),
        ("MODE", "REACT"),
        ("REPL", "N"),
        ("PGCLIENTENCODING", "UTF8"),
        ("LC_CTYPE", "en_US.UTF-8"),
        ("TZ", "UTC"),
        ("PGTZ", "UTC"),
    ] {
        if engine::set_env(name, value) != 0 {
            return Err(format!("set engine environment: {name}"));
        }
    }
    let args = vec![
        format!("{runtime_str}/bin/postgres"),
        "--single".into(),
        "postgres".into(),
    ];
    if engine::start(&args) != 0 {
        return Err("engine startup failed".into());
    }
    let initializing = !data.join("PG_VERSION").exists();
    let rc = engine::initdb();
    if rc & 1 != 0 || !data.join("PG_VERSION").exists() {
        return Err(format!("initdb failed ({rc}): no PG_VERSION"));
    }
    // initdb's WASI defaults favor speed. Require durable writes on the mounted
    // filesystem before starting the backend, on both fresh and reused clusters.
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
    if initializing {
        // initdb may skip its final sync in embedded builds. Flush the initial
        // catalogs before accepting the first transaction.
        sync_tree(&data)?;
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("sync database root: {e}"))?;
    }
    engine::backend();
    Ok(())
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
    use super::data_root;
    use std::path::Path;

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
