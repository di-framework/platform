//! Validate and publish Wasm components using the reference branch's wash flow.
//! Invoked explicitly by the publisher executable, never during compilation.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env,
    error::Error,
    fs,
    io::{Read, Write},
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// Per-component inputs. Everything else (registry, tag, credentials) comes
/// from the `DI_OCI_*` / `GHCR_*` environment, shared by all components.
pub struct ComponentSpec {
    /// Wasm artifact in `dist/`, e.g. `di-framework-oci-registry.wasm`.
    pub wasm_file: &'static str,
    /// WIT recovered from the component, e.g. `di-framework-oci-registry.wit`.
    pub wit_file: &'static str,
    /// Build metadata in `dist/`, e.g. `BUILD-INFO.txt`.
    pub build_info_file: &'static str,
    /// WIT export the built component must have, e.g. `wasi:http/handler@0.3.0`.
    pub required_export: &'static str,
    /// Used when `DI_OCI_REPOSITORY` is unset, e.g. `di-framework/oci-registry`.
    pub default_repository: &'static str,
    /// Publish report file name under the component dist directory.
    pub report_file_name: &'static str,
}

fn setting(name: &str, default: &str) -> Result<String> {
    match env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        Err(env::VarError::NotPresent) => Ok(default.to_owned()),
        _ => Err(format!("{name} must be a nonempty UTF-8 value").into()),
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn first_nonempty(names: &[&str]) -> String {
    names
        .iter()
        .filter_map(|name| env::var(name).ok())
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// (username, password) for registries that need it (GHCR), or `None` for
/// anonymous access to plain-HTTP local registries.
///
/// Username: `DI_OCI_USERNAME` > `GHCR_USERNAME` > `GITHUB_ACTOR`.
/// Password: `DI_OCI_PASSWORD` > `GHCR_TOKEN` > `GITHUB_TOKEN`.
fn registry_credentials() -> Result<Option<(String, String)>> {
    let username = first_nonempty(&["DI_OCI_USERNAME", "GHCR_USERNAME", "GITHUB_ACTOR"]);
    let password = first_nonempty(&["DI_OCI_PASSWORD", "GHCR_TOKEN", "GITHUB_TOKEN"]);
    match (username.is_empty(), password.is_empty()) {
        (true, true) => Ok(None),
        (false, false) => Ok(Some((username, password))),
        (true, false) => Err(
            "registry password is set (DI_OCI_PASSWORD/GHCR_TOKEN) but no username \
             (DI_OCI_USERNAME/GHCR_USERNAME/GITHUB_ACTOR) was provided"
                .into(),
        ),
        (false, true) => Err(
            "registry username is set but no password (DI_OCI_PASSWORD/GHCR_TOKEN) was provided"
                .into(),
        ),
    }
}

fn registry_host(registry: &str) -> &str {
    let without_port = if let Some(stripped) = registry.strip_prefix('[') {
        // Bracketed IPv6: host ends at ']'.
        match stripped.find(']') {
            Some(end) => &registry[..end + 1],
            None => registry,
        }
    } else {
        match registry.rfind(':') {
            Some(colon)
                if registry[colon + 1..].chars().all(|c| c.is_ascii_digit())
                    && !registry[colon + 1..].is_empty() =>
            {
                &registry[..colon]
            }
            _ => registry,
        }
    };
    without_port
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(without_port)
}

fn is_plain_http_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host == "::1"
        || host == "host.containers.internal"
        || host.starts_with("127.")
        || host.starts_with("10.")
        || host.starts_with("192.168.")
        || (host.starts_with("172.")
            && host
                .split('.')
                .nth(1)
                .and_then(|octet| octet.parse::<u8>().ok())
                .is_some_and(|octet| (16..=31).contains(&octet)))
        || host.ends_with(".svc")
        || host.ends_with(".svc.cluster.local")
}

/// Whether `wash` gets `--insecure`. `DI_OCI_PROTOCOL=http|https|auto`
/// (default `auto`): plain HTTP for loopback and cluster-local registries,
/// HTTPS everywhere else (GHCR).
fn use_insecure(registry: &str) -> Result<bool> {
    match first_nonempty(&["DI_OCI_PROTOCOL"])
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "auto" => Ok(is_plain_http_host(registry_host(registry))),
        "http" => Ok(true),
        "https" => Ok(false),
        other => Err(format!("DI_OCI_PROTOCOL must be http, https, or auto, got {other:?}").into()),
    }
}

