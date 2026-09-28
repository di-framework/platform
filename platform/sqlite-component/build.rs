//! Compiles `csrc/wasi-vfs.c`, the SQLite VFS that maps SQLite's file
//! operations onto the WASI filesystem (via wasi-libc). `sqlite3.c` itself is
//! compiled by `libsqlite3-sys` with `-DSQLITE_OS_OTHER=1` (see
//! `.cargo/config.toml` / `scripts/env.sh`), which makes it expect the
//! `sqlite3_os_init` / `sqlite3_os_end` symbols this object provides.
//!
//! Both files are built by the same `cc` invocation rules, so the wasi-sdk
//! clang selected through `CC_wasm32_wasip2` is used for both.

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=csrc/wasi-vfs.c");
    println!("cargo:rerun-if-env-changed=DEP_SQLITE3_INCLUDE");

    let target = env::var("TARGET").unwrap_or_default();
    if !target.starts_with("wasm32-wasi") {
        // Native builds (e.g. `cargo check` on the host for IDE support) use
        // libsqlite3-sys' own os_unix.c; nothing to add.
        println!("cargo:warning=di-framework-sqlite-component is only meaningful for wasm32-wasip2; skipping WASI VFS for {target}");
        return;
    }

    // Exported by libsqlite3-sys (`links = "sqlite3"`, `cargo:include=`) in
    // bundled mode; points at the directory holding sqlite3.h.
    let include = env::var("DEP_SQLITE3_INCLUDE")
        .expect("DEP_SQLITE3_INCLUDE not set: libsqlite3-sys must be built with the `bundled` feature");

    cc::Build::new()
        .file("csrc/wasi-vfs.c")
        .include(&include)
        // wasi-libc is musl-derived: POSIX/GNU declarations (getentropy,
        // clock_gettime, nanosleep, pread/pwrite, O_DIRECTORY) need this.
        .define("_GNU_SOURCE", None)
        .flag("-std=gnu11")
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Werror")
        .warnings(true)
        .compile("di_framework_sqlite_wasi_vfs");
}
