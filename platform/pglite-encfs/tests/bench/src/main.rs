//! Benchmark consumer for section 11 of the codec-4 design note (#200): the
//! README workloads, commits with multi-page WAL flushes, a bulk load plus
//! checkpoint, a scan in a fresh engine, and cold and warm `stat-at`, each
//! timed inside the guest. `scripts/bench.ts` composes it with pglite alone
//! (plaintext) and with encfs plugged into pglite and into this component,
//! so its own `std::fs` calls reach encfs too, and runs one phase per
//! process, selected by `PGLITE_BENCH_PHASE`. Every phase prints one
//! `bench <phase> key=value ...` line, which the script collects.

wit_bindgen::generate!({
    path: "../../../pglite-component/wit",
    world: "imports",
});

use std::path::PathBuf;
use std::time::Instant;

use di_framework::pglite::database::{open, Connection};
use di_framework::pglite::types::Value;

const ROOT: &str = "/data/pglite";
/// README: 3000 inserts, 10 per transaction, then 3000 point selects.
const OLTP_ROWS: i64 = 3000;
const ROWS_PER_COMMIT: i64 = 10;
/// Multi-page WAL flushes: one incompressible 24 KiB row per commit, TOASTed
/// out of line, so each commit flushes several WAL pages.
const WIDE_COMMITS: usize = 200;
const WIDE_BYTES: usize = 24 * 1024;
/// README: 200k rows of about 240 bytes (48 MB), then a checkpoint.
const BULK_ROWS: i64 = 200_000;
/// Files held open at once in the warm `stat-at` pass: under macOS's default
/// soft limit of 256 descriptors per process.
const OPEN_BATCH: usize = 128;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn count(db: &Connection, sql: &str) -> i64 {
    match db.first(sql, &[]).expect(sql).expect("one row")[0].1 {
        Value::Integer(n) => n,
        ref other => panic!("{sql}: expected an integer, got {other:?}"),
    }
}

fn main() {
    let phase = std::env::var("PGLITE_BENCH_PHASE").expect("PGLITE_BENCH_PHASE");
    match phase.as_str() {
        "init" => init(),
        "oltp" => oltp(),
        "bulk" => bulk(),
        "scan" => scan(),
        "stat" => stat(),
        other => panic!("unknown phase {other}"),
    }
}

/// initdb on an empty directory, then a clean close.
fn init() {
    let started = Instant::now();
    let db = open(ROOT, None).expect("open");
    let open_ms = ms(started);
    db.close().expect("close");
    println!("bench init open_ms={open_ms:.0}");
}

fn oltp() {
    let db = open(ROOT, None).expect("open");
    db.exec("CREATE TABLE bench_tasks (id serial primary key, payload text)")
        .expect("create bench_tasks");
    let started = Instant::now();
    for tx in 0..OLTP_ROWS / ROWS_PER_COMMIT {
        db.begin().expect("begin");
        for i in 0..ROWS_PER_COMMIT {
            db.run(
                "INSERT INTO bench_tasks (payload) VALUES ($1)",
                &[Value::Text(format!("task-{}", tx * ROWS_PER_COMMIT + i))],
            )
            .expect("insert");
        }
        db.commit().expect("commit");
    }
    let inserts_ms = ms(started);

    let started = Instant::now();
    let mut hits = 0;
    for id in 1..=OLTP_ROWS {
        let row = db
            .first(
                "SELECT payload FROM bench_tasks WHERE id = $1",
                &[Value::Integer(id)],
            )
            .expect("select");
        hits += i64::from(row.is_some());
    }
    let selects_ms = ms(started);
    assert_eq!(hits, OLTP_ROWS);

    db.exec("CREATE TABLE bench_wide (id serial primary key, payload bytea)")
        .expect("create bench_wide");
    let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
    let payloads: Vec<Vec<u8>> = (0..WIDE_COMMITS)
        .map(|_| (0..WIDE_BYTES).map(|_| rng.next() as u8).collect())
        .collect();
    let started = Instant::now();
    for payload in payloads {
        db.run(
            "INSERT INTO bench_wide (payload) VALUES ($1)",
            &[Value::Blob(payload)],
        )
        .expect("insert wide");
    }
    let wide_ms = ms(started);
    assert_eq!(
        count(&db, "SELECT count(*)::int8 FROM bench_wide"),
        WIDE_COMMITS as i64
    );
    db.close().expect("close");
    println!(
        "bench oltp inserts_ms={inserts_ms:.0} selects_ms={selects_ms:.0} wide_ms={wide_ms:.0}"
    );
}

