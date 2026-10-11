//! Publish the pglite Wasm component built and tested by `make build`/`make smoke`.
//!
//! The publisher never builds: it validates the composed artifact in `dist/`
//! (checksummed, exports `di-framework:pglite/database@<wit version>`, imports
//! only `wasi:*`) and, with `PUSH=true`, pushes it and verifies it by digest.
use std::{env, error::Error, path::Path};
use wasm_component_publisher as publish;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// Derived from `wit/world.wit` by `build.rs`, so a WIT bump moves the required
/// export and the version tag together.
const REQUIRED_EXPORT: &str = concat!("di-framework:pglite/database@", env!("PGLITE_WIT_VERSION"));

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
            "pglite-component-publisher [--check]\nValidates the dist/ artifact produced by `make build`; PUSH=true publishes it.\nNever rebuilds or modifies dist/. --check never publishes."
        );
        return Ok(());
    }
    let check = args == ["--check"];
    if !args.is_empty() && !check {
        return Err("usage: pglite-component-publisher [--check]".into());
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
            wasm_file: "di-framework-pglite.wasm",
            wit_file: "di-framework-pglite.wit",
            build_info_file: "BUILD-INFO.txt",
            required_export: REQUIRED_EXPORT,
            default_repository: "di-framework/pglite-component",
            report_file_name: "publish-report.json",
            log_prefix: "pglite",
            version_tag: REQUIRED_EXPORT.split_once('@').map(|(_, v)| v.to_owned()),
            import_prefixes: Some(&["wasi:"]),
        },
        push && !check,
    )
}

#[cfg(test)]
mod tests {
    use super::REQUIRED_EXPORT;

    #[test]
    fn required_export_matches_the_wit_package_version() {
        let wit = include_str!("../wit/world.wit");
        let version = wit
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("package di-framework:pglite@"))
            .and_then(|l| l.strip_suffix(';'))
            .expect("world.wit starts with the package declaration");
        assert_eq!(
            REQUIRED_EXPORT,
            format!("di-framework:pglite/database@{version}")
        );
    }
}
