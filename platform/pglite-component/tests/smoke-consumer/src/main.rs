//! Real-engine conformance and restart test. Run via scripts/smoke.sh.

wit_bindgen::generate!({
    path: "../../wit",
    world: "imports",
});

use di_framework::pglite::database::{open, server_version, Connection};
use di_framework::pglite::types::{Error, OpenOptions, Value};

mod pgp_keys;

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
    // The cross-version step runs `upgrade-write` against the previous release.
    let expected =
        std::env::var("PGLITE_SMOKE_SERVER_VERSION").unwrap_or_else(|_| "17.11".into());
    let version = server_version().expect("server-version");
    assert!(
        version.contains(&expected),
        "unexpected server version {version:?}, expected {expected:?}"
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
    // Explicit database names are checked before the engine boots, so these
    // refusals leave the instance usable (#212).
    for name in ["template0", "orders"] {
        assert!(
            matches!(
                open("/data/pglite", Some(&database(name))),
                Err(Error::OpenFailed(_))
            ),
            "{name} must be refused"
        );
    }
    if mode == "database" {
        database_mode();
        println!("database ok");
        return;
    }
    let db: Connection = open("/data/pglite", None).expect("open");
    assert!(matches!(
        open("/data/pglite", None),
        Err(Error::OpenFailed(_))
    ));
    // Which database `none` selects: `postgres` for a directory this build
    // initialized (the very first session included), `template1` for one
    // written by an earlier release. The previous release reports template1.
    let expected_db = match mode.as_str() {
        "upgrade-write" | "upgrade-read" => "template1",
        _ => "postgres",
    };
    assert_eq!(
        current_database(&db),
        expected_db,
        "{mode}: default database"
    );

    if mode == "upgrade-write" {
        upgrade_write(&db);
        db.close().expect("close upgrade-write");
        println!("upgrade write ok");
        return;
    }
    if mode == "upgrade-read" {
        upgrade_read(&db);
        db.close().expect("close upgrade-read");
        println!("upgrade read ok");
        return;
    }
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
        // pgcrypto created by the write run resolves again in a fresh engine.
        let row = db
            .first("SELECT encode(digest('a', 'sha256'), 'hex') AS h", &[])
            .expect("pgcrypto after restart")
            .unwrap();
        assert_eq!(text(col(&row, "h")), SHA256_A);
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

    // A caller's own `SET TimeZone` (DateStyle still ISO) prints a local offset;
    // the provider converts it back to RFC 3339 in UTC.
    let instant = "SELECT '2024-01-15T10:30:00.5Z'::timestamptz AS t";
    db.exec("SET TimeZone = 'America/New_York'")
        .expect("SET TimeZone");
    let local = db.first(instant, &[]).unwrap().unwrap();
    assert!(
        matches!(col(&local, "t"), Value::Timestamp(t) if t == "2024-01-15T10:30:00.5Z"),
        "SET TimeZone: {:?}",
        col(&local, "t")
    );
    // A non-ISO `SET DateStyle` cannot be normalized, so the value is Text, as printed.
    db.exec("SET DateStyle = 'SQL, DMY'")
        .expect("SET DateStyle");
    let sql_style = db.first(instant, &[]).unwrap().unwrap();
    assert!(
        matches!(col(&sql_style, "t"), Value::Text(t) if t == "15/01/2024 05:30:00.5 EST"),
        "SET DateStyle: {:?}",
        col(&sql_style, "t")
    );
    db.exec("SET TimeZone = 'UTC'")
        .expect("SET TimeZone back to UTC");
    let sql_utc = db.first(instant, &[]).unwrap().unwrap();
    assert!(
        matches!(col(&sql_utc, "t"), Value::Text(t) if t == "15/01/2024 10:30:00.5 UTC"),
        "SET DateStyle with UTC: {:?}",
        col(&sql_utc, "t")
    );
    // Reopening pins DateStyle=ISO and TimeZone=UTC again.
    db.close().expect("close after SET");
    let db: Connection = open("", None).expect("reopen after SET");
    let pinned = db.first(instant, &[]).unwrap().unwrap();
    assert!(matches!(col(&pinned, "t"), Value::Timestamp(t) if t == "2024-01-15T10:30:00.5Z"));

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

    pgcrypto(&db);
    pgcrypto_public_key(&db);
    pgcrypto_legacy_ciphers(&db);
    // Last: it fills the emulated dlopen table for this engine instance.
    dlopen_table(&db);

    db.close().unwrap();
    println!("smoke ok");
}

