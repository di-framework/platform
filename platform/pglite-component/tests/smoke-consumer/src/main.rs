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
    if mode == "refused" {
        // A storage layer below the engine (pglite-encfs with a wrong or
        // missing key) must make open fail cleanly, not trap.
        assert!(matches!(
            open("/data/pglite", None),
            Err(Error::OpenFailed(_))
        ));
        println!("refused ok");
        return;
    }
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
    if durability_mode(&db, &mode) {
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
    // Class-42 errors other than syntax and indeterminate type should produce execution-failed
    assert!(
        matches!(db.query("SELECT * FROM missing_table", &[]), Err(Error::ExecutionFailed(e)) if e.code == "42P01")
    );
    assert!(
        matches!(db.query("SELECT nonexistent_column FROM tasks", &[]), Err(Error::ExecutionFailed(e)) if e.code == "42703")
    );
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

    // --- WIT 0.2.0: typed results and OID 0 parameters (uncast, real engine) ---
    // `db` was closed above; every block below runs on a fresh connection.
    let db: Connection = open("", None).expect("open for typed block");

    // Session formats are pinned at open so timestamp output is unambiguous.
    let fmt = db.first("SHOW DateStyle", &[]).unwrap().unwrap();
    assert!(text(&fmt[0].1).starts_with("ISO"), "DateStyle must be ISO");
    let tz = db.first("SHOW TimeZone", &[]).unwrap().unwrap();
    assert_eq!(text(&tz[0].1), "UTC");

    db.exec(
        "CREATE TABLE typed_data (id serial primary key, data jsonb, plain json, \
         ts timestamptz, plain_ts timestamp, d date, u uuid, n numeric, tags text[], big int8)",
    )
    .expect("create typed table");

    // Uncast inserts: uuid, jsonb, json, timestamptz and timestamp columns.
    let doc = r#"{"name": "test", "value": 42}"#;
    let uid = "550e8400-e29b-41d4-a716-446655440000";
    db.run(
        "INSERT INTO typed_data (data, plain, ts, plain_ts, d, u, n, tags, big) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            Value::Json(doc.to_string()),
            Value::Json(r#"{"x": 1}"#.to_string()),
            Value::Timestamp("2024-01-15T10:30:00.123Z".to_string()),
            Value::Timestamp("2024-01-15T10:30:00".to_string()),
            Value::Text("2024-01-15".to_string()),
            Value::Text(uid.to_string()),
            Value::Text("12.50".to_string()),
            Value::Text("{a,b}".to_string()),
            Value::Integer(9_007_199_254_740_993),
        ],
    )
    .expect("uncast insert into jsonb/json/timestamptz/timestamp/date/uuid/numeric/array/int8");

    let row = db
        .first("SELECT * FROM typed_data WHERE id = 1", &[])
        .expect("select typed row")
        .expect("row found");
    // jsonb (3802) and json (114) both decode as Value::Json.
    assert!(matches!(col(&row, "data"), Value::Json(j) if j.contains("test") && j.contains("42")));
    assert!(matches!(col(&row, "plain"), Value::Json(j) if j == r#"{"x": 1}"#));
    // timestamptz is RFC 3339 in UTC, fractional seconds kept.
    assert!(matches!(col(&row, "ts"), Value::Timestamp(t) if t == "2024-01-15T10:30:00.123Z"));
    // timestamp (no zone), date, uuid, numeric and arrays are Text; int8 is Integer.
    assert_eq!(text(col(&row, "plain_ts")), "2024-01-15 10:30:00");
    assert_eq!(text(col(&row, "d")), "2024-01-15");
    assert_eq!(text(col(&row, "u")), uid);
    assert_eq!(text(col(&row, "n")), "12.50");
    assert_eq!(text(col(&row, "tags")), "{a,b}");
    assert_eq!(int(col(&row, "big")), 9_007_199_254_740_993);
    let bare = db
        .first("SELECT '{\"k\":1}'::jsonb AS j", &[])
        .unwrap()
        .unwrap();
    assert!(matches!(col(&bare, "j"), Value::Json(_)));

    // A non-UTC offset on input is normalized to Z on output.
    db.run(
        "INSERT INTO typed_data (ts) VALUES ($1)",
        &[Value::Text("2024-01-15T12:30:00+02:00".to_string())],
    )
    .unwrap();
    let offset = db
        .first("SELECT ts FROM typed_data WHERE id = 2", &[])
        .unwrap()
        .unwrap();
    assert!(matches!(col(&offset, "ts"), Value::Timestamp(t) if t == "2024-01-15T10:30:00Z"));

    // infinity and -infinity are passed through as documented literals.
    let inf = db
        .first(
            "SELECT 'infinity'::timestamptz AS a, '-infinity'::timestamptz AS b",
            &[],
        )
        .unwrap()
        .unwrap();
    assert!(matches!(col(&inf, "a"), Value::Timestamp(t) if t == "infinity"));
    assert!(matches!(col(&inf, "b"), Value::Timestamp(t) if t == "-infinity"));

    // jsonb operators with a Json parameter: sent as OID 0, so Postgres infers jsonb.
    let contained = db
        .first(
            "SELECT id FROM typed_data WHERE data @> $1",
            &[Value::Json(r#"{"name": "test"}"#.to_string())],
        )
        .expect("jsonb @> $1")
        .expect("contained row");
    assert_eq!(int(&contained[0].1), 1);
    let equal = db
        .first(
            "SELECT id FROM typed_data WHERE data = $1",
            &[Value::Json(doc.to_string())],
        )
        .expect("jsonb = $1")
        .expect("equal row");
    assert_eq!(int(&equal[0].1), 1);
    // The json column accepts a Json parameter too.
    db.run(
        "UPDATE typed_data SET plain = $1 WHERE id = 1",
        &[Value::Json(r#"{"x": 2}"#.to_string())],
    )
    .expect("update json column");

    // Identity-server shaped queries, all uncast.
    db.exec("CREATE TABLE identities (id uuid primary key, last_seen_at timestamptz)")
        .expect("create identities table");
    db.run(
        "INSERT INTO identities (id, last_seen_at) VALUES ($1, $2)",
        &[
            Value::Text(uid.to_string()),
            Value::Timestamp("2024-01-01T00:00:00Z".to_string()),
        ],
    )
    .expect("uncast uuid and timestamptz insert");
    let found = db
        .first(
            "SELECT id FROM identities WHERE id = $1",
            &[Value::Text(uid.to_string())],
        )
        .expect("WHERE id = $1 (uuid)")
        .expect("identity found");
    assert_eq!(text(&found[0].1), uid);
    let touched = db
        .run(
            "UPDATE identities SET last_seen_at = $1 WHERE id = $2",
            &[
                Value::Timestamp("2024-06-01T08:00:00Z".to_string()),
                Value::Text(uid.to_string()),
            ],
        )
        .expect("SET last_seen_at = $1 (timestamptz)");
    assert_eq!(touched, 1);
    let before = db
        .first(
            "SELECT id FROM identities WHERE last_seen_at < $1",
            &[Value::Timestamp("2024-07-01T00:00:00Z".to_string())],
        )
        .expect("timestamptz < $1")
        .expect("row before cutoff");
    assert_eq!(text(&before[0].1), uid);
    assert!(db
        .first(
            "SELECT id FROM identities WHERE last_seen_at < $1",
            &[Value::Text("2024-01-01T00:00:00Z".to_string())],
        )
        .unwrap()
        .is_none());

    // OID 0 cannot infer an untyped parameter; a cast fixes it (migration note).
    assert!(matches!(
        db.first("SELECT $1 IS NULL", &[Value::Text("x".to_string())]),
        Err(Error::InvalidSql(_))
    ));
    assert!(db
        .first("SELECT $1::text IS NULL", &[Value::Text("x".to_string())])
        .unwrap()
        .is_some());

    // SQLSTATE codes surface through pg-error.code.
    let dup = db.run(
        "INSERT INTO typed_data (id, data) VALUES (1, $1)",
        &[Value::Json(r#"{"dup": "value"}"#.to_string())],
    );
    assert!(
        matches!(dup, Err(Error::ExecutionFailed(e)) if e.code == "23505"),
        "duplicate id should return SQLSTATE 23505"
    );

    db.close().unwrap();
    println!("smoke ok");
}

/// Rows whose text must never appear in the data directory when it is
/// encrypted (pglite-encfs `make smoke` greps for it).
const MARKER: &str = "PGLITE-SMOKE-PLAINTEXT-MARKER";
const MARKER_ROWS: i64 = 200;
/// The marker rows only: commit-a/commit-b add rows of their own.
const MARKER_COUNT: &str =
    "SELECT count(*)::int8 FROM markers WHERE v LIKE 'PGLITE-SMOKE-PLAINTEXT-MARKER-%'";

/// Modes for storage layers below the engine (pglite-encfs `make smoke`).
/// Returns true when `mode` was one of them.
fn durability_mode(db: &Connection, mode: &str) -> bool {
    let count =
        |sql: &str, params: &[Value]| int(&db.first(sql, params).unwrap().expect("count row")[0].1);
    match mode {
        // 200 committed rows plus a checkpoint, so they reach relation files too.
        "marker-write" => {
            db.exec("DROP TABLE IF EXISTS markers; CREATE TABLE markers (id serial primary key, v text)")
                .unwrap();
            db.begin().unwrap();
            for i in 0..MARKER_ROWS {
                db.run(
                    "INSERT INTO markers (v) VALUES ($1)",
                    &[Value::Text(format!("{MARKER}-{i:04}"))],
                )
                .unwrap();
            }
            db.commit().unwrap();
            db.exec("CHECKPOINT").unwrap();
            db.close().unwrap();
            println!("marker-write ok");
        }
        "marker-read" => {
            assert_eq!(count(MARKER_COUNT, &[]), MARKER_ROWS);
            let row = db
                .first("SELECT min(v) AS lo FROM markers", &[])
                .unwrap()
                .unwrap();
            assert_eq!(text(col(&row, "lo")), format!("{MARKER}-0000"));
            db.close().unwrap();
            println!("marker-read ok");
        }
        // One autocommitted (WAL-fsynced) row, then exit without close or
        // checkpoint, so the commit lives only in the WAL.
        "commit-a" | "commit-b" => {
            let tag = if mode == "commit-a" { "A" } else { "B" };
            db.run(
                "INSERT INTO markers (v) VALUES ($1)",
                &[Value::Text(format!("commit-{tag}"))],
            )
            .unwrap();
            println!("{mode} ok");
            // `exit` runs no destructors: the connection is never closed.
            std::process::exit(0);
        }
        // A table created and committed (WAL-fsynced) right before an abrupt
        // exit: its relation files are new, so a crash can catch them mid-creation.
        "create-commit" => {
            db.exec("CREATE TABLE fresh (v text)").unwrap();
            db.run(
                "INSERT INTO fresh (v) VALUES ($1)",
                &[Value::Text("fresh".into())],
            )
            .unwrap();
            println!("create-commit ok");
            // `exit` runs no destructors: the connection is never closed.
            std::process::exit(0);
        }
        "check-fresh" => {
            let n = count("SELECT count(*)::int8 FROM fresh", &[]);
            db.close().unwrap();
            println!("check-fresh N={n}");
        }
        "check-ab" => {
            let committed = |tag: &str| {
                count(
                    "SELECT count(*)::int8 FROM markers WHERE v = $1",
                    &[Value::Text(format!("commit-{tag}"))],
                )
            };
            let (a, b) = (committed("A"), committed("B"));
            assert_eq!(count(MARKER_COUNT, &[]), MARKER_ROWS);
            db.close().unwrap();
            println!("check-ab A={a} B={b}");
        }
        _ => return false,
    }
    true
}