fn valid_name_part(part: &str) -> bool {
    let mut chars = part.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && part.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_' || c == '-'
        })
}

/// Fail fast on malformed references before invoking `wash`.
fn validate_reference(registry: &str, repository: &str, tag: &str) -> Result<()> {
    if registry.is_empty()
        || registry.contains("://")
        || registry.contains('/')
        || registry.contains('@')
        || registry.chars().any(char::is_whitespace)
    {
        return Err("use a registry HOST[:PORT] without a scheme or path".into());
    }
    if !repository.split('/').all(valid_name_part) {
        return Err(
            "use a lowercase repository without a tag or scheme, e.g. di-framework/oci-registry"
                .into(),
        );
    }
    let mut chars = tag.chars();
    let head_ok = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric() || c == '_');
    let tail_ok = tag
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-');
    if !head_ok || !tail_ok || tag.len() > 128 {
        return Err("use a tag of the form [\\w][\\w.-]{0,127}".into());
    }
    Ok(())
}

fn tail(text: &str, max: usize) -> &str {
    let start = text.len().saturating_sub(max);
    match text.get(start..) {
        Some(slice) => slice,
        None => text,
    }
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = match chunk.first() {
            Some(&b) => b,
            None => continue,
        };
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let idx0 = (b0 >> 2) as usize;
        let idx1 = (((b0 & 0x03) << 4) | (b1 >> 4)) as usize;
        if let Some(&c0) = TABLE.get(idx0) {
            out.push(c0 as char);
        }
        if let Some(&c1) = TABLE.get(idx1) {
            out.push(c1 as char);
        }
        if chunk.len() > 1 {
            let idx2 = (((b1 & 0x0f) << 2) | (b2 >> 6)) as usize;
            if let Some(&c2) = TABLE.get(idx2) {
                out.push(c2 as char);
            }
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            let idx3 = (b2 & 0x3f) as usize;
            if let Some(&c3) = TABLE.get(idx3) {
                out.push(c3 as char);
            }
        } else {
            out.push('=');
        }
    }
    out
}

/// Short-lived docker-style configuration directory with 0700 dir and 0600 file
/// permissions, feeding credentials via `DOCKER_CONFIG` so passwords are not
/// exposed in argv (`/proc/<pid>/cmdline`, `ps`, or process error output).
struct DockerConfigDir {
    path: std::path::PathBuf,
}

impl DockerConfigDir {
    fn new(registries: &[&str], username: &str, password: &str) -> Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = env::temp_dir().join(format!("wash-docker-{}-{nanos}", std::process::id()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&path)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&path)?;

        let auth = base64_encode(format!("{username}:{password}").as_bytes());
        let mut auths = serde_json::Map::new();
        for &reg in registries {
            for key in [
                reg.to_owned(),
                format!("https://{reg}"),
                format!("https://{reg}/v2/"),
                registry_host(reg).to_owned(),
                format!("https://{}", registry_host(reg)),
            ] {
                auths.insert(key, serde_json::json!({ "auth": auth }));
            }
        }
        let config_file = path.join("config.json");
        let contents = serde_json::to_vec_pretty(&serde_json::json!({ "auths": auths }))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&config_file)?;
            file.write_all(&contents)?;
        }
        #[cfg(not(unix))]
        fs::write(&config_file, contents)?;
        Ok(Self { path })
    }
}

