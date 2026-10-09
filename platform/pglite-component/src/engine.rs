//! Socket-free transport to the engine component, linked into our artifact.
use crate::di_framework::pglite_engine::engine;
use std::{
    cell::RefCell,
    collections::VecDeque,
    fs,
    path::{Component, Path, PathBuf},
};

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
            *byte = self.replies.pop_front().unwrap();
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

fn boot(root: &Path) -> Result<(), String> {
    let runtime = root.join("runtime");
    let data = root.join("data");
    fs::create_dir_all(&runtime).map_err(|e| format!("create runtime directory: {e}"))?;
    for (name, bytes) in ASSETS {
        let path = runtime.join(name);
        if !path.exists() {
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        }
    }
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    if data.join("PG_VERSION").exists() {
        let version = fs::read_to_string(data.join("PG_VERSION")).map_err(|e| e.to_string())?;
        if version.trim() != "17" {
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
    const DURABILITY: &str = "\n# di-framework embedded durability\nfsync = on\nsynchronous_commit = on\nfull_page_writes = on\n";
    if !config.ends_with(DURABILITY) {
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