fn bulk() {
    let db = open(ROOT, None).expect("open");
    let started = Instant::now();
    db.exec(&format!(
        "CREATE TABLE bench_bulk AS SELECT i AS id, \
         md5(i::text) || md5((i * 7)::text) || md5((i * 13)::text) || \
         md5((i * 17)::text) || md5((i * 19)::text) || md5((i * 23)::text) AS v \
         FROM generate_series(1, {BULK_ROWS}) AS g(i)"
    ))
    .expect("bulk load");
    let load_ms = ms(started);
    let started = Instant::now();
    db.exec("CHECKPOINT").expect("checkpoint");
    let checkpoint_ms = ms(started);
    let bytes = count(&db, "SELECT pg_relation_size('bench_bulk')::int8");
    db.close().expect("close");
    println!("bench bulk load_ms={load_ms:.0} checkpoint_ms={checkpoint_ms:.0} bytes={bytes}");
}

/// A fresh engine (empty shared buffers) scanning the bulk table.
fn scan() {
    let started = Instant::now();
    let db = open(ROOT, None).expect("open");
    let open_ms = ms(started);
    let started = Instant::now();
    let rows = count(
        &db,
        "SELECT count(*)::int8 FROM bench_bulk WHERE length(v) = 192",
    );
    let scan_ms = ms(started);
    assert_eq!(rows, BULK_ROWS);
    db.close().expect("close");
    println!("bench scan open_ms={open_ms:.0} scan_ms={scan_ms:.0} rows={rows}");
}

/// `stat-at` on every relation file of every database, through this
/// component's own filesystem imports (5.3). Three passes by path:
/// `cold`, with no state anywhere; `miss`, the same again while nobody
/// holds the files open (hitting the closed-file size cache of #654);
/// and `warm`, with the files held open and stat'ed once through their
/// descriptors first, so their state is filed as it is for the segments
/// PostgreSQL has open. The opens are batched under the host's descriptor
/// limit.
fn stat() {
    let mut files: Vec<PathBuf> = Vec::new();
    for database in std::fs::read_dir(format!("{ROOT}/data/base")).expect("base") {
        let database = database.expect("entry");
        if database.file_type().expect("type").is_dir() {
            for file in std::fs::read_dir(database.path()).expect("database") {
                files.push(file.expect("entry").path());
            }
        }
    }
    files.sort();
    // Total microseconds and bytes of one by-path pass over `files`.
    let by_path = |files: &[PathBuf]| {
        let started = Instant::now();
        let bytes: u64 = files
            .iter()
            .map(|file| std::fs::metadata(file).expect("stat").len())
            .sum();
        (started.elapsed().as_secs_f64() * 1e6, bytes)
    };
    let (cold, bytes) = by_path(&files);
    let (miss, again) = by_path(&files);
    assert_eq!(bytes, again);
    let (mut warm, mut held_bytes) = (0.0, 0);
    for batch in files.chunks(OPEN_BATCH) {
        let held: Vec<std::fs::File> = batch
            .iter()
            .map(|file| std::fs::File::open(file).expect("open"))
            .collect();
        for file in &held {
            file.metadata().expect("stat through the descriptor");
        }
        let (us, b) = by_path(batch);
        warm += us;
        held_bytes += b;
        drop(held);
    }
    assert_eq!(bytes, held_bytes);
    let per_file = |total: f64| total / files.len() as f64;
    println!(
        "bench stat files={} cold_us={:.1} miss_us={:.1} warm_us={:.1} bytes={bytes}",
        files.len(),
        per_file(cold),
        per_file(miss),
        per_file(warm),
    );
}

struct XorShift(u64);

impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}
