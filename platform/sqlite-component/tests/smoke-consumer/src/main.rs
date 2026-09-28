//! Smoke-test consumer for the di-framework:sqlite provider.
//!
//! Exercises open / exec / run / query / first / begin / commit / rollback /
//! savepoints / error mapping against a database file inside a preopened
//! directory, then re-opens the file to prove the data was persisted through
//! the WASI filesystem with a rollback journal.
//!
//! Usage (after `wac plug`): `wasmtime run --dir <host-dir>::/data composed.wasm`

wit_bindgen::generate!({
    path: "../../wit",
    world: "imports",
});

use di_framework::sqlite::database::{open, sqlite_version, Connection};
use di_framework::sqlite::types::{Error, OpenOptions, TransactionBehavior, Value};

const DB_PATH: &str = "/data/smoke.sqlite";

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
    &row.iter().find(|(c, _)| c == name).unwrap_or_else(|| panic!("no column {name}")).1
}

fn main() {
    println!("sqlite {}", sqlite_version());

    let _ = std::fs::remove_file(DB_PATH);
    let _ = std::fs::remove_file(format!("{DB_PATH}-journal"));

    // --- open with defaults: DELETE journal, synchronous=FULL --------------------
    let db: Connection = open(DB_PATH, None).expect("open");
    let journal = db.first("PRAGMA journal_mode", &[]).unwrap().unwrap();
    assert_eq!(text(&journal[0].1), "delete", "journal_mode must be delete");
    let sync = db.first("PRAGMA synchronous", &[]).unwrap().unwrap();
    assert_eq!(int(&sync[0].1), 2, "synchronous must be FULL (2)");
    let fk = db.first("PRAGMA foreign_keys", &[]).unwrap().unwrap();
    assert_eq!(int(&fk[0].1), 1);
    // WAL must be impossible (compiled out): asking for it must leave us on delete.
    db.exec("PRAGMA journal_mode = WAL").unwrap();
    let journal = db.first("PRAGMA journal_mode", &[]).unwrap().unwrap();
    assert_eq!(text(&journal[0].1), "delete", "WAL must be compiled out");

    // --- DDL via exec (multi-statement) ----------------------------------------
    db.exec(
        "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL, n REAL);
         CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0);",
    )
    .expect("create tables");

    // --- run / changes / last-insert-rowid -----------------------------------------
    let changes = db
        .run(
            "INSERT INTO kv (k, v, n) VALUES (?1, ?2, ?3)",
            &[
                Value::Text("a".into()),
                Value::Blob(vec![1, 2, 3]),
                Value::Real(1.5),
            ],
        )
        .expect("insert");
    assert_eq!(changes, 1);
    let changes = db
        .run(
            "INSERT INTO jobs (payload) VALUES (?1)",
            &[Value::Text("{\"hello\":\"world\"}".into())],
        )
        .unwrap();
    assert_eq!(changes, 1);
    assert_eq!(db.last_insert_rowid(), 1);
    assert_eq!(db.changes(), 1);

    // --- query / first with all value kinds ---------------------------------------
    let rows = db
        .query("SELECT k, v, n, NULL AS z FROM kv ORDER BY k", &[])
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(text(col(&rows[0], "k")), "a");
    assert!(matches!(col(&rows[0], "v"), Value::Blob(b) if b == &[1, 2, 3]));
    assert!(matches!(col(&rows[0], "n"), Value::Real(f) if (*f - 1.5).abs() < f64::EPSILON));
    assert!(matches!(col(&rows[0], "z"), Value::Null));
    assert!(db
        .first("SELECT * FROM kv WHERE k = ?1", &[Value::Text("missing".into())])
        .unwrap()
        .is_none());

    // --- error mapping ---------------------------------------------------------
    match db.run("INSERT INTO kv (k, v) VALUES (?1, ?2)", &[Value::Text("a".into()), Value::Blob(vec![])]) {
        Err(Error::ExecutionFailed(e)) => {
            assert_eq!(e.code, 19, "SQLITE_CONSTRAINT");
            assert_eq!(e.extended_code, 1555, "SQLITE_CONSTRAINT_PRIMARYKEY");
        }
        other => panic!("expected constraint violation, got {other:?}"),
    }
    assert!(matches!(db.query("SELEC nonsense", &[]), Err(Error::InvalidSql(_))));
    assert!(matches!(
        db.query("SELECT ?1, ?2", &[Value::Null]),
        Err(Error::InvalidParams(_))
    ));
    assert!(matches!(
        db.query("SELECT 1; SELECT 2", &[]),
        Err(Error::InvalidSql(_))
    ));
    assert!(matches!(db.commit(), Err(Error::InvalidTransactionState(_))));

    // --- transactions ----------------------------------------------------------
    db.begin(Some(TransactionBehavior::Immediate)).unwrap();
    assert!(db.in_transaction());
    assert!(matches!(db.begin(None), Err(Error::InvalidTransactionState(_))));
    db.run("UPDATE jobs SET attempt = attempt + 1 WHERE id = ?1", &[Value::Integer(1)]).unwrap();
    db.savepoint("sp1").unwrap();
    db.run("DELETE FROM jobs WHERE id = ?1", &[Value::Integer(1)]).unwrap();
    db.rollback_to_savepoint("sp1").unwrap();
    assert!(db.in_transaction());
    db.commit().unwrap();
    assert!(!db.in_transaction());
    let job = db.first("SELECT attempt FROM jobs WHERE id = 1", &[]).unwrap().unwrap();
    assert_eq!(int(&job[0].1), 1, "savepoint rollback kept the row, outer commit kept the update");

    db.begin(None).unwrap();
    db.run("DELETE FROM jobs", &[]).unwrap();
    db.rollback().unwrap();
    let n = db.first("SELECT COUNT(*) AS n FROM jobs", &[]).unwrap().unwrap();
    assert_eq!(int(&n[0].1), 1, "rollback restored the row");

    assert!(matches!(db.savepoint("bad name;"), Err(Error::InvalidParams(_))));

    // --- close + reopen: persistence through the WASI preopen -------------------
    db.close().unwrap();
    assert!(matches!(db.exec("SELECT 1"), Err(Error::Closed)));
    drop(db);

    assert!(
        !std::path::Path::new(&format!("{DB_PATH}-journal")).exists(),
        "journal must be deleted after commit (journal_mode=delete)"
    );

    let ro = open(
        DB_PATH,
        Some(OpenOptions {
            create: Some(false),
            read_only: Some(true),
            synchronous: None,
            journal_mode: None,
            busy_timeout_ms: None,
            foreign_keys: None,
        }),
    )
    .expect("reopen read-only");
    let rows = ro.query("SELECT k FROM kv", &[]).unwrap();
    assert_eq!(rows.len(), 1);
    match ro.run("INSERT INTO kv (k, v) VALUES ('x', x'00')", &[]) {
        Err(Error::ExecutionFailed(e)) => assert_eq!(e.code, 8, "SQLITE_READONLY"),
        other => panic!("expected readonly error, got {other:?}"),
    }
    drop(ro);

    match open("/data/does-not-exist/x.sqlite", None) {
        // Parent directories under a preopen are created by the provider.
        Ok(_) => {}
        Err(Error::OpenFailed(_)) => {}
        other => panic!("unexpected open result for nested path, got {other:?}"),
    }
    match open("file:/data/uri-nested/x.sqlite?mode=rwc", None) {
        Ok(_) => {}
        Err(Error::OpenFailed(_)) => {}
        other => panic!("unexpected open result for SQLite URI nested path, got {other:?}"),
    }
    let bogus_query_dir = std::path::Path::new("/data/uri-nested/x.sqlite?mode=rwc");
    assert!(
        !bogus_query_dir.exists(),
        "create_dir_all must use the URI filesystem path, not the raw string including ?query"
    );
    match open("/not-preopened/x.sqlite", None) {
        Err(Error::OpenFailed(_)) => {}
        other => panic!("expected open-failed outside preopen, got {other:?}"),
    }

    let mem = open(":memory:", None).unwrap();
    mem.exec("CREATE TABLE t (x); INSERT INTO t VALUES (42)").unwrap();
    let row = mem.first("SELECT x FROM t", &[]).unwrap().unwrap();
    assert_eq!(int(&row[0].1), 42);

    println!("smoke ok");
}