fn database(name: &str) -> OpenOptions {
    OpenOptions {
        database: Some(name.into()),
        statement_timeout_ms: None,
    }
}

fn current_database(db: &Connection) -> String {
    let row = db
        .first("SELECT current_database()::text AS db", &[])
        .expect("current_database")
        .expect("current_database row");
    text(col(&row, "db"))
}

/// `PGLITE_SMOKE_DATABASE` (unset = `none`) is opened; the session must be
/// in `PGLITE_SMOKE_EXPECT_DB`, and `PGLITE_SMOKE_TABLE` must exist there
/// exactly when `PGLITE_SMOKE_TABLE_PRESENT=1`.
fn database_mode() {
    let env = |name: &str| std::env::var(name).ok();
    let requested = env("PGLITE_SMOKE_DATABASE");
    let expected = env("PGLITE_SMOKE_EXPECT_DB").expect("PGLITE_SMOKE_EXPECT_DB");
    let table = env("PGLITE_SMOKE_TABLE").expect("PGLITE_SMOKE_TABLE");
    let present = env("PGLITE_SMOKE_TABLE_PRESENT").as_deref() == Some("1");

    let options = requested.as_deref().map(database);
    let db = open("/data/pglite", options.as_ref()).expect("open requested database");
    assert_eq!(current_database(&db), expected, "requested {requested:?}");
    let row = db
        .first(
            "SELECT to_regclass($1) IS NOT NULL AS present",
            &[Value::Text(format!("public.{table}"))],
        )
        .expect("to_regclass")
        .expect("to_regclass row");
    assert!(
        matches!(col(&row, "present"), Value::Boolean(found) if *found == present),
        "table {table} in {expected}: expected present={present}"
    );
    db.close().expect("close database mode");

    // The backend cannot change databases: reopening the same one works,
    // asking this instance for the other one fails clearly.
    let again = open("/data/pglite", Some(&database(&expected))).expect("reopen same database");
    assert_eq!(current_database(&again), expected);
    again.close().expect("close reopen");
    let other = if expected == "postgres" {
        "template1"
    } else {
        "postgres"
    };
    match open("/data/pglite", Some(&database(other))) {
        Err(Error::OpenFailed(message)) => {
            assert!(message.contains("cannot switch"), "{message}")
        }
        Err(error) => panic!("switching databases: unexpected {error:?}"),
        Ok(_) => panic!("switching databases must fail"),
    }
}

const SHA256_A: &str = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";

/// Secret the cross-version step encrypts on the previous release.
const UPGRADE_SECRET: &str = "written by the previous release";

/// Run by the previous release (PostgreSQL 17.5) on a fresh data directory:
/// a table, pgcrypto, and PGP ciphertext for the new engine to read back.
fn upgrade_write(db: &Connection) {
    db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        .expect("CREATE EXTENSION pgcrypto");
    db.exec("CREATE TABLE upgrade_check (id int PRIMARY KEY, payload text, secret bytea)")
        .expect("create upgrade_check");
    db.run(
        "INSERT INTO upgrade_check VALUES (1, $1, pgp_sym_encrypt($2, 'k', 'cipher-algo=aes256'))",
        &[
            Value::Text("kept across the upgrade".into()),
            Value::Text(UPGRADE_SECRET.into()),
        ],
    )
    .expect("insert upgrade_check");
}

