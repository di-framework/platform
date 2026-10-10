//! Host-side image build/push for tenant-auth (oci-builder library).
use oci_builder::{BuildRequest, Builder, Config, LogLevel, PushRequest, StorageDriver, startup};
use std::{
    env,
    error::Error,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        process::exit(1);
    }
}

fn run() -> Result<()> {
    // Mandatory re-exec dispatch (no-op on macOS; required first on Linux).
    startup().map_err(|error| error.to_string())?;

    let args: Vec<_> = env::args().skip(1).collect();
    if args == ["--help"] {
        println!(
            "tenant-auth-image\nBuilds the local image. SMOKE_CHECK=true checks both entry points.\nPUSH=true publishes to DI_OCI_REGISTRY/DI_OCI_REPOSITORY:DI_OCI_TAG."
        );
        return Ok(());
    }
    if !args.is_empty() {
        return Err("usage: tenant-auth-image (or --help)".into());
    }

    let pkg = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = repo_root(&pkg)?;
    let policy = pkg.join("build-support/policy.json");
    // Preserve the reference branch's Git-ignore and secret exclusions.
    // oci-builder also applies Dockerfile ignore rules to this staged context.
    let context = prepare_context(&root)?;
    let dockerfile = context.join("platform/tenant-auth/Dockerfile");
    if !policy.is_file() {
        return Err(format!("missing signature policy {}", policy.display()).into());
    }
    if !dockerfile.is_file() {
        return Err(format!("missing Dockerfile {}", dockerfile.display()).into());
    }

    let registry = setting("DI_OCI_REGISTRY", "ghcr.io")?;
    let repository = setting("DI_OCI_REPOSITORY", "di-framework/tenant-auth")?;
    let revision = default_tag(&root);
    let tag = setting("DI_OCI_TAG", &revision)?;
    let local_ref = format!("localhost/{repository}:{tag}");
    let remote_ref = format!("{registry}/{repository}:{tag}");
    let push = enabled("PUSH")?;
    let smoke = enabled("SMOKE_CHECK")?;
    let credentials = if push {
        Some(registry_credentials()?.ok_or(
            "PUSH=true needs registry credentials (GHCR_USERNAME + GHCR_TOKEN or GITHUB_ACTOR + GITHUB_TOKEN)",
        )?)
    } else {
        None
    };

    eprintln!("[tenant-auth] building {local_ref}");
    let builder = Builder::open(Config {
        storage_root: Some(root.join("target/tenant-auth-oci/storage")),
        run_root: Some(root.join("target/tenant-auth-oci/run")),
        storage_driver: Some(StorageDriver::Vfs),
        signature_policy: Some(policy),
        log_level: LogLevel::Info,
        ..Config::default()
    })
    .map_err(|error| error.to_string())?;

    let outcome = (|| -> Result<()> {
        let mut request = BuildRequest::new(&dockerfile, &context).with_log(|record| {
            let _ = std::io::stderr()
                .lock()
                .write_all(record.message.as_bytes());
        });
        request.tag = Some(local_ref.clone());
        request.isolation = oci_builder::Isolation::Chroot;
        request.labels.insert(
            "org.opencontainers.image.revision".to_owned(),
            revision.clone(),
        );
        let built = builder.build(request).map_err(|error| error.to_string())?;
        eprintln!("[tenant-auth] built image_id={}", built.image_id);

        if smoke {
            smoke_check(&builder, &context, &local_ref)?;
        }

        if !push {
            eprintln!("[tenant-auth] Built {local_ref} (local storage; PUSH=true to push)");
            return Ok(());
        }

        let (username, password) = credentials.ok_or("missing registry credentials")?;
        eprintln!("[tenant-auth] pushing {local_ref} -> {remote_ref}");
        let mut push_req = PushRequest::new(&local_ref, &remote_ref).with_log(|record| {
            let _ = std::io::stderr()
                .lock()
                .write_all(record.message.as_bytes());
        });
        push_req.username = username;
        push_req.password = password;
        let info = builder.push(push_req).map_err(|error| error.to_string())?;
        let digest = info
            .digest
            .filter(|value| value.starts_with("sha256:"))
            .ok_or("oci-builder push did not return a manifest digest")?;
        let pinned = format!("{registry}/{repository}@{digest}");
        let dist = pkg.join("dist");
        fs::create_dir_all(&dist)?;
        let report = dist.join("publish-report.json");
        fs::write(
            &report,
            serde_json::to_vec_pretty(&serde_json::json!({
                "tag": remote_ref,
                "manifestDigest": digest,
                "pinned": pinned,
                "revision": revision,
            }))?,
        )?;
        eprintln!("[tenant-auth] Pushed {remote_ref}");
        eprintln!("[tenant-auth] Pinned: {pinned}");
        eprintln!("[tenant-auth] Publish report: {}", report.display());
        Ok(())
    })();

    let shutdown = builder.shutdown().map_err(|error| error.to_string());
    outcome?;
    shutdown?;
    Ok(())
}

