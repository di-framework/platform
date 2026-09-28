//! `di-framework:sqlite@0.1.0` provider component.
//!
//! Bundled SQLite (via `rusqlite`/`libsqlite3-sys` with the `bundled` and
//! `wasm32-wasi-vfs` features) exposed through the component-model interface
//! declared in `wit/world.wit`. The database file lives on the WASI filesystem
//! that the host preopens for the component (a mounted volume), reached via the
//! `wasi:filesystem` imports the Rust `wasm32-wasip2` target links in.
//!
//! Persistence model (see README): rollback journal (`journal_mode=DELETE` by
//! default), `synchronous=FULL` by default, no WAL, no file locking -> exactly
//! one component instance may own a database file at a time.

use std::cell::RefCell;
use std::time::Duration;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{ErrorCode, OpenFlags};

wit_bindgen::generate!({
    path: "wit",
    world: "sqlite-provider",
});

use exports::di_framework::sqlite::database::{
    Connection as ConnectionHandle, Error, Guest, GuestConnection, OpenOptions, Row,
    TransactionBehavior, Value,
};
// Only the types `use`d by `database` are re-exported there; the rest live on
// the `types` interface module (exported, but with no functions to implement).
use exports::di_framework::sqlite::types::{JournalMode, SqliteError, SyncMode};

struct Component;

/// Defaults applied by `open` when `open-options` leaves a field unset. Keep
/// in sync with the doc comments in `wit/world.wit`.
const DEFAULT_BUSY_TIMEOUT_MS: u32 = 5_000;

impl Guest for Component {
    type Connection = SqliteConnection;

    fn open(path: String, options: Option<OpenOptions>) -> Result<ConnectionHandle, Error> {
        let opts = options.unwrap_or(OpenOptions {
            create: None,
            read_only: None,
            synchronous: None,
            journal_mode: None,
            busy_timeout_ms: None,
            foreign_keys: None,
        });

        let read_only = opts.read_only.unwrap_or(false);
        let create = opts.create.unwrap_or(true) && !read_only;

        // Create parent directories before opening — SQLite never does this itself,
        // and WASI hosts only preopen the volume root. Parse URI filenames first so
        // `file:/data/x.db?mode=rwc` does not mkdir a path that includes `?query`.
        if create && !is_in_memory(&path) {
            if let Some(fs_path) = sqlite_uri_filesystem_path(&path) {
                if let Some(parent) = std::path::Path::new(fs_path).parent() {
                    if !parent.as_os_str().is_empty() {
                        std::fs::create_dir_all(parent).map_err(|e| {
                            Error::OpenFailed(format!(
                                "{path}: create parent directory {}: {e}",
                                parent.display()
                            ))
                        })?;
                    }
                }
            }
        }

        let mut flags = OpenFlags::SQLITE_OPEN_NO_MUTEX;
        flags |= if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        if create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }

        let conn = rusqlite::Connection::open_with_flags(&path, flags)
            .map_err(|e| Error::OpenFailed(format!("{path}: {e}")))?;

        let in_memory = is_in_memory(&path);

        // Journal + durability pragmas. Applied before anything else touches the
        // file so the first write already uses the rollback journal.
        if !read_only {
            let journal = match opts.journal_mode.unwrap_or(JournalMode::Delete) {
                JournalMode::Delete => "DELETE",
                JournalMode::Persist => "PERSIST",
                JournalMode::Memory => "MEMORY",
            };
            // Prefer execute_batch: some WASI hosts return no rows for PRAGMA
            // query_row even when the mode was applied successfully.
            conn.execute_batch(&format!("PRAGMA journal_mode = {journal};"))
                .map_err(|e| Error::OpenFailed(format!("{path}: PRAGMA journal_mode: {e}")))?;
            if let Ok(applied) = conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            {
                if !in_memory && !applied.eq_ignore_ascii_case(journal) {
                    return Err(Error::OpenFailed(format!(
                        "{path}: requested journal_mode={journal} but SQLite reports {applied}"
                    )));
                }
            }
        }