impl Drop for DockerConfigDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Guard to remove a temporary file on all paths (success, error, or panic).
struct TempFileGuard(std::path::PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Run `wash` with a deadline; kill it if it overruns.
fn run_wash(args: &[String], envs: &[(&str, &Path)], timeout: Duration) -> Result<Output> {
    let mut command = Command::new("wash");
    command.args(args);
    for (key, val) in envs {
        command.env(key, val);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "wash not found on PATH; install wash 2.5.2 (https://wasmcloud.com/docs/installation)"
                    .to_owned()
            } else {
                format!("failed to run wash: {error}")
            }
        })?;
    // Drain both pipes while waiting: a full pipe must not stall the child.
    let stdout = child.stdout.take().ok_or("missing wash stdout")?;
    let stderr = child.stderr.take().ok_or("missing wash stderr")?;
    let read = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes).map(|_| bytes)
        })
    };
    let stdout = read(Box::new(stdout));
    let stderr = read(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("failed to wait on wash: {error}"))?
        {
            Some(status) => {
                return Ok(Output {
                    status,
                    stdout: stdout.join().map_err(|_| "wash stdout reader failed")??,
                    stderr: stderr.join().map_err(|_| "wash stderr reader failed")??,
                });
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout.join();
                let _ = stderr.join();
                return Err(format!(
                    "wash oci {} timed out after {} seconds",
                    args.first().map(String::as_str).unwrap_or_default(),
                    timeout.as_secs()
                )
                .into());
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn check_output(output: &Output, what: &str) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "wash {what} failed ({}): {}",
        output.status,
        tail(&String::from_utf8_lossy(&output.stderr), 2000)
    )
    .into())
}

pub fn run(package: &Path, spec: &ComponentSpec, push_enabled: bool) -> Result<()> {
    let dist = package.join(env::var_os("DI_OCI_DIST_DIR").unwrap_or_else(|| "dist".into()));
    let sums = fs::read_to_string(dist.join("SHA256SUMS"))
        .map_err(|error| format!("{}: {error}; run make build first", dist.display()))?;
    let read_checked = |name: &str| checked_bytes(&dist, name, &sums);
    let wasm = read_checked(spec.wasm_file)?;
    let wit = String::from_utf8(read_checked(spec.wit_file)?)?;
    // BUILD-INFO.txt is checksum-verified here; its timestamp now lives in
    // the config `wash` generates, so only its presence matters here.
    let _ = read_checked(spec.build_info_file)?;
    let (_, exports) = world_items(&wit)?;
    if !exports.iter().any(|item| item == spec.required_export) {
        return Err(format!("built WIT lacks {}", spec.required_export).into());
    }
    let wasm_digest = digest(&wasm);
    if !push_enabled {
        eprintln!("[oci-registry] Validated {wasm_digest}; PUSH=true to publish");
        return Ok(());
    }
    let short_hash: String = format!("{:x}", Sha256::digest(&wasm))
        .chars()
        .take(12)
        .collect();
    let tag = setting("DI_OCI_TAG", &format!("sha256-{short_hash}"))?;
    let registry = setting("DI_OCI_REGISTRY", "127.0.0.1:25001")?;
    let repository = setting("DI_OCI_REPOSITORY", spec.default_repository)?;
    let cluster_registry = setting(
        "DI_OCI_CLUSTER_REGISTRY",
        "examples-registry.wasmcloud.svc.cluster.local:5000",
    )?;
    validate_reference(&registry, &repository, &tag)?;
    validate_reference(&cluster_registry, &repository, &tag)?;
    let destination = format!("{registry}/{repository}:{tag}");
    let insecure = use_insecure(&registry)?;
    let credentials = registry_credentials()?;
    match &credentials {
        None => eprintln!("[oci-registry] Registry auth: anonymous"),
        Some((username, _)) => eprintln!("[oci-registry] Registry auth: basic user {username}"),
    }

    let docker_config = match &credentials {
        Some((username, password)) => Some(DockerConfigDir::new(
            &[&registry, &cluster_registry],
            username,
            password,
        )?),
        None => None,
    };
    let wash_envs: Vec<(&str, &Path)> = match &docker_config {
        Some(config) => vec![("DOCKER_CONFIG", &config.path)],
        None => vec![],
    };

    let mut push: Vec<String> = vec![
        "oci".to_owned(),
        "push".to_owned(),
        "--output".to_owned(),
        "json".to_owned(),
        "--non-interactive".to_owned(),
    ];
    if insecure {
        push.push("--insecure".to_owned());
    }
    push.push(destination.clone());
    push.push(dist.join(spec.wasm_file).to_string_lossy().into_owned());
    let output = run_wash(&push, &wash_envs, Duration::from_secs(300))?;
    check_output(&output, "oci push")?;
    let manifest_digest = push_digest(&output.stdout)?;
    let local = format!("{registry}/{repository}@{manifest_digest}");
    let cluster = format!("{cluster_registry}/{repository}@{manifest_digest}");

    // Verify the immutable manifest returned by the push, not a movable tag.
    // Download to a temporary path outside dist/ so failed or unverified artifacts
    // never pollute the build output, and clean up on all paths via drop guard.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pulled = env::temp_dir().join(format!("wash-pulled-{}-{nanos}.wasm", std::process::id()));
    if pulled.exists() {
        let _ = fs::remove_file(&pulled);
    }
    let _pulled_guard = TempFileGuard(pulled.clone());
    let mut pull: Vec<String> = vec![
        "oci".to_owned(),
        "pull".to_owned(),
        "--non-interactive".to_owned(),
    ];
    if insecure {
        pull.push("--insecure".to_owned());
    }
    pull.push(local.clone());
    pull.push(pulled.to_string_lossy().into_owned());
    let output = run_wash(&pull, &wash_envs, Duration::from_secs(300))?;
    check_output(&output, "oci pull")?;
    let round_tripped = fs::read(&pulled)?;
    if round_tripped != wasm {
        return Err("pulled Wasm differs from the local build".into());
    }

    drop(_pulled_guard);
    let report = dist.join(spec.report_file_name);
    fs::write(
        &report,
        serde_json::to_vec_pretty(&serde_json::json!({
            "tag": destination, "wasmDigest": wasm_digest,
            "manifestDigest": manifest_digest, "localComponent": local, "clusterComponent": cluster,
        }))?,
    )?;
    eprintln!("[oci-registry] Verified Wasm: {wasm_digest}");
    eprintln!("[oci-registry] Pushed tag: {destination}");
    eprintln!("[oci-registry] Local component: {local}");
    eprintln!("[oci-registry] Cluster component: {cluster}");
    eprintln!("[oci-registry] Publish report: {}", report.display());
    Ok(())
}