/// Run by this release on the directory upgrade_write left: the engine is
/// 17.11, the data is intact, and pgcrypto works on old and new data.
fn upgrade_read(db: &Connection) {
    let row = db
        .first("SHOW server_version", &[])
        .expect("server_version")
        .expect("server_version row");
    let engine = text(&row[0].1);
    assert!(engine.starts_with("17.11"), "engine reports {engine:?}");

    let row = db
        .first(
            "SELECT payload, pgp_sym_decrypt(secret, 'k') AS secret FROM upgrade_check WHERE id = 1",
            &[],
        )
        .expect("read upgrade_check")
        .expect("upgrade_check row");
    assert_eq!(text(col(&row, "payload")), "kept across the upgrade");
    assert_eq!(text(col(&row, "secret")), UPGRADE_SECRET);

    // The extension created by 17.5 resolves its functions in 17.11.
    assert_eq!(
        first_text(db, "SELECT encode(digest('a', 'sha256'), 'hex') AS v", &[]),
        SHA256_A
    );
    assert_eq!(
        first_text(
            db,
            "SELECT pgp_sym_decrypt(pgp_sym_encrypt('fresh', 'k'), 'k') AS v",
            &[]
        ),
        "fresh"
    );
    // Upstream's refusal (CVE-2026-14663) holds in the upgraded directory.
    let refused = db.first("SELECT pgp_sym_encrypt('x', 'k', 'cipher-algo=bf')", &[]);
    assert!(
        matches!(&refused, Err(Error::ExecutionFailed(e)) if e.message.contains("Cipher cannot be initialized")),
        "bf: {refused:?}"
    );
    // And the directory stays writable.
    db.run(
        "INSERT INTO upgrade_check VALUES (2, 'written by 17.11', NULL)",
        &[],
    )
    .expect("insert after upgrade");
}

/// pgcrypto is statically linked into the engine with OpenSSL libcrypto;
/// its salts, session keys and padding come from WASI random_get.
fn pgcrypto(db: &Connection) {
    db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto")
        .expect("CREATE EXTENSION pgcrypto");
    let one = |sql: &str| -> String {
        let row = db
            .first(sql, &[])
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"))
            .unwrap_or_else(|| panic!("{sql}: no row"));
        text(&row[0].1)
    };
    assert_eq!(
        one("SELECT pgp_sym_decrypt(pgp_sym_encrypt('x', 'k'), 'k') AS v"),
        "x"
    );
    assert_eq!(
        one("SELECT encode(digest('a', 'sha256'), 'hex') AS v"),
        SHA256_A
    );
    assert_eq!(
        one("SELECT encode(hmac('a', 'k', 'sha1'), 'hex') AS v"),
        "40e7d441cadb17b07f050341aa23a6820ed81c8b"
    );
    let uuid = one("SELECT gen_random_uuid()::text AS v");
    assert_eq!(uuid.len(), 36, "{uuid}");
    assert_eq!(&uuid[14..15], "4", "version-4 uuid {uuid}");
    let hash = one("SELECT crypt('pw', gen_salt('bf')) AS v");
    assert!(hash.starts_with("$2a$06$"), "bcrypt hash {hash}");
    let check = db
        .first(
            "SELECT (crypt('pw', $1::text) = $1::text)::text AS ok, (crypt('nope', $1::text) = $1::text)::text AS bad",
            &[Value::Text(hash.clone())],
        )
        .expect("crypt verify")
        .unwrap();
    assert_eq!(text(col(&check, "ok")), "true");
    assert_eq!(text(col(&check, "bad")), "false");
    // Fresh randomness per call: salts and PGP session keys never repeat.
    assert_ne!(
        one("SELECT gen_salt('bf') AS v"),
        one("SELECT gen_salt('bf') AS v")
    );
    assert_eq!(
        one("SELECT (pgp_sym_encrypt('x', 'k') <> pgp_sym_encrypt('x', 'k'))::text AS v"),
        "true"
    );
    assert_eq!(one("SELECT length(gen_random_bytes(32))::text AS v"), "32");
    // A wrong key is an ordinary, recoverable SQL error.
    assert!(matches!(
        db.first(
            "SELECT pgp_sym_decrypt(pgp_sym_encrypt('x', 'k'), 'wrong')",
            &[]
        ),
        Err(Error::ExecutionFailed(_))
    ));
    assert_eq!(one("SELECT 'still usable'::text AS v"), "still usable");
    println!("pgcrypto ok");
}

/// First text column of the single row `sql` returns with `params`.
fn first_text(db: &Connection, sql: &str, params: &[Value]) -> String {
    let row = db
        .first(sql, params)
        .unwrap_or_else(|e| panic!("{sql}: {e:?}"))
        .unwrap_or_else(|| panic!("{sql}: no row"));
    text(&row[0].1)
}