        let sync = match opts.synchronous.unwrap_or(SyncMode::Full) {
            SyncMode::Off => "OFF",
            SyncMode::Normal => "NORMAL",
            SyncMode::Full => "FULL",
        };
        let foreign_keys = if opts.foreign_keys.unwrap_or(true) { "ON" } else { "OFF" };
        conn.execute_batch(&format!(
            "PRAGMA synchronous = {sync}; PRAGMA foreign_keys = {foreign_keys};"
        ))
        .map_err(|e| Error::OpenFailed(format!("{path}: pragmas: {e}")))?;

        let busy_ms = opts.busy_timeout_ms.unwrap_or(DEFAULT_BUSY_TIMEOUT_MS);
        conn.busy_timeout(Duration::from_millis(u64::from(busy_ms)))
            .map_err(|e| Error::OpenFailed(format!("{path}: busy_timeout: {e}")))?;

        Ok(ConnectionHandle::new(SqliteConnection {
            inner: RefCell::new(Some(conn)),
        }))
    }

    fn sqlite_version() -> String {
        rusqlite::version().to_string()
    }
}

export!(Component);

pub struct SqliteConnection {
    inner: RefCell<Option<rusqlite::Connection>>,
}

impl SqliteConnection {
    fn with<T>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let guard = self.inner.borrow();
        match guard.as_ref() {
            Some(conn) => f(conn),
            None => Err(Error::Closed),
        }
    }

    fn require_transaction(conn: &rusqlite::Connection) -> Result<(), Error> {
        if conn.is_autocommit() {
            Err(Error::InvalidTransactionState("no transaction is open".into()))
        } else {
            Ok(())
        }
    }
}

impl GuestConnection for SqliteConnection {
    fn exec(&self, sql: String) -> Result<(), Error> {
        self.with(|conn| conn.execute_batch(&sql).map_err(map_exec_error))
    }