/// `wash oci push --output json` prints `{"success":true,"data":{"digest":"sha256:…"}}`.
fn push_digest(stdout: &[u8]) -> Result<String> {
    let parsed: Value = serde_json::from_slice(stdout).map_err(|_| {
        format!(
            "cannot parse wash push output: {}",
            tail(&String::from_utf8_lossy(stdout), 1000)
        )
    })?;
    if parsed.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(format!(
            "wash push reported failure: {}",
            tail(&String::from_utf8_lossy(stdout), 1000)
        )
        .into());
    }
    match parsed
        .get("data")
        .and_then(|data| data.get("digest"))
        .and_then(Value::as_str)
    {
        Some(digest) if is_digest(digest) => Ok(digest.to_owned()),
        _ => Err(format!(
            "wash push returned no digest: {}",
            tail(&String::from_utf8_lossy(stdout), 1000)
        )
        .into()),
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].chars().all(|c| c.is_ascii_hexdigit())
}

fn checked_bytes(dist: &Path, name: &str, sums: &str) -> Result<Vec<u8>> {
    let bytes = fs::read(dist.join(name))?;
    let expected = format!("{:x}  {name}", Sha256::digest(&bytes));
    if !sums.lines().any(|line| line == expected) {
        return Err(format!("build checksum mismatch for {name}; run make build").into());
    }
    Ok(bytes)
}

