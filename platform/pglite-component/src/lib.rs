//! `di-framework:pglite/database` provider component.
//!
//! Bundles the PostgreSQL engine behind WIT, communicating through memory.
//! Persistence uses the host's writable WASI filesystem preopen.

wit_bindgen::generate!({
    world: "pglite-provider",
    path: "wit",
    generate_all,
});

mod engine;
mod pgwire;

use std::cell::{RefCell, RefMut};

use engine::POSTGRES_VERSION;
use exports::di_framework::pglite::database::{Connection, Guest, GuestConnection};
use exports::di_framework::pglite::types::{Error, OpenOptions, Row, Value};
use pgwire::{affected_from_tag, to_rows, Session};

struct Provider;

struct LiveConn {
    sess: Option<Session>,
    last_affected: u64,
}

struct DbConn(RefCell<LiveConn>);

fn locked(conn: &DbConn) -> Result<RefMut<'_, LiveConn>, Error> {
    conn.0
        .try_borrow_mut()
        .map_err(|_| Error::Other("connection is busy".to_string()))
}

fn live<'a>(guard: &'a mut RefMut<'_, LiveConn>) -> Result<&'a mut Session, Error> {
    guard.sess.as_mut().ok_or(Error::Closed)
}

fn is_savepoint_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    match bytes.next() {
        Some(b) if b.is_ascii_alphabetic() || b == b'_' => {}
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Redacted one-line summary for `stderr`: variant + SQLSTATE only, never the
/// server message, SQL text, or parameter values (they may carry PII).
/// Full details still reach the caller via the returned `Error`.
fn describe_redacted(error: &Error) -> String {
    match error {
        Error::OpenFailed(_) => "open failed".to_string(),
        Error::Closed => "connection is closed".to_string(),
        Error::InvalidSql(_) => "invalid sql".to_string(),
        Error::InvalidParams(_) => "invalid params".to_string(),
        Error::ExecutionFailed(pg) => format!("postgres {}", pg.code),
        Error::ValueConversionFailed(_) => "value conversion failed".to_string(),
        Error::ConnectionLost(_) => "connection lost".to_string(),
        Error::InvalidTransactionState(_) => "invalid transaction state".to_string(),
        Error::Other(_) => "other".to_string(),
    }
}

impl Guest for Provider {
    type Connection = DbConn;

    fn open(path: String, options: Option<OpenOptions>) -> Result<Connection, Error> {
        if options
            .as_ref()
            .and_then(|o| o.statement_timeout_ms)
            .is_some_and(|ms| ms != 0)
        {
            return Err(Error::OpenFailed(
                "statement timeouts are unsupported by this WASI engine; use host execution limits"
                    .into(),
            ));
        }
        let database = options
            .as_ref()
            .and_then(|o| o.database.as_deref())
            .unwrap_or("template1");
        let sess = Session::connect(&path, database)?;

        Ok(Connection::new(DbConn(RefCell::new(LiveConn {
            sess: Some(sess),
            last_affected: 0,
        }))))
    }

    fn server_version() -> Result<String, Error> {
        // Single source of truth with the engine recipe: `engine::POSTGRES_VERSION`
        // tracks `PG_VERSION=17.5` in `scripts/build-engine.sh`. The smoke
        // consumer asserts `version.contains("17.5")`.
        Ok(POSTGRES_VERSION.into())
    }
}

impl GuestConnection for DbConn {
    fn exec(&self, sql: String) -> Result<(), Error> {
        let mut guard = locked(self)?;

        let sess = live(&mut guard)?;
        let out = sess.simple(&sql).map_err(|e| {
            // Redacted: server messages/SQL may hold PII; stderr gets only
            // the variant + SQLSTATE.
            eprintln!("pglite exec failed: {}", describe_redacted(&e));
            e
        })?;
        guard.last_affected = out
            .tags
            .last()
            .map(|tag| affected_from_tag(tag))
            .unwrap_or(0);
        Ok(())
    }

    fn run(&self, sql: String, params: Vec<Value>) -> Result<u64, Error> {
        let mut guard = locked(self)?;
        let sess = live(&mut guard)?;
        let out = sess.extended(&sql, &params).map_err(|e| {
            eprintln!("pglite run failed: {}", describe_redacted(&e));
            e
        })?;
        let affected = out
            .tags
            .last()
            .map(|tag| affected_from_tag(tag))
            .unwrap_or(0);
        guard.last_affected = affected;
        Ok(affected)
    }

    fn query(&self, sql: String, params: Vec<Value>) -> Result<Vec<Row>, Error> {
        let mut guard = locked(self)?;
        let sess = live(&mut guard)?;
        let out = sess.extended(&sql, &params).map_err(|e| {
            eprintln!("pglite query failed: {}", describe_redacted(&e));
            e
        })?;
        to_rows(out)
    }

    fn first(&self, sql: String, params: Vec<Value>) -> Result<Option<Row>, Error> {
        Ok(Self::query(self, sql, params)?.into_iter().next())
    }

    fn begin(&self) -> Result<(), Error> {
        let mut guard = locked(self)?;
        if live(&mut guard)?.in_transaction() {
            return Err(Error::InvalidTransactionState(
                "transaction already open; nest with savepoint".to_string(),
            ));
        }
        let sess = live(&mut guard)?;
        sess.simple("BEGIN")?;
        Ok(())
    }

    fn commit(&self) -> Result<(), Error> {
        let mut guard = locked(self)?;
        if !live(&mut guard)?.in_transaction() {
            return Err(Error::InvalidTransactionState(
                "no transaction to commit".to_string(),
            ));
        }
        let sess = live(&mut guard)?;
        sess.simple("COMMIT")?;
        Ok(())
    }

    fn rollback(&self) -> Result<(), Error> {
        let mut guard = locked(self)?;
        if !live(&mut guard)?.in_transaction() {
            return Err(Error::InvalidTransactionState(
                "no transaction to roll back".to_string(),
            ));
        }
        let sess = live(&mut guard)?;
        sess.simple("ROLLBACK")?;
        Ok(())
    }

    fn savepoint(&self, name: String) -> Result<(), Error> {
        if !is_savepoint_name(&name) {
            return Err(Error::InvalidSql(format!("bad savepoint name {name:?}")));
        }
        let mut guard = locked(self)?;
        let sess = live(&mut guard)?;
        sess.simple(&format!("SAVEPOINT \"{name}\""))?;
        Ok(())
    }

    fn release_savepoint(&self, name: String) -> Result<(), Error> {
        if !is_savepoint_name(&name) {
            return Err(Error::InvalidSql(format!("bad savepoint name {name:?}")));
        }
        let mut guard = locked(self)?;
        if !live(&mut guard)?.in_transaction() {
            return Err(Error::InvalidTransactionState(
                "no savepoint to release".to_string(),
            ));
        }
        let sess = live(&mut guard)?;
        sess.simple(&format!("RELEASE SAVEPOINT \"{name}\""))?;
        Ok(())
    }

    fn rollback_to_savepoint(&self, name: String) -> Result<(), Error> {
        if !is_savepoint_name(&name) {
            return Err(Error::InvalidSql(format!("bad savepoint name {name:?}")));
        }
        let mut guard = locked(self)?;
        if !live(&mut guard)?.in_transaction() {
            return Err(Error::InvalidTransactionState(
                "no savepoint to roll back to".to_string(),
            ));
        }
        let sess = live(&mut guard)?;
        sess.simple(&format!("ROLLBACK TO SAVEPOINT \"{name}\""))?;
        sess.simple(&format!("RELEASE SAVEPOINT \"{name}\""))?;
        Ok(())
    }

    fn in_transaction(&self) -> bool {
        // WIT returns `bool`, so a busy borrow cannot surface as an error
        // without breaking the `di-framework:pglite@0.1.0` API. Borrows are
        // method-local and WASM is single-threaded, so contention is
        // unreachable in practice (it would require re-entrant WIT calls).
        // Fail closed: report `true` when busy to block a nested `begin`.
        self.0
            .try_borrow()
            .map(|guard| guard.sess.as_ref().is_some_and(Session::in_transaction))
            .unwrap_or(true)
    }

    fn rows_affected(&self) -> u64 {
        // Same WIT constraint as `in_transaction`: contention is unreachable
        // (see above). Returning `0` when busy preserves the prior contract;
        // tracking last-known outside the `RefCell` would require a WIT-visible
        // state change, noted for a future API revision.
        self.0
            .try_borrow()
            .map(|guard| guard.last_affected)
            .unwrap_or(0)
    }

    fn close(&self) -> Result<(), Error> {
        let mut guard = locked(self)?;
        if guard.sess.is_none() {
            return Err(Error::Closed);
        }
        let sess = guard.sess.as_mut().ok_or(Error::Closed)?;
        let result = sess.close();
        guard.sess = None;
        result
    }
}

export!(Provider);
