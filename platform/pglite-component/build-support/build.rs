//! Compile-time inputs for the publisher; publication is an explicit run.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=main.rs");
    println!("cargo:rerun-if-changed=publish.rs");
}
