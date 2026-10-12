//! Derive the version tag from `wit/world.wit`, so the published tag can
//! never drift from the package version the component declares.
use std::{env, fs, path::Path};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=main.rs");
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let world = Path::new(&manifest).join("../wit/world.wit");
    println!("cargo:rerun-if-changed={}", world.display());
    let wit = fs::read_to_string(&world).unwrap_or_else(|e| panic!("{}: {e}", world.display()));
    let version = wit
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("package di-framework:pglite-encfs@")
                .and_then(|rest| rest.strip_suffix(';'))
        })
        .expect("wit/world.wit must start with `package di-framework:pglite-encfs@<version>;`");
    println!("cargo:rustc-env=ENCFS_WIT_VERSION={version}");
}