    fn run(&self, sql: String, params: Vec<Value>) -> Result<u64, Error> {
        self.with(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(map_prepare_error)?;
            bind_params(&mut stmt, &params)?;
            // Step to completion so `INSERT ... RETURNING` and friends work too;
            // the rows themselves are discarded.
            {
                let mut rows = stmt.raw_query();
                while rows.next().map_err(map_exec_error)?.is_some() {}
            }
            Ok(conn.changes())
        })
    }

    fn query(&self, sql: String, params: Vec<Value>) -> Result<Vec<Row>, Error> {
        self.with(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(map_prepare_error)?;
            bind_params(&mut stmt, &params)?;
            let columns = column_names(&stmt);

            let mut out: Vec<Row> = Vec::new();
            let mut rows = stmt.raw_query();
            while let Some(row) = rows.next().map_err(map_exec_error)? {
                out.push(read_row(row, &columns)?);
            }
            Ok(out)
        })
    }

    fn first(&self, sql: String, params: Vec<Value>) -> Result<Option<Row>, Error> {
        self.with(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(map_prepare_error)?;
            bind_params(&mut stmt, &params)?;
            let columns = column_names(&stmt);

            let mut rows = stmt.raw_query();
            match rows.next().map_err(map_exec_error)? {
                None => Ok(None),
                Some(row) => Ok(Some(read_row(row, &columns)?)),
            }
        })
    }

    fn begin(&self, behavior: Option<TransactionBehavior>) -> Result<(), Error> {
        self.with(|conn| {
            if !conn.is_autocommit() {
                return Err(Error::InvalidTransactionState(
                    "a transaction is already open; use savepoint for nesting".into(),
                ));
            }
            let sql = match behavior.unwrap_or(TransactionBehavior::Immediate) {
                TransactionBehavior::Deferred => "BEGIN DEFERRED",
                TransactionBehavior::Immediate => "BEGIN IMMEDIATE",
                TransactionBehavior::Exclusive => "BEGIN EXCLUSIVE",
            };
            conn.execute_batch(sql).map_err(map_exec_error)
        })
    }

    fn commit(&self) -> Result<(), Error> {
        self.with(|conn| {
            Self::require_transaction(conn)?;
            conn.execute_batch("COMMIT").map_err(map_exec_error)
        })
    }

    fn rollback(&self) -> Result<(), Error> {
        self.with(|conn| {
            Self::require_transaction(conn)?;
            conn.execute_batch("ROLLBACK").map_err(map_exec_error)
        })
    }

    fn savepoint(&self, name: String) -> Result<(), Error> {
        let ident = savepoint_identifier(&name)?;
        self.with(|conn| {
            conn.execute_batch(&format!("SAVEPOINT {ident}"))
                .map_err(map_exec_error)
        })
    }

    fn release_savepoint(&self, name: String) -> Result<(), Error> {
        let ident = savepoint_identifier(&name)?;
        self.with(|conn| {
            Self::require_transaction(conn)?;
            conn.execute_batch(&format!("RELEASE SAVEPOINT {ident}"))
                .map_err(map_exec_error)
        })
    }

    fn rollback_to_savepoint(&self, name: String) -> Result<(), Error> {
        let ident = savepoint_identifier(&name)?;
        self.with(|conn| {
            Self::require_transaction(conn)?;
            conn.execute_batch(&format!(
                "ROLLBACK TO SAVEPOINT {ident}; RELEASE SAVEPOINT {ident}"
            ))
            .map_err(map_exec_error)
        })
    }

    fn in_transaction(&self) -> bool {
        self.inner
            .borrow()
            .as_ref()
            .map(|conn| !conn.is_autocommit())
            .unwrap_or(false)
    }

    fn changes(&self) -> u64 {
        self.inner.borrow().as_ref().map(|c| c.changes()).unwrap_or(0)
    }

    fn last_insert_rowid(&self) -> i64 {
        self.inner
            .borrow()
            .as_ref()
            .map(|c| c.last_insert_rowid())
            .unwrap_or(0)
    }

    fn close(&self) -> Result<(), Error> {
        let conn = self.inner.borrow_mut().take().ok_or(Error::Closed)?;
        conn.close().map_err(|(conn, e)| {
            // Give the handle back so a retry is possible.
            *self.inner.borrow_mut() = Some(conn);
            map_exec_error(e)
        })
    }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// True when SQLite will open `path` as an in-memory database.
///
/// Matches `:memory:`, `file::memory:` URIs, and a URI query parameter
/// `mode=memory` (last `mode` wins). A substring such as `journal_mode=memory`
/// or a filesystem path that happens to contain `mode=memory` is not in-memory.
fn is_in_memory(path: &str) -> bool {
    if path == ":memory:" {
        return true;
    }
    let Some(rest) = path.strip_prefix("file:") else {
        return false;
    };
    let rest = rest.split_once('#').map(|(p, _)| p).unwrap_or(rest);
    let (filename, query) = rest.split_once('?').unwrap_or((rest, ""));
    filename == ":memory:"
        || filename.starts_with(":memory:")
        || sqlite_uri_last_mode_is_memory(query)
}

fn sqlite_uri_last_mode_is_memory(query: &str) -> bool {
    let mut last_mode = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key.eq_ignore_ascii_case("mode") {
            last_mode = Some(value);
        }
    }
    last_mode.is_some_and(|value| value.eq_ignore_ascii_case("memory"))
}

/// Filesystem path SQLite will use, with URI scheme and query string stripped.
/// Returns `None` for empty / in-memory names that have no parent directory.
fn sqlite_uri_filesystem_path(path: &str) -> Option<&str> {
    if path.is_empty() || path == ":memory:" {
        return None;
    }
    if let Some(rest) = path.strip_prefix("file:") {
        let rest = rest.split_once('?').map(|(p, _)| p).unwrap_or(rest);
        if rest.is_empty() || rest == ":memory:" || rest.starts_with(":memory:") {
            return None;
        }
        if let Some(after_authority) = rest.strip_prefix("//") {
            return after_authority
                .find('/')
                .map(|idx| &after_authority[idx..])
                .filter(|p| !p.is_empty());
        }
        return Some(rest);
    }
    Some(path)
}