/// Public-key PGP with ElGamal and RSA keys. pgcrypto's ElGamal encryption
/// draws its ephemeral `k` from OpenSSL's DRBG (`BN_rand`), seeded through
/// WASI `getentropy` -> `random_get`; RSA uses PKCS#1 v1.5 padding from
/// `pg_strong_random`.
fn pgcrypto_public_key(db: &Connection) {
    let keys = [
        (
            "elg1024",
            pgp_keys::ELG1024_PUBLIC,
            pgp_keys::ELG1024_SECRET,
            pgp_keys::ELG1024_MESSAGE,
            "Secret msg",
        ),
        (
            "rsa2048",
            pgp_keys::RSA2048_PUBLIC,
            pgp_keys::RSA2048_SECRET,
            pgp_keys::RSA2048_MESSAGE,
            "Secret message.",
        ),
    ];
    for (name, public, secret, message, plaintext) in keys {
        let public = Value::Text(public.to_string());
        let secret = Value::Text(secret.to_string());
        // Round trip through this engine.
        assert_eq!(
            first_text(
                db,
                "SELECT pgp_pub_decrypt(pgp_pub_encrypt('round trip', dearmor($1::text)), dearmor($2::text)) AS v",
                &[public.clone(), secret.clone()],
            ),
            "round trip",
            "{name} round trip"
        );
        // A message GnuPG encrypted to the same key.
        assert_eq!(
            first_text(
                db,
                "SELECT pgp_pub_decrypt(dearmor($1::text), dearmor($2::text)) AS v",
                &[Value::Text(message.to_string()), secret.clone()],
            ),
            plaintext,
            "{name} GnuPG message"
        );
        // Fresh randomness per call. Bytes 20..84 lie inside the first MPI of
        // the session-key packet: g^k for ElGamal, so equal bytes would mean a
        // repeated k; the padded session key for RSA.
        assert_eq!(
            first_text(
                db,
                "SELECT (substring(pgp_pub_encrypt('x', dearmor($1::text)) FROM 20 FOR 64) <> substring(pgp_pub_encrypt('x', dearmor($1::text)) FROM 20 FOR 64))::text AS v",
                std::slice::from_ref(&public),
            ),
            "true",
            "{name} fresh randomness"
        );
    }
    // The other key cannot decrypt: an ordinary, recoverable SQL error.
    assert!(matches!(
        db.first(
            "SELECT pgp_pub_decrypt(dearmor($1::text), dearmor($2::text))",
            &[
                Value::Text(pgp_keys::ELG1024_MESSAGE.to_string()),
                Value::Text(pgp_keys::RSA2048_SECRET.to_string()),
            ],
        ),
        Err(Error::ExecutionFailed(_))
    ));
    assert_eq!(
        first_text(db, "SELECT 'still usable'::text AS v", &[]),
        "still usable"
    );
    println!("pgcrypto public key ok");
}

/// OpenSSL's legacy provider is not built, so Blowfish, CAST5 and single DES
/// fail cleanly. For PGP that refusal is upstream PostgreSQL's own (17.11,
/// CVE-2026-14663): before it, PGP encryption with an unavailable cipher wrote
/// plaintext. 3DES (DES-EDE3) is in OpenSSL's default provider, and it and
/// AES keep working.
fn pgcrypto_legacy_ciphers(db: &Connection) {
    for cipher in ["bf", "cast5", "des"] {
        let result = db.first(
            "SELECT encrypt('data'::bytea, '01234567'::bytea, $1::text)",
            &[Value::Text(cipher.to_string())],
        );
        assert!(
            matches!(&result, Err(Error::ExecutionFailed(e)) if e.message.contains("Cipher cannot be initialized")),
            "{cipher}: {result:?}"
        );
    }
    // PGP (which has no single DES) refuses them too, for the data and for a
    // separate session key.
    for cipher in ["bf", "cast5"] {
        for options in [
            format!("cipher-algo={cipher}"),
            format!("cipher-algo=aes128, sess-key=1, s2k-cipher-algo={cipher}"),
        ] {
            let pgp = db.first(
                "SELECT pgp_sym_encrypt('data', 'k', $1::text)",
                &[Value::Text(options.clone())],
            );
            assert!(
                matches!(&pgp, Err(Error::ExecutionFailed(e)) if e.message.contains("Cipher cannot be initialized")),
                "pgp {options}: {pgp:?}"
            );
        }
    }
    // Public-key encryption refuses them as the data cipher.
    for cipher in ["bf", "cast5"] {
        let pgp = db.first(
            "SELECT pgp_pub_encrypt('data', dearmor($1::text), $2::text)",
            &[
                Value::Text(pgp_keys::RSA2048_PUBLIC.to_string()),
                Value::Text(format!("cipher-algo={cipher}")),
            ],
        );
        assert!(
            matches!(&pgp, Err(Error::ExecutionFailed(e)) if e.message.contains("Cipher cannot be initialized")),
            "pgp_pub_encrypt {cipher}: {pgp:?}"
        );
    }
    // A Blowfish PGP message from PostgreSQL's regression suite cannot be
    // decrypted, as text or as bytea.
    for function in ["pgp_sym_decrypt", "pgp_sym_decrypt_bytea"] {
        let result = db.first(
            &format!("SELECT {function}(dearmor($1::text), 'foobar')"),
            &[Value::Text(pgp_keys::BLOWFISH_MESSAGE.to_string())],
        );
        assert!(
            matches!(&result, Err(Error::ExecutionFailed(e)) if e.message.contains("Cipher cannot be initialized")),
            "{function}: {result:?}"
        );
    }
    for cipher in ["aes", "3des"] {
        assert_eq!(
            first_text(
                db,
                "SELECT convert_from(decrypt(encrypt('data', '0123456789abcdef01234567', $1::text), '0123456789abcdef01234567', $1::text), 'UTF8') AS v",
                &[Value::Text(cipher.to_string())],
            ),
            "data",
            "{cipher}"
        );
    }
    for options in [
        "cipher-algo=3des",
        "cipher-algo=aes128, sess-key=1, s2k-cipher-algo=3des",
    ] {
        assert_eq!(
            first_text(
                db,
                "SELECT pgp_sym_decrypt(pgp_sym_encrypt('x', 'k', $1::text), 'k') AS v",
                &[Value::Text(options.to_string())],
            ),
            "x",
            "{options}"
        );
    }
    println!("pgcrypto legacy ciphers unavailable ok");
}

