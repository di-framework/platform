//! Compile-time inputs for the image tool; image operations run in main.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build-support/main.rs");
}
