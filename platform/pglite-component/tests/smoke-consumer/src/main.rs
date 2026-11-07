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
    let expected = std::env::var("PGLITE_SMOKE_SERVER_VERSION").unwrap_or_else(|_| "18.6".into());
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
    if mode == "missing-database" {
        missing_database_mode();
        println!("missing database ok");
        return;
    }
    if mode == "upgrade-refused" {
        upgrade_refused_mode();
        println!("upgrade refused ok");
        return;
    }
    if mode == "export-sql" {
        export_sql_mode();
        println!("export sql ok");
        return;
    }
    if mode == "import-sql" {
        import_sql_mode();
        println!("import sql ok");
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
        "upgrade-write" => "template1",
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
    if mode == "corrupt-write" {
        corrupt_write(db);
        println!("corrupt-write ok");
        return;
    }
    if mode == "corrupt-read" {
        corrupt_read(&db);
        db.close().expect("close corrupt-read");
        println!("\ncorrupt-read ok");
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
    for setting in [
        "fsync",
        "synchronous_commit",
        "full_page_writes",
        "data_checksums",
    ] {
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

/// A directory without the `postgres` database (initdb's last step never
/// ran): an explicit `postgres` open fails cleanly instead of trapping, and
/// the same instance can still open the default (`template1`).
fn missing_database_mode() {
    match open("/data/pglite", Some(&database("postgres"))) {
        Err(Error::OpenFailed(message)) => {
            assert!(
                message.contains("\"postgres\" has no data directory at base/5"),
                "{message}"
            )
        }
        Err(error) => panic!("missing postgres: unexpected {error:?}"),
        Ok(_) => panic!("opening a missing postgres database must fail"),
    }
    let db = open("/data/pglite", None).expect("open default after the refusal");
    assert_eq!(current_database(&db), "template1");
    db.close().expect("close missing-database mode");
}

const SHA256_A: &str = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";

/// Secret the cross-version step encrypts on the previous release.
const UPGRADE_SECRET: &str = "written by the previous release";

/// Run by the previous release (PostgreSQL 17.5) on a fresh data directory:
/// tables (with serial, identity, generated columns, and a foreign key),
/// a standalone index, a view, pgcrypto, PGP ciphertext, and a plpgsql function
/// to migrate to 18.6.
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
    db.exec(
        "CREATE TABLE upgrade_items ( \
           id serial PRIMARY KEY, \
           check_id int NOT NULL REFERENCES upgrade_check(id), \
           seq_num int GENERATED ALWAYS AS IDENTITY, \
           label text NOT NULL, \
           upper_label text GENERATED ALWAYS AS (upper(label)) STORED \
         )",
    )
    .expect("create upgrade_items");
    db.run(
        "INSERT INTO upgrade_items (check_id, label) VALUES (1, $1)",
        &[Value::Text("item-one".into())],
    )
    .expect("insert upgrade_items");
    db.exec("CREATE INDEX upgrade_items_label_idx ON upgrade_items (label)")
        .expect("create upgrade_items_label_idx");
    db.exec(
        "CREATE VIEW upgrade_summary AS \
         SELECT c.id, c.payload, i.label, i.upper_label \
         FROM upgrade_check c JOIN upgrade_items i ON i.check_id = c.id",
    )
    .expect("create upgrade_summary view");
    db.exec(
        "CREATE FUNCTION upgrade_greeting(name text) RETURNS text \
         LANGUAGE plpgsql AS $$ BEGIN RETURN 'hello ' || name; END $$",
    )
    .expect("create upgrade_greeting");
    db.exec("CHECKPOINT").expect("checkpoint upgrade_write");
}

/// Path 1 (#401): opening an unmigrated PostgreSQL 17 data directory under the
/// PostgreSQL 18.6 provider fails cleanly with `Error::OpenFailed` naming the
/// version mismatch and pointing to the documented migration guide and script.
fn upgrade_refused_mode() {
    match open("/data/pglite", None) {
        Err(Error::OpenFailed(message)) => {
            assert!(
                message.contains(
                    "incompatible PostgreSQL data directory: PG_VERSION is 17, \
                     but this provider bundles PostgreSQL 18.6 and opens only \
                     major version 18 data directories"
                ),
                "unexpected version mismatch message: {message}"
            );
            assert!(
                message.contains(
                    "platform/pglite-component/README.md#migrating-from-postgresql-17-to-18"
                ),
                "missing README migration anchor: {message}"
            );
            assert!(
                message.contains("scripts/migrate-17-to-18.ts"),
                "missing migration script pointer: {message}"
            );
        }
        Err(other) => panic!("expected OpenFailed on PG 17 directory, got {other:?}"),
        Ok(_) => panic!("opening an unmigrated PG 17 directory under PG 18.6 must fail"),
    }
}

/// Logical SQL export for 17 -> 18 migration (`scripts/migrate-17-to-18.ts`).
fn export_sql_mode() {
    let dump_path =
        std::env::var("PGLITE_MIGRATE_DUMP_PATH").unwrap_or_else(|_| "/dump/migration.sql".into());
    let requested_db = std::env::var("PGLITE_MIGRATE_DATABASE")
        .ok()
        .filter(|s| !s.is_empty());
    let assert_empty_public =
        std::env::var("PGLITE_MIGRATE_ASSERT_EMPTY_PUBLIC").as_deref() == Ok("1");
    let options = requested_db.as_deref().map(database);
    let db = match open("/data/pglite", options.as_ref()) {
        Ok(db) => db,
        Err(Error::OpenFailed(msg))
            if assert_empty_public && msg.contains("supports only the template1 database") =>
        {
            println!("sibling database public schema is empty");
            return;
        }
        Err(err) => panic!("open source cluster for export: {err:?}"),
    };

    if assert_empty_public {
        let active_db = current_database(&db);
        let found = db
            .first(
                "SELECT string_agg(item, ', ' ORDER BY item) AS items FROM ( \
                   SELECT c.relname AS item \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE n.nspname = 'public' \
                     AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') \
                     AND NOT EXISTS ( \
                       SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e' \
                     ) \
                   UNION ALL \
                   SELECT p.proname AS item \
                   FROM pg_proc p \
                   JOIN pg_namespace n ON n.oid = p.pronamespace \
                   WHERE n.nspname = 'public' \
                     AND NOT EXISTS ( \
                       SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e' \
                     ) \
                 ) sub",
                &[],
            )
            .expect("query non-default database public objects")
            .expect("non-default database row");
        if let Value::Text(items) = col(&found, "items") {
            panic!(
                "non-default database {active_db:?} contains user objects in public ({items}); \
                 pass --database {active_db} to migrate it separately"
            );
        }
        db.close().expect("close empty-check database");
        return;
    }

    // Fail closed if public contains object kinds this logical exporter does not support.
    let unsupported = db
        .first(
            "SELECT string_agg(item, ', ' ORDER BY item) AS items FROM ( \
               SELECT format('%s %I', \
                        CASE c.relkind \
                          WHEN 'm' THEN 'materialized view' \
                          WHEN 'p' THEN 'partitioned table' \
                          WHEN 'f' THEN 'foreign table' \
                          ELSE 'relation' \
                        END, \
                        c.relname) AS item \
               FROM pg_class c \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = 'public' \
                 AND c.relkind IN ('m', 'p', 'f') \
                 AND NOT EXISTS ( \
                   SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e' \
                 ) \
               UNION ALL \
               SELECT format('procedure %I', p.proname) AS item \
               FROM pg_proc p \
               JOIN pg_namespace n ON n.oid = p.pronamespace \
               WHERE n.nspname = 'public' \
                 AND p.prokind = 'p' \
                 AND NOT EXISTS ( \
                   SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e' \
                 ) \
               UNION ALL \
               SELECT format('trigger %I on %I', t.tgname, c.relname) AS item \
               FROM pg_trigger t \
               JOIN pg_class c ON c.oid = t.tgrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = 'public' \
                 AND NOT t.tgisinternal \
             ) sub",
            &[],
        )
        .expect("query unsupported public objects")
        .expect("unsupported public objects row");
    if let Value::Text(items) = col(&unsupported, "items") {
        panic!("unsupported public objects cannot be migrated automatically: {items}");
    }

    let mut out = String::from("-- di-framework:pglite logical export\n");

    let exts = db
        .query(
            "SELECT format('CREATE EXTENSION IF NOT EXISTS %I;', extname) AS stmt \
             FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname",
            &[],
        )
        .expect("query extensions");
    for row in exts {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    // Export standalone and serial sequences before tables (identity sequences
    // have deptype = 'i' and are created by `GENERATED ... AS IDENTITY` on the table).
    let seqs = db
        .query(
            "SELECT format( \
               'CREATE SEQUENCE IF NOT EXISTS public.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;', \
               s.sequencename, \
               s.data_type, \
               s.increment_by, \
               s.min_value, \
               s.max_value, \
               s.start_value, \
               s.cache_size, \
               CASE WHEN s.cycle THEN ' CYCLE' ELSE ' NO CYCLE' END \
             ) AS stmt \
             FROM pg_sequences s \
             JOIN pg_class c ON c.relname = s.sequencename \
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname \
             WHERE s.schemaname = 'public' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('e', 'i') \
               ) \
             ORDER BY s.sequencename",
            &[],
        )
        .expect("query sequences");
    for row in seqs {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    let tables = db
        .query(
            "SELECT c.oid::int8 AS oid, c.relname AS relname, \
                    EXISTS ( \
                      SELECT 1 FROM pg_attribute a \
                      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> '' \
                    ) AS has_identity, \
                    format('CREATE TABLE public.%I (%s);', \
                      c.relname, \
                      concat_ws(', ', \
                        (SELECT string_agg( \
                           format('%I %s%s%s', \
                             a.attname, \
                             format_type(a.atttypid, a.atttypmod), \
                             CASE \
                               WHEN a.attidentity = 'a' THEN ' GENERATED ALWAYS AS IDENTITY' \
                               WHEN a.attidentity = 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' \
                               WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(ad.adbin, ad.adrelid) || ') STORED' \
                               WHEN ad.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid) \
                               ELSE '' \
                             END, \
                             CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END \
                           ), \
                           ', ' ORDER BY a.attnum \
                         ) \
                         FROM pg_attribute a \
                         LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
                         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), \
                        (SELECT string_agg( \
                           format('CONSTRAINT %I %s', con.conname, pg_get_constraintdef(con.oid)), \
                           ', ' ORDER BY con.conname \
                         ) \
                         FROM pg_constraint con \
                         WHERE con.conrelid = c.oid AND con.contype IN ('p', 'u', 'c')) \
                      ) \
                    ) AS ddl \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = 'public' \
               AND c.relkind = 'r' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e' \
               ) \
             ORDER BY c.relname",
            &[],
        )
        .expect("query tables");
    for table in tables {
        let oid = int(col(&table, "oid"));
        let relname = text(col(&table, "relname"));
        let has_identity = matches!(col(&table, "has_identity"), Value::Boolean(true));
        let ddl = text(col(&table, "ddl"));
        out.push_str(&ddl);
        out.push('\n');

        let overriding = if has_identity {
            " OVERRIDING SYSTEM VALUE"
        } else {
            ""
        };
        let row_query_row = db
            .first(
                "SELECT format( \
                   'SELECT ''INSERT INTO public.%I (%s)' || $3::text || ' VALUES ('' || %s || '');'' AS stmt FROM public.%I', \
                   $1::text, \
                   string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum), \
                   string_agg( \
                     format( \
                       'COALESCE(quote_literal(%I::text) || %L, ''NULL'')', \
                       a.attname, \
                       '::' || format_type(a.atttypid, a.atttypmod) \
                     ), \
                     ' || '', '' || ' ORDER BY a.attnum \
                   ), \
                   $1::text \
                 ) AS row_query \
                 FROM pg_attribute a \
                 WHERE a.attrelid = $2::int8::oid \
                   AND a.attnum > 0 \
                   AND NOT a.attisdropped \
                   AND a.attgenerated = ''",
                &[
                    Value::Text(relname),
                    Value::Integer(oid),
                    Value::Text(overriding.into()),
                ],
            )
            .expect("build row export query")
            .expect("row export query");
        if let Value::Text(row_query) = col(&row_query_row, "row_query") {
            for ins in db.query(row_query, &[]).expect("export table rows") {
                out.push_str(&text(col(&ins, "stmt")));
                out.push('\n');
            }
        }
    }

    // Advance all public sequences (both serial and identity) whose value was drawn.
    let seq_vals = db
        .query(
            "SELECT format('SELECT pg_catalog.setval(%L, %s, true);', \
                      format('public.%I', s.sequencename), \
                      s.last_value) AS stmt \
             FROM pg_sequences s \
             WHERE s.schemaname = 'public' AND s.last_value IS NOT NULL \
             ORDER BY s.sequencename",
            &[],
        )
        .expect("query sequence values");
    for row in seq_vals {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    // Foreign keys after all table data is loaded so table order cannot break references.
    let fks = db
        .query(
            "SELECT format('ALTER TABLE public.%I ADD CONSTRAINT %I %s;', \
                      c.relname, con.conname, pg_get_constraintdef(con.oid)) AS stmt \
             FROM pg_constraint con \
             JOIN pg_class c ON c.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = 'public' AND con.contype = 'f' \
             ORDER BY c.relname, con.conname",
            &[],
        )
        .expect("query foreign keys");
    for row in fks {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    // Standalone indexes not backing a constraint.
    let idxs = db
        .query(
            "SELECT pg_get_indexdef(i.indexrelid) || ';' AS stmt \
             FROM pg_index i \
             JOIN pg_class idx ON idx.oid = i.indexrelid \
             JOIN pg_class tbl ON tbl.oid = i.indrelid \
             JOIN pg_namespace n ON n.oid = tbl.relnamespace \
             WHERE n.nspname = 'public' \
               AND tbl.relkind = 'r' \
               AND i.indislive \
               AND NOT EXISTS ( \
                 SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid \
               ) \
               AND NOT EXISTS ( \
                 SELECT 1 FROM pg_depend d WHERE d.objid = idx.oid AND d.deptype = 'e' \
               ) \
             ORDER BY tbl.relname, idx.relname",
            &[],
        )
        .expect("query standalone indexes");
    for row in idxs {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    let funcs = db
        .query(
            "SELECT pg_get_functiondef(p.oid) || ';' AS stmt \
             FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = 'public' \
               AND p.prokind = 'f' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e' \
               ) \
             ORDER BY p.proname, p.oid",
            &[],
        )
        .expect("query functions");
    for row in funcs {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    let views = db
        .query(
            "SELECT format('CREATE OR REPLACE VIEW public.%I AS %s;', \
                      c.relname, pg_get_viewdef(c.oid, true)) AS stmt \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = 'public' \
               AND c.relkind = 'v' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e' \
               ) \
             ORDER BY c.relname",
            &[],
        )
        .expect("query views");
    for row in views {
        out.push_str(&text(col(&row, "stmt")));
        out.push('\n');
    }

    db.close().expect("close export-sql");
    std::fs::write(&dump_path, out).expect("write exported SQL dump");
}

/// Logical SQL import into a fresh PostgreSQL 18 cluster (`scripts/migrate-17-to-18.ts`).
fn import_sql_mode() {
    let dump_path =
        std::env::var("PGLITE_MIGRATE_DUMP_PATH").unwrap_or_else(|_| "/dump/migration.sql".into());
    let requested_db = std::env::var("PGLITE_MIGRATE_DATABASE")
        .ok()
        .filter(|s| !s.is_empty());
    let options = requested_db.as_deref().map(database);
    let sql = std::fs::read_to_string(&dump_path).expect("read exported SQL dump");
    let db = open("/data/pglite", options.as_ref()).expect("open target cluster for import");
    db.begin().expect("begin import transaction");
    db.exec(&sql).expect("execute imported SQL dump");
    db.commit().expect("commit import transaction");
    db.exec("CHECKPOINT").expect("checkpoint imported cluster");
    db.close().expect("close import-sql");
}

/// Run by this release on the directory migrated from `upgrade_write`: the
/// engine is 18.6, checksums are enabled, the data and functions are intact,
/// and pgcrypto works on old and new data.
fn upgrade_read(db: &Connection) {
    let row = db
        .first("SHOW server_version", &[])
        .expect("server_version")
        .expect("server_version row");
    let engine = text(&row[0].1);
    assert!(engine.starts_with("18.6"), "engine reports {engine:?}");
    assert_eq!(
        first_text(db, "SHOW data_checksums", &[]),
        "on",
        "migrated PG 18 cluster must have data_checksums on"
    );

    let row = db
        .first(
            "SELECT payload, pgp_sym_decrypt(secret, 'k') AS secret FROM upgrade_check WHERE id = 1",
            &[],
        )
        .expect("read upgrade_check")
        .expect("upgrade_check row");
    assert_eq!(text(col(&row, "payload")), "kept across the upgrade");
    assert_eq!(text(col(&row, "secret")), UPGRADE_SECRET);
    assert_eq!(
        first_text(db, "SELECT upgrade_greeting('pg18') AS g", &[]),
        "hello pg18"
    );

    // Verify migrated serial, identity, generated column, foreign key, index, and view.
    let item = db
        .first(
            "SELECT id::int8 AS id, seq_num::int8 AS seq_num, label, upper_label \
             FROM upgrade_items WHERE id = 1",
            &[],
        )
        .expect("read upgrade_items")
        .expect("upgrade_items row 1");
    assert_eq!(int(col(&item, "id")), 1);
    assert_eq!(int(col(&item, "seq_num")), 1);
    assert_eq!(text(col(&item, "label")), "item-one");
    assert_eq!(text(col(&item, "upper_label")), "ITEM-ONE");

    // Inserting without id/seq_num uses the migrated serial + identity sequences (advancing to 2).
    let item2 = db
        .first(
            "INSERT INTO upgrade_items (check_id, label) VALUES (1, 'item-two') \
             RETURNING id::int8 AS id, seq_num::int8 AS seq_num, upper_label",
            &[],
        )
        .expect("insert second upgrade_item")
        .expect("second upgrade_item row");
    assert_eq!(int(col(&item2, "id")), 2);
    assert_eq!(int(col(&item2, "seq_num")), 2);
    assert_eq!(text(col(&item2, "upper_label")), "ITEM-TWO");

    // Foreign key constraint (contype = 'f') must be enforced after migration.
    let fk_err = db.run(
        "INSERT INTO upgrade_items (check_id, label) VALUES (999, 'bad-fk')",
        &[],
    );
    assert!(
        matches!(fk_err, Err(Error::ExecutionFailed(ref e)) if e.code == "23503"),
        "expected foreign_key_violation (23503), got {fk_err:?}"
    );

    // Standalone index and view must be present after migration.
    let idx = db
        .first(
            "SELECT to_regclass('public.upgrade_items_label_idx') IS NOT NULL AS present",
            &[],
        )
        .expect("check migrated index")
        .expect("index row");
    assert!(matches!(col(&idx, "present"), Value::Boolean(true)));
    assert_eq!(
        first_text(
            db,
            "SELECT upper_label FROM upgrade_summary WHERE label = 'item-one'",
            &[]
        ),
        "ITEM-ONE"
    );

    // The extension migrated from 17.5 resolves its functions in 18.6.
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
    // Upstream's refusal (CVE-2026-14663) holds in the migrated directory.
    let refused = db.first("SELECT pgp_sym_encrypt('x', 'k', 'cipher-algo=bf')", &[]);
    assert!(
        matches!(&refused, Err(Error::ExecutionFailed(e)) if e.message.contains("Cipher cannot be initialized")),
        "bf: {refused:?}"
    );
    // And the directory stays writable.
    db.run(
        "INSERT INTO upgrade_check VALUES (2, 'written by 18.6', NULL)",
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

/// Write and checkpoint a canary relation in `postgres` (`base/5/`), close the
/// engine, then corrupt one 16-byte block in the relation's heap file on disk
/// (#537). Under both plaintext and AES-XTS (`pglite-encfs` codecs 2/3), the
/// last 32..16 bytes of the file lie inside the tuple payload at the end of
/// block 0.
fn corrupt_write(db: Connection) {
    let row = db
        .first("SHOW data_checksums", &[])
        .expect("SHOW data_checksums")
        .unwrap();
    assert_eq!(text(&row[0].1), "on", "data_checksums must be on");
    db.exec(
        "DROP TABLE IF EXISTS checksum_canary; \
         CREATE TABLE checksum_canary (id int primary key, payload text)",
    )
    .expect("create checksum_canary");
    db.run(
        "INSERT INTO checksum_canary VALUES (1, $1)",
        &[Value::Text("intact-canary-before-corruption".into())],
    )
    .expect("insert checksum_canary");
    db.exec("CHECKPOINT").expect("checkpoint checksum_canary");
    let relpath = first_text(
        &db,
        "SELECT pg_relation_filepath('checksum_canary')::text AS p",
        &[],
    );
    assert!(
        relpath.starts_with("base/5/"),
        "expected checksum_canary in base/5/, got {relpath}"
    );
    db.close().expect("close before corrupting relation file");

    let path = format!("/data/pglite/data/{relpath}");
    let mut bytes = std::fs::read(&path).expect("read relation file");
    assert!(
        bytes.len() >= 8192,
        "relation file {path} too short: {}",
        bytes.len()
    );
    let target = bytes.len() - 32;
    for b in &mut bytes[target..target + 16] {
        *b ^= 0xA5;
    }
    std::fs::write(&path, &bytes).expect("write corrupted relation file");
}

/// Reading the corrupted relation in a fresh engine instance (cold shared
/// buffers) must fail with SQLSTATE `XX001` (`ERRCODE_DATA_CORRUPTED`,
/// `invalid page in block 0`) instead of returning corrupted tuple data (#537).
fn corrupt_read(db: &Connection) {
    let result = db.first("SELECT payload FROM checksum_canary WHERE id = 1", &[]);
    match &result {
        Err(Error::ExecutionFailed(e))
            if e.code == "XX001" && e.message.contains("invalid page in block 0") => {}
        other => panic!("expected ExecutionFailed(XX001, invalid page in block 0), got {other:?}"),
    }
    // The session remains usable after the page-checksum failure.
    assert_eq!(
        first_text(db, "SELECT 'session usable after XX001'::text AS v", &[]),
        "session usable after XX001"
    );
    db.exec("DROP TABLE checksum_canary")
        .expect("drop corrupted checksum_canary");
    db.exec("CHECKPOINT")
        .expect("checkpoint after dropping checksum_canary");
}

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
