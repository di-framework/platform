//! Publish the pglite-encfs Wasm component built and tested by `make build`/`make smoke`.
//!
//! The publisher never builds: it validates the artifact in `dist/`
//! (checksummed, exports `wasi:filesystem/types@0.2.9`, imports only `wasi:*`)
//! and, with `PUSH=true`, pushes it and verifies it by digest.
use std::{env, error::Error, path::Path};
use wasm_component_publisher as publish;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// The interface pglite's filesystem imports are plugged into. Its version is
/// pinned by the pglite build (see `make smoke`), not by this package.
const REQUIRED_EXPORT: &str = "wasi:filesystem/types@0.2.9";

/// The movable version tag: the WIT package version, derived by `build.rs`.
const VERSION_TAG: &str = env!("ENCFS_WIT_VERSION");

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args == ["--help"] {
        println!(
            "pglite-encfs-publisher [--check]\nValidates the dist/ artifact produced by `make build`; PUSH=true publishes it.\nNever rebuilds or modifies dist/. --check never publishes."
        );
        return Ok(());
    }
    let check = args == ["--check"];
    if !args.is_empty() && !check {
        return Err("usage: pglite-encfs-publisher [--check]".into());
    }
    let push = match env::var("PUSH").as_deref() {
        Err(env::VarError::NotPresent) | Ok("") | Ok("false") | Ok("0") => false,
        Ok("true") => true,
        _ => return Err("PUSH must be true or false".into()),
    };
    let package = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("publisher has no component directory")?;
    publish::run(
        package,
        &publish::ComponentSpec {
            wasm_file: "pglite-encfs.wasm",
            wit_file: "pglite-encfs.wit",
            build_info_file: "BUILD-INFO.txt",
            required_export: REQUIRED_EXPORT,
            default_repository: "di-framework/pglite-encfs",
            report_file_name: "publish-report.json",
            log_prefix: "pglite-encfs",
            version_tag: Some(VERSION_TAG.to_owned()),
            import_prefixes: Some(&["wasi:"]),
        },
        push && !check,
    )
}

#[cfg(test)]
mod tests {
    use super::{REQUIRED_EXPORT, VERSION_TAG};

    #[test]
    fn version_tag_matches_the_wit_package_version() {
        let wit = include_str!("../wit/world.wit");
        let version = wit
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("package di-framework:pglite-encfs@"))
            .and_then(|l| l.strip_suffix(';'))
            .expect("world.wit starts with the package declaration");
        assert_eq!(VERSION_TAG, version);
    }

    #[test]
    fn required_export_is_one_the_world_exports() {
        let wit = include_str!("../wit/world.wit");
        assert!(wit.contains(&format!("export {REQUIRED_EXPORT};")));
    }
}
