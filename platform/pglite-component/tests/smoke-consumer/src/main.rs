//! Smoke-test consumer for the di-framework:pglite provider.
//!
//! Exercises server-version / open / exec / run / query / first / begin /
//! commit / rollback / savepoints / error mapping through the provider, then
//! closes and proves the handle is dead. Run composed with the provider
//! (`wac plug`) under wasmtime with `PGHOST`/`PGPORT`/… pointing at the
//! scripted server from `scripts/fake-pgwire.py`:
//!
//! `wasmtime run --env PGHOST=127.0.0.1 --env PGPORT=<port> … composed.wasm`

wit_bindgen::generate!({
    path: "../../wit",
    world: "imports",
});

use di_framework::pglite::database::{open, server_version, Connection};
use di_framework::pglite::types::{Error, Value};

fn text(v: &Value) -> String {
    match v {
        Value::Text(s) => s.clone(),
        other => panic!("expected text, got {other:?}"),
    }
}

fn int(v: &Value) -> i64 {
    match v {
        Value::Integer(i) => *i,
        other => panic!("expected integer, got {other:?}"),
    }
}

fn col<'a>(row: &'a [(String, Value)], name: &str) -> &'a Value {
    &row
        .iter()
        .find(|(c, _)| c == name)
        .unwrap_or_else(|| panic!("no column {name}"))
        .1
}

fn main() {
    // --- server version: proves the handshake (startup + auth + ReadyForQuery) ---
    let version = server_version().expect("server-version");
    assert!(
        version.contains("17.5"),
        "unexpected server version {version:?}"
    );
    println!("server {version}");

    // --- open with an empty path: provider defaults from PGHOST/PGPORT/… ---
    let db: Connection = open("", None).expect("open");

    // --- DDL via exec (multi-statement, results discarded) ---
    db.exec(
        "CREATE TABLE IF NOT EXISTS tasks (id serial primary key, payload text)",
    )
    .expect("create table");

    // --- parameterized INSERT … RETURNING via query ---
    let rows = db
        .query(
            "INSERT INTO tasks (payload) VALUES ($1) RETURNING id",
            &[Value::Text("Hello World".into())],
        )
        .expect("insert");
    assert_eq!(rows.len(), 1);
    let id = int(&rows[0][0].1);
    assert_eq!(id, 1);

    // --- first() with a hit and a miss ---
    let row = db
        .first(
            "SELECT payload FROM tasks WHERE id = $1",
            &[Value::Integer(id)],
        )
        .expect("select")
        .expect("row");
    assert_eq!(text(col(&row, "payload")), "Hello World");
    assert!(db
        .first("SELECT payload FROM tasks WHERE payload = 'missing'", &[])
        .expect("first none")
        .is_none());

    // --- run() returns rows affected; rows-affected tracks the last write ---
    let affected = db
        .run(
            "UPDATE tasks SET payload = $1 WHERE id = $2",
            &[Value::Text("Hi".into()), Value::Integer(id)],
        )
        .expect("update");
    assert_eq!(affected, 1);
    assert_eq!(db.rows_affected(), 1);

    // --- error mapping: syntax problems are a client bug ---
    assert!(matches!(
        db.query("SELEC nonsense", &[]),
        Err(Error::InvalidSql(_))
    ));
    assert!(matches!(db.commit(), Err(Error::InvalidTransactionState(_))));

    // --- transactions + savepoints ---
    db.begin().expect("begin");
    assert!(db.in_transaction());
    assert!(matches!(db.begin(), Err(Error::InvalidTransactionState(_))));
    db.savepoint("sp1").expect("savepoint");
    db.rollback_to_savepoint("sp1").expect("rollback-to-savepoint");
    assert!(db.in_transaction());
    db.commit().expect("commit");
    assert!(!db.in_transaction());

    db.begin().expect("begin2");
    db.rollback().expect("rollback");
    assert!(!db.in_transaction());

    // --- client-side savepoint name validation (no server round trip) ---
    assert!(matches!(
        db.savepoint("bad name;"),
        Err(Error::InvalidSql(_))
    ));

    // --- close poisons the handle ---
    db.close().expect("close");
    assert!(matches!(db.exec("SELECT 1"), Err(Error::Closed)));

    println!("smoke ok");
}