/// wasipg emulates dlopen with a fixed table of loaded libraries. Filling it
/// must fail the next new LOAD with an error, not write past the table, and
/// leave plpgsql, pgcrypto and already-loaded libraries working. LOAD on the
/// emulated loader only stats the file, so template1's relation files serve
/// as distinct "libraries".
fn dlopen_table(db: &Connection) {
    db.exec(
        r#"CREATE FUNCTION pg_temp.df_dlopen_fill(OUT loaded int, OUT first_file text, OUT err text)
        LANGUAGE plpgsql AS $$
        DECLARE
          dir text := current_setting('data_directory') || '/base/1';
          f text;
        BEGIN
          loaded := 0;
          FOR f IN SELECT dir || '/' || n FROM pg_ls_dir(dir) AS n WHERE n ~ '^[0-9]+$' ORDER BY n LOOP
            BEGIN
              EXECUTE format('LOAD %L', f);
              loaded := loaded + 1;
              first_file := coalesce(first_file, f);
            EXCEPTION WHEN others THEN
              err := SQLERRM;
              RETURN;
            END;
          END LOOP;
        END
        $$"#,
    )
    .expect("create df_dlopen_fill");
    let row = db
        .first(
            "SELECT loaded::int8, first_file, err FROM pg_temp.df_dlopen_fill()",
            &[],
        )
        .expect("df_dlopen_fill")
        .expect("df_dlopen_fill row");
    let loaded = int(col(&row, "loaded"));
    let first_file = text(col(&row, "first_file"));
    let err = text(col(&row, "err"));
    // plpgsql already holds a slot; the table has 64.
    assert!((1..64).contains(&loaded), "loaded {loaded}");
    assert!(err.contains("dlopen table is full"), "{err}");
    // An already-loaded library is found without a new slot.
    db.exec(&format!("LOAD '{first_file}'"))
        .expect("reload a loaded library");
    // A new one still fails cleanly.
    let pg_version = first_text(
        db,
        "SELECT current_setting('data_directory') || '/PG_VERSION' AS v",
        &[],
    );
    let full = db.exec(&format!("LOAD '{pg_version}'"));
    assert!(
        matches!(&full, Err(Error::ExecutionFailed(e)) if e.message.contains("dlopen table is full")),
        "{full:?}"
    );
    db.exec("DO $$ BEGIN PERFORM 1; END $$")
        .expect("plpgsql after a full table");
    assert_eq!(
        first_text(db, "SELECT encode(digest('a', 'sha256'), 'hex') AS v", &[]),
        SHA256_A
    );
    println!("dlopen table ok");
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