#[cfg(test)]
mod sqlite_uri_filesystem_path_tests {
    use super::sqlite_uri_filesystem_path;

    #[test]
    fn strips_uri_scheme_and_query() {
        assert_eq!(sqlite_uri_filesystem_path(""), None);
        assert_eq!(sqlite_uri_filesystem_path(":memory:"), None);
        assert_eq!(sqlite_uri_filesystem_path("file::memory:"), None);
        assert_eq!(sqlite_uri_filesystem_path("file::memory:?cache=shared"), None);
        assert_eq!(sqlite_uri_filesystem_path("file:?mode=memory"), None);
        assert_eq!(sqlite_uri_filesystem_path("file:foo.db"), Some("foo.db"));
        assert_eq!(
            sqlite_uri_filesystem_path("file:nested/foo.db?mode=rwc"),
            Some("nested/foo.db")
        );
        assert_eq!(
            sqlite_uri_filesystem_path("file:/data/nested/foo.db?cache=shared"),
            Some("/data/nested/foo.db")
        );
        assert_eq!(
            sqlite_uri_filesystem_path("file:///data/nested/foo.db"),
            Some("/data/nested/foo.db")
        );
        assert_eq!(
            sqlite_uri_filesystem_path("file://localhost/data/nested/foo.db"),
            Some("/data/nested/foo.db")
        );
        assert_eq!(sqlite_uri_filesystem_path("file://memory"), None);
        assert_eq!(sqlite_uri_filesystem_path("/data/foo.db"), Some("/data/foo.db"));
    }
}

#[cfg(test)]
mod is_in_memory_tests {
    use super::is_in_memory;

    #[test]
    fn recognizes_sqlite_in_memory_names() {
        assert!(is_in_memory(":memory:"));
        assert!(is_in_memory("file::memory:"));
        assert!(is_in_memory("file::memory:?cache=shared"));
        assert!(is_in_memory("file:?mode=memory"));
        assert!(is_in_memory("file:foo.db?mode=memory"));
        assert!(is_in_memory(
            "file:actor_ns_name_abcd?mode=memory&cache=shared"
        ));
        assert!(is_in_memory("file:foo.db?cache=shared&mode=memory"));
        assert!(is_in_memory("file:foo.db?MODE=MEMORY"));
        assert!(is_in_memory("file:foo.db?mode=rwc&mode=memory"));
    }

    #[test]
    fn does_not_treat_on_disk_paths_as_memory() {
        assert!(!is_in_memory("/data/foo.db"));
        assert!(!is_in_memory("file:foo.db"));
        assert!(!is_in_memory("file:nested/foo.db?mode=rwc"));
        assert!(!is_in_memory("file:/data/app.db?journal_mode=memory"));
        assert!(!is_in_memory("/data/mode=memory.db"));
        assert!(!is_in_memory("file:mode=memory.db"));
        assert!(!is_in_memory("file:/data/app.db?mode=memory&mode=rwc"));
        assert!(!is_in_memory("/tmp/foo?mode=memory"));
        assert!(!is_in_memory(""));
    }
}

fn column_names(stmt: &rusqlite::Statement<'_>) -> Vec<String> {
    stmt.column_names().iter().map(|c| c.to_string()).collect()
}

fn bind_params(stmt: &mut rusqlite::Statement<'_>, params: &[Value]) -> Result<(), Error> {
    let expected = stmt.parameter_count();
    if expected != params.len() {
        return Err(Error::InvalidParams(format!(
            "statement expects {expected} parameter(s) but {} were supplied",
            params.len()
        )));
    }
    for (i, value) in params.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, to_sql_value(value))
            .map_err(|e| Error::InvalidParams(format!("parameter {}: {e}", i + 1)))?;
    }
    Ok(())
}

fn to_sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Integer(i) => SqlValue::Integer(*i),
        Value::Real(f) => SqlValue::Real(*f),
        Value::Text(s) => SqlValue::Text(s.clone()),
        Value::Blob(b) => SqlValue::Blob(b.clone()),
    }
}

