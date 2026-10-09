//! Real-engine conformance and restart test. Run via scripts/smoke.sh.

wit_bindgen::generate!({
    path: "../../wit",
    world: "imports",
});

use di_framework::pglite::database::{open, server_version, Connection};
use di_framework::pglite::types::{Error, OpenOptions, Value};

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
    &row.iter()
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

    // --- storage validation and exclusive engine ownership ---
    let mode = std::env::var("PGLITE_SMOKE_MODE").unwrap_or_else(|_| "write".into());
    if mode == "no-mount" {
        assert!(matches!(open("", None), Err(Error::OpenFailed(_))));
        println!("no mount ok");
        return;
    }
    assert!(matches!(
        open("relative/path", None),
        Err(Error::OpenFailed(_))
    ));
    assert!(matches!(
        open("/data/../escape", None),
        Err(Error::OpenFailed(_))
    ));
    assert!(matches!(
        open(
            "/data/pglite",
            Some(&OpenOptions {
                database: None,
                statement_timeout_ms: Some(1)
            })
        ),
        Err(Error::OpenFailed(_))
    ));
    let db: Connection = open("/data/pglite", None).expect("open");
    assert!(matches!(
        open("/data/pglite", None),
        Err(Error::OpenFailed(_))
    ));

    if mode == "read" {
        let row = db
            .first("SELECT payload FROM tasks WHERE id = 1", &[])
            .expect("restart query")
            .expect("persisted row");
        assert_eq!(text(col(&row, "payload")), "Hi");
        assert!(db
            .first("SELECT id FROM tasks WHERE payload = 'uncommitted'", &[])
            .unwrap()
            .is_none());
        db.close().expect("close read");
        println!("restart ok");
        return;
    }
    if mode == "abrupt" {
        db.begin().unwrap();
        db.run(
            "INSERT INTO tasks(payload) VALUES ($1)",
            &[Value::Text("uncommitted".into())],
        )
        .unwrap();
        // End the runtime with an open transaction and without dropping/closing.
        std::mem::forget(db);
        println!("abrupt ok");
        std::process::exit(0);
    }
    for setting in ["fsync", "synchronous_commit", "full_page_writes"] {
        let row = db
            .first(&format!("SHOW {setting}"), &[])
            .expect("durability setting")
            .unwrap();
        assert_eq!(text(&row[0].1), "on", "{setting}");
    }
    for reset in [false, true] {
        if reset {
            db.exec("RESET ALL").unwrap();
        }
        let schema = db
            .first("SELECT current_schema()::text AS schema", &[])
            .unwrap()
            .unwrap();
        assert_eq!(text(col(&schema, "schema")), "public");
    }
    // --- DDL via exec (multi-statement, results discarded) ---
    db.exec("DROP TABLE IF EXISTS tasks; CREATE TABLE tasks (id serial primary key, payload text)")
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
    assert!(matches!(
        db.commit(),
        Err(Error::InvalidTransactionState(_))
    ));

    // --- transactions + savepoints ---
    db.begin().expect("begin");
    assert!(db.in_transaction());
    assert!(matches!(db.begin(), Err(Error::InvalidTransactionState(_))));
    db.savepoint("sp1").expect("savepoint");
    db.rollback_to_savepoint("sp1")
        .expect("rollback-to-savepoint");
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

    // Native Postgres values, a substantial in-memory reply, and recoverable errors.
    let row = db.first("SELECT $1::bigint AS i, $2::float8 AS f, $3::boolean AS b, $4::bytea AS bytes, $5::text AS n",
        &[Value::Integer(i64::MIN + 1), Value::Real(1.25), Value::Boolean(true), Value::Blob(vec![0, 255, 42]), Value::Null]).unwrap().unwrap();
    assert_eq!(int(col(&row, "i")), i64::MIN + 1);
    assert!(matches!(col(&row, "f"), Value::Real(v) if *v == 1.25));
    assert!(matches!(col(&row, "b"), Value::Boolean(true)));
    assert!(matches!(col(&row, "bytes"), Value::Blob(v) if v == &[0, 255, 42]));
    assert!(matches!(col(&row, "n"), Value::Null));
    let row = db
        .first("SELECT repeat('x', 3000000) AS v", &[])
        .unwrap()
        .unwrap();
    assert_eq!(text(col(&row, "v")).len(), 3000000);
    assert!(
        matches!(db.run("INSERT INTO tasks(id) VALUES (1)", &[]), Err(Error::ExecutionFailed(e)) if e.code == "23505")
    );
    assert!(
        matches!(db.query("SELECT 1 / 0", &[]), Err(Error::ExecutionFailed(e)) if e.code == "22012")
    );
    assert!(matches!(
        db.exec("SELEC nonsense"),
        Err(Error::InvalidSql(_))
    ));
    assert!(matches!(
        db.query("SELECT $1::bigint", &[]),
        Err(Error::InvalidParams(_))
    ));
    assert!(db.first("SELECT 42::bigint AS n", &[]).unwrap().is_some());

    // Full PostgreSQL unwinding also applies inside procedural exception blocks.
    db.exec("DO $$ BEGIN PERFORM 1 / 0; EXCEPTION WHEN division_by_zero THEN NULL; END $$")
        .unwrap();
    assert!(
        matches!(db.query("SELECT repeat('x', 70000000)", &[]), Err(Error::ExecutionFailed(e)) if e.code == "54000")
    );
    assert!(db.first("SELECT 42::bigint", &[]).unwrap().is_some());

    // ReadyForQuery drives transaction state even when BEGIN is issued via exec.
    db.exec("BEGIN").unwrap();
    assert!(db.in_transaction());
    assert!(matches!(
        db.query("SELECT 1 / 0", &[]),
        Err(Error::ExecutionFailed(_))
    ));
    assert!(db.in_transaction());
    db.rollback().unwrap();
    assert!(!db.in_transaction());

    // Closing and dropping must roll back and allow a fresh resource to reuse PGDATA.
    db.exec("SET application_name = 'smoke-session'").unwrap();
    db.begin().unwrap();
    db.run("INSERT INTO tasks(payload) VALUES ('uncommitted')", &[])
        .unwrap();
    // --- close poisons the handle ---
    db.close().expect("close");
    assert!(matches!(db.exec("SELECT 1"), Err(Error::Closed)));

    assert!(matches!(
        open("/data/other", None),
        Err(Error::OpenFailed(_))
    ));
    let reopened = open("", None).expect("reopen same database");
    assert!(!reopened.in_transaction());
    let setting = reopened
        .first("SHOW application_name", &[])
        .unwrap()
        .unwrap();
    assert_eq!(text(&setting[0].1), "");
    assert!(reopened
        .first("SELECT id FROM tasks WHERE payload = 'uncommitted'", &[])
        .unwrap()
        .is_none());
    reopened.begin().unwrap();
    reopened
        .exec("INSERT INTO tasks(payload) VALUES ('uncommitted')")
        .unwrap();
    drop(reopened);
    let reopened = open("", None).expect("reopen after drop");
    assert!(reopened
        .first("SELECT id FROM tasks WHERE payload = 'uncommitted'", &[])
        .unwrap()
        .is_none());
    reopened.close().unwrap();
    println!("smoke ok");
}
