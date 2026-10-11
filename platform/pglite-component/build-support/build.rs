//! Derive the WIT package version from `wit/world.wit` so the publisher's
//! required export can never drift from the interface the component ships.
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
                .strip_prefix("package di-framework:pglite@")
                .and_then(|rest| rest.strip_suffix(';'))
        })
        .expect("wit/world.wit must start with `package di-framework:pglite@<version>;`");
    println!("cargo:rustc-env=PGLITE_WIT_VERSION={version}");
}