fn from_value_ref(column: &str, value: ValueRef<'_>) -> Result<Value, Error> {
    Ok(match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Integer(i),
        ValueRef::Real(f) => Value::Real(f),
        ValueRef::Text(t) => Value::Text(
            std::str::from_utf8(t)
                .map_err(|e| {
                    Error::ValueConversionFailed(format!("column {column}: invalid UTF-8 text: {e}"))
                })?
                .to_owned(),
        ),
        ValueRef::Blob(b) => Value::Blob(b.to_vec()),
    })
}

fn read_row(row: &rusqlite::Row<'_>, columns: &[String]) -> Result<Row, Error> {
    let mut out = Vec::with_capacity(columns.len());
    for (i, name) in columns.iter().enumerate() {
        let value_ref = row.get_ref(i).map_err(map_exec_error)?;
        out.push((name.clone(), from_value_ref(name, value_ref)?));
    }
    Ok(out)
}

/// Savepoint names are interpolated into SQL, so restrict them to a plain
/// identifier and quote them.
fn savepoint_identifier(name: &str) -> Result<String, Error> {
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .map(|c| c.is_ascii_alphabetic() || c == '_')
        .unwrap_or(false);
    let valid_rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid_start || !valid_rest || name.len() > 128 {
        return Err(Error::InvalidParams(format!(
            "invalid savepoint name {name:?}: use [A-Za-z_][A-Za-z0-9_]*"
        )));
    }
    Ok(format!("\"{name}\""))
}

/// Errors from `sqlite3_prepare`: the SQL itself is the problem.
fn map_prepare_error(err: rusqlite::Error) -> Error {
    match err {
        rusqlite::Error::MultipleStatement => Error::InvalidSql(
            "run/query/first accept exactly one statement; use exec for batches".into(),
        ),
        // `bundled` enables `modern_sqlite`, so prepare failures arrive with
        // the offending token offset (sqlite3_error_offset).
        rusqlite::Error::SqlInputError { msg, offset, .. } => {
            Error::InvalidSql(format!("{msg} (at byte offset {offset})"))
        }
        rusqlite::Error::SqliteFailure(ffi_err, message) => {
            if is_busy(&ffi_err) {
                return Error::Busy;
            }
            Error::InvalidSql(message.unwrap_or_else(|| ffi_err.to_string()))
        }
        other => Error::Other(other.to_string()),
    }
}

/// Errors from stepping / binding / committing an already-prepared statement.
fn map_exec_error(err: rusqlite::Error) -> Error {
    match err {
        rusqlite::Error::SqliteFailure(ffi_err, message) => {
            if is_busy(&ffi_err) {
                return Error::Busy;
            }
            Error::ExecutionFailed(SqliteError {
                code: ffi_err.extended_code & 0xff,
                extended_code: ffi_err.extended_code,
                message: message.unwrap_or_else(|| ffi_err.to_string()),
            })
        }
        rusqlite::Error::InvalidParameterCount(given, expected) => Error::InvalidParams(format!(
            "statement expects {expected} parameter(s) but {given} were supplied"
        )),
        rusqlite::Error::InvalidParameterName(name) => {
            Error::InvalidParams(format!("unknown parameter {name}"))
        }
        rusqlite::Error::ToSqlConversionFailure(e) => {
            Error::InvalidParams(format!("could not bind parameter: {e}"))
        }
        rusqlite::Error::FromSqlConversionFailure(idx, _, e) => {
            Error::ValueConversionFailed(format!("column {idx}: {e}"))
        }
        rusqlite::Error::MultipleStatement => Error::InvalidSql(
            "run/query/first accept exactly one statement; use exec for batches".into(),
        ),
        // `exec` batches are prepared statement-by-statement, so a syntax
        // error can surface here as well.
        rusqlite::Error::SqlInputError { msg, offset, .. } => {
            Error::InvalidSql(format!("{msg} (at byte offset {offset})"))
        }
        other => Error::Other(other.to_string()),
    }
}

fn is_busy(err: &rusqlite::ffi::Error) -> bool {
    matches!(err.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
}
