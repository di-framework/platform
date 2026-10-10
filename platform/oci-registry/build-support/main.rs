//! Build and optionally publish the OCI registry Wasm component.
use sha2::{Digest, Sha256};
use std::{env, error::Error, fs, path::Path, process::Command};

mod publish;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

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
            "oci-registry-publisher [--check]\nBuilds and validates the component. PUSH=true publishes after validation.\n--check validates existing dist artifacts without building or publishing."
        );
        return Ok(());
    }
    let check = args == ["--check"];
    if !args.is_empty() && !check {
        return Err("usage: oci-registry-publisher [--check]".into());
    }
    let push = match env::var("PUSH").as_deref() {
        Err(env::VarError::NotPresent) | Ok("") | Ok("false") | Ok("0") => false,
        Ok("true") => true,
        _ => return Err("PUSH must be true or false".into()),
    };
    let package = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("publisher has no component directory")?;
    let dist = package.join(env::var_os("DI_OCI_DIST_DIR").unwrap_or_else(|| "dist".into()));
    if !check {
        build(package, &dist)?;
    }
    publish::run(
        package,
        &publish::ComponentSpec {
            wasm_file: "di-framework-oci-registry.wasm",
            wit_file: "di-framework-oci-registry.wit",
            build_info_file: "BUILD-INFO.txt",
            required_export: "wasi:http/handler@0.3.0",
            default_repository: "di-framework/oci-registry",
            report_file_name: "publish-report.json",
        },
        push && !check,
    )
}

fn build(package: &Path, dist: &Path) -> Result<()> {
    let target = "wasm32-wasip2";
    let target_dir = package.join("target");
    // Keep the component's workspace, toolchain, and target directory separate
    // from the host tool to avoid Cargo lock contention.
    checked(
        rust_tool("cargo", package)?
            .env("CARGO_TARGET_DIR", &target_dir)
            .args([
                "build",
                "--locked",
                "--release",
                "--lib",
                "--target",
                target,
            ]),
    )?;
    let wasm = target_dir.join(target).join("release/oci_registry.wasm");
    checked(
        Command::new("wasm-tools")
            .args(["validate", "--features", "all"])
            .arg(&wasm),
    )?;
    let wit = capture(
        Command::new("wasm-tools")
            .args(["component", "wit"])
            .arg(&wasm),
    )?;
    let text = std::str::from_utf8(&wit)?;
    for required in [
        "export wasi:http/handler@0.3.0",
        "import wasi:http/client@0.3.0",
        "import wasmcloud:blobstore/container@0.1.0",
    ] {
        if !text.contains(required) {
            return Err(format!("built WIT lacks {required}").into());
        }
    }
    fs::create_dir_all(dist)?;
    fs::copy(wasm, dist.join("di-framework-oci-registry.wasm"))?;
    fs::write(dist.join("di-framework-oci-registry.wit"), wit)?;
    let rust = capture(rust_tool("rustc", package)?.arg("--version"))?;
    let tools = capture(Command::new("wasm-tools").arg("--version"))?;
    fs::write(
        dist.join("BUILD-INFO.txt"),
        format!(
            "component: di-framework tenant OCI registry\nupstream: wasmCloud/wasmCloud @ ee52f49e88e1f9fe4cf001bd232e0bbc6b52bcb3\nprofile: release\ntarget: {target}\nrustc: {}\nwasm-tools: {}\n",
            String::from_utf8_lossy(&rust).trim(),
            String::from_utf8_lossy(&tools).trim()
        ),
    )?;
    let mut sums = String::new();
    for name in [
        "di-framework-oci-registry.wasm",
        "di-framework-oci-registry.wit",
        "BUILD-INFO.txt",
    ] {
        sums.push_str(&format!(
            "{:x}  {name}\n",
            Sha256::digest(fs::read(dist.join(name))?)
        ));
    }
    fs::write(dist.join("SHA256SUMS"), sums)?;
    eprintln!("[oci-registry] Built {}", dist.display());
    Ok(())
}

fn checked(command: &mut Command) -> Result<()> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!(
            "{} failed: {status}",
            command.get_program().to_string_lossy()
        )
        .into());
    }
    Ok(())
}

// Match scripts/build.sh: rustup proxies must precede standalone toolchains so
// rust-toolchain.toml and its installed wasm target are actually used.
fn rust_tool(name: &str, package: &Path) -> Result<Command> {
    let mut command = Command::new(name);
    command.current_dir(package);
    let cargo_home = env::var_os("CARGO_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| Path::new(&home).join(".cargo")));
    if let Some(bin) = cargo_home
        .map(|home| home.join("bin"))
        .filter(|bin| bin.join(name).is_file())
    {
        command = Command::new(bin.join(name));
        command.current_dir(package);
        let mut paths = vec![bin];
        paths.extend(env::split_paths(&env::var_os("PATH").unwrap_or_default()));
        command.env("PATH", env::join_paths(paths)?);
    }
    Ok(command)
}

fn capture(command: &mut Command) -> Result<Vec<u8>> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "{} failed: {}",
            command.get_program().to_string_lossy(),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(output.stdout)
}
