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

fn describe(error: &Error) -> String {
    match error {
        Error::OpenFailed(text) => format!("open failed: {text}"),
        Error::Closed => "connection is closed".to_string(),
        Error::InvalidSql(text) => format!("invalid sql: {text}"),
        Error::InvalidParams(text) => format!("invalid params: {text}"),
        Error::ExecutionFailed(pg) => format!("postgres {}: {}", pg.code, pg.message),
        Error::ValueConversionFailed(text) => format!("value conversion failed: {text}"),
        Error::ConnectionLost(text) => format!("connection lost: {text}"),
        Error::InvalidTransactionState(text) => format!("invalid transaction state: {text}"),
        Error::Other(text) => text.clone(),
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
        Ok("17.5".into())
    }
}

impl GuestConnection for DbConn {
    fn exec(&self, sql: String) -> Result<(), Error> {
        let mut guard = locked(self)?;

        let sess = live(&mut guard)?;
        let out = sess.simple(&sql).map_err(|e| {
            eprintln!("pglite exec failed: {}", describe(&e));
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
            eprintln!("pglite run failed: {}", describe(&e));
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
            eprintln!("pglite query failed: {}", describe(&e));
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
        self.0
            .try_borrow()
            .is_ok_and(|guard| guard.sess.as_ref().is_some_and(Session::in_transaction))
    }

    fn rows_affected(&self) -> u64 {
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
        let result = guard.sess.as_mut().unwrap().close();
        guard.sess = None;
        result
    }
}

export!(Provider);