fn setting(name: &str, default: &str) -> Result<String> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        _ => Err(format!("{name} must be a nonempty UTF-8 value").into()),
    }
}

fn enabled(name: &str) -> Result<bool> {
    match env::var(name).as_deref() {
        Err(env::VarError::NotPresent) | Ok("") | Ok("false") | Ok("0") => Ok(false),
        Ok("true") => Ok(true),
        _ => Err(format!("{name} must be true or false").into()),
    }
}

struct TempFileGuard<'a>(&'a Path);

impl<'a> Drop for TempFileGuard<'a> {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.0);
    }
}

fn smoke_check(builder: &Builder, context: &Path, image: &str) -> Result<()> {
    let dockerfile = context.join("tenant-auth-smoke.Dockerfile");
    if dockerfile.exists() {
        let _ = fs::remove_file(&dockerfile);
    }
    // Expected configuration errors establish that both bundles load imports.
    fs::write(
        &dockerfile,
        format!(
            r#"FROM {image}
RUN set -eu; \
    for entry in controller console; do \
      code=0; \
      out="$(bun "/app/${{entry}}.js" 2>&1)" || code=$?; \
      printf '%s: exit %s\n%s\n' "$entry" "$code" "$out"; \
      test "$code" -ne 0; \
      printf '%s\n' "$out" | grep -q 'is required'; \
      if printf '%s\n' "$out" | grep -qiE 'cannot find|error: import|module not found'; then exit 1; fi; \
      if test "$entry" = controller; then \
        printf '%s\n' "$out" | grep -q 'TENANT_CONTROLLER_TENANT is required'; \
      fi; \
    done
"#
        ),
    )?;
    let _cleanup = TempFileGuard(&dockerfile);
    let mut request = BuildRequest::new(&dockerfile, context).with_log(|record| {
        let _ = std::io::stderr()
            .lock()
            .write_all(record.message.as_bytes());
    });
    request.isolation = oci_builder::Isolation::Chroot;
    builder.build(request).map_err(|error| error.to_string())?;
    eprintln!("[tenant-auth] Both entry points passed the smoke check");
    Ok(())
}

fn prepare_context(root: &Path) -> Result<PathBuf> {
    let output = process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()?;
    if !output.status.success() {
        return Err("cannot enumerate image build context".into());
    }
    let context = root.join("target/tenant-auth-oci/context");
    if context.exists() {
        fs::remove_dir_all(&context)?;
    }
    fs::create_dir_all(&context)?;
    for file in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|file| !file.is_empty())
    {
        let relative = Path::new(std::str::from_utf8(file)?);
        if relative.components().any(|component| {
            let part = component.as_os_str().to_string_lossy();
            part.starts_with(".env")
                || matches!(
                    part.as_ref(),
                    "node_modules"
                        | "target"
                        | "dist"
                        | "coverage"
                        | ".git"
                        | ".claude"
                        | ".pulumi"
                        | ".tools"
                        | ".cache"
                )
        }) {
            continue;
        }
        let source = root.join(relative);
        if !source.is_file() {
            continue; // Deleted checkout files are still listed by git.
        }
        let destination = context.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(context)
}

fn first_nonempty(names: &[&str]) -> String {
    names
        .iter()
        .filter_map(|name| env::var(name).ok())
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn registry_credentials() -> Result<Option<(String, String)>> {
    let username = first_nonempty(&["DI_OCI_USERNAME", "GHCR_USERNAME", "GITHUB_ACTOR"]);
    let password = first_nonempty(&["DI_OCI_PASSWORD", "GHCR_TOKEN", "GITHUB_TOKEN"]);
    match (username.is_empty(), password.is_empty()) {
        (true, true) => Ok(None),
        (false, false) => Ok(Some((username, password))),
        (true, false) => {
            Err("registry password is set but no username (GHCR_USERNAME/GITHUB_ACTOR)".into())
        }
        (false, true) => {
            Err("registry username is set but no password (GHCR_TOKEN/GITHUB_TOKEN)".into())
        }
    }
}

fn repo_root(manifest: &Path) -> Result<PathBuf> {
    let output = process::Command::new("git")
        .args([
            "-C",
            manifest.to_str().ok_or("non-UTF-8 CARGO_MANIFEST_DIR")?,
        ])
        .args(["rev-parse", "--show-toplevel"])
        .output()?;
    if output.status.success() {
        let root = String::from_utf8(output.stdout)?.trim().to_owned();
        if !root.is_empty() {
            return Ok(PathBuf::from(root));
        }
    }
    Err("cannot locate repository root; run from a git checkout".into())
}

fn default_tag(repo_root: &Path) -> String {
    process::Command::new("git")
        .args(["-C"])
        .arg(repo_root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "local".to_owned())
}