// Read the first world's top-level entries, as in the publishing workflow.
// Dependency packages printed afterward can contain additional worlds.
fn world_items(wit: &str) -> Result<(Vec<String>, Vec<String>)> {
    let (mut imports, mut exports) = (Vec::new(), Vec::new());
    let (mut inside, mut depth) = (false, 0_i64);
    for line in wit.lines().map(str::trim) {
        if !inside && line.starts_with("world ") && line.ends_with('{') {
            inside = true;
        }
        if !inside {
            continue;
        }
        if depth == 1 {
            for (kind, items) in [("import ", &mut imports), ("export ", &mut exports)] {
                if let Some(item) = line
                    .strip_prefix(kind)
                    .and_then(|item| item.strip_suffix(';'))
                {
                    if item.contains(char::is_whitespace) || item.contains('{') {
                        return Err("expected named top-level WIT interfaces".into());
                    }
                    items.push(item.to_owned());
                }
            }
        }
        for ch in line.chars() {
            depth += match ch {
                '{' => 1,
                '}' => -1,
                _ => 0,
            };
        }
        if depth == 0 {
            return Ok((imports, exports));
        }
    }
    Err("built WIT lacks a complete root world".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_modified_or_unlisted_artifacts() {
        let dir = env::temp_dir().join(format!(
            "oci-publish-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("component.wasm"), b"original").unwrap();
        let sums = format!("{:x}  component.wasm\n", Sha256::digest(b"original"));
        assert_eq!(
            checked_bytes(&dir, "component.wasm", &sums).unwrap(),
            b"original"
        );
        assert!(checked_bytes(&dir, "component.wasm", "").is_err());
        fs::write(dir.join("component.wasm"), b"modified").unwrap();
        assert!(checked_bytes(&dir, "component.wasm", &sums).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_unsuccessful_or_malformed_push_results() {
        for value in [
            br#"{"success":false,"data":{"digest":"sha256:abc"}}"#.as_slice(),
            br#"{"success":true,"data":{"digest":"sha256:abc"}}"#.as_slice(),
            br#"{"success":true}"#.as_slice(),
            b"not json".as_slice(),
        ] {
            assert!(push_digest(value).is_err());
        }
        let digest = format!("sha256:{}", "a".repeat(64));
        let output =
            serde_json::to_vec(&serde_json::json!({"success":true,"data":{"digest":digest}}))
                .unwrap();
        assert_eq!(push_digest(&output).unwrap(), digest);
    }

    #[test]
    fn dependency_world_does_not_satisfy_root_export() {
        let wit = "world root {\n  import wasi:http/client@0.3.0;\n}\nworld dependency {\n  export wasi:http/handler@0.3.0;\n}\n";
        let (imports, exports) = world_items(wit).unwrap();
        assert_eq!(imports, ["wasi:http/client@0.3.0"]);
        assert!(exports.is_empty());
        assert!(world_items("world truncated {\n").is_err());
    }

    #[test]
    fn validates_registry_references_before_publication() {
        assert!(validate_reference("ghcr.io", "di-framework/oci-registry", "v1").is_ok());
        assert!(validate_reference("https://ghcr.io", "repo", "v1").is_err());
        assert!(validate_reference("ghcr.io", "repo/../escape", "v1").is_err());
        assert!(validate_reference("ghcr.io", "repo", "-invalid").is_err());
    }

    #[test]
    fn base64_roundtrip_vectors() {
        for (input, expected) in [
            (b"".as_slice(), ""),
            (b"f".as_slice(), "Zg=="),
            (b"fo".as_slice(), "Zm8="),
            (b"foo".as_slice(), "Zm9v"),
            (b"foob".as_slice(), "Zm9vYg=="),
            (b"fooba".as_slice(), "Zm9vYmE="),
            (b"foobar".as_slice(), "Zm9vYmFy"),
            (b"user:pass".as_slice(), "dXNlcjpwYXNz"),
        ] {
            assert_eq!(base64_encode(input), expected);
        }
    }

    #[test]
    fn docker_config_dir_lifecycle() {
        let path = {
            let config =
                DockerConfigDir::new(&["ghcr.io", "127.0.0.1:5000"], "alice", "secret").unwrap();
            assert!(config.path.is_dir());
            let content = fs::read_to_string(config.path.join("config.json")).unwrap();
            assert!(content.contains("ghcr.io"));
            assert!(content.contains("127.0.0.1:5000"));
            assert!(content.contains(&base64_encode(b"alice:secret")));
            config.path.clone()
        };
        // Verify drop cleaned up the directory.
        assert!(!path.exists());
    }

    #[test]
    fn temp_file_guard_removes_on_drop() {
        let temp_path =
            env::temp_dir().join(format!("test-temp-file-guard-{}", std::process::id()));
        fs::write(&temp_path, b"temp").unwrap();
        assert!(temp_path.is_file());
        {
            let _guard = TempFileGuard(temp_path.clone());
        }
        assert!(!temp_path.exists());
    }
}
