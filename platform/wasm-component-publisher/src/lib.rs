//! Validate and publish Wasm components with `wash`, shared by every component
//! publisher in this workspace. Invoked explicitly by a publisher executable,
//! never during compilation.
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
    /// Log prefix, e.g. `oci-registry`, printed as `[oci-registry] ...`.
    pub log_prefix: &'static str,
    /// Extra (human-friendly) tag pushed next to `DI_OCI_TAG`, e.g. the WIT
    /// package version `0.2.0`. Tags are movable; only digests are immutable.
    pub version_tag: Option<String>,
    /// When set, every top-level world import must start with one of these
    /// prefixes (e.g. `wasi:`), so an unresolved plug cannot be published.
    pub import_prefixes: Option<&'static [&'static str]>,
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
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
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
    run_tool("wash", args, envs, timeout)
}

/// Run an external registry tool (`wash`, `oras`) with a deadline.
fn run_tool(
    program: &str,
    args: &[String],
    envs: &[(&str, &Path)],
    timeout: Duration,
) -> Result<Output> {
    let mut command = Command::new(program);
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
                format!("{program} not found on PATH (wash 2.5.2 and oras are required)")
            } else {
                format!("failed to run {program}: {error}")
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
            .map_err(|error| format!("failed to wait on {program}: {error}"))?
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
                    "{program} {} timed out after {} seconds",
                    args.first().map(String::as_str).unwrap_or_default(),
                    timeout.as_secs()
                )
                .into());
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

/// `oras tag <repo>@<digest> <tag>...`: point `tags` at an existing manifest.
fn tag_args(insecure: bool, repo_ref: &str, digest: &str, tags: &[String]) -> Vec<String> {
    let mut args = vec!["tag".to_owned()];
    if insecure {
        args.push("--plain-http".to_owned());
    }
    args.push(format!("{repo_ref}@{digest}"));
    args.extend(tags.iter().cloned());
    args
}

/// The manifest digest a tag currently resolves to (`oras resolve`).
fn resolve_tag(
    repo_ref: &str,
    tag: &str,
    insecure: bool,
    envs: &[(&str, &Path)],
) -> Result<String> {
    let mut args = vec!["resolve".to_owned()];
    if insecure {
        args.push("--plain-http".to_owned());
    }
    args.push(format!("{repo_ref}:{tag}"));
    let output = run_tool("oras", &args, envs, Duration::from_secs(120))?;
    check_tool_output(&output, "oras resolve")?;
    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !is_digest(&resolved) {
        return Err(format!("oras resolve returned no digest: {}", tail(&resolved, 200)).into());
    }
    Ok(resolved)
}

fn check_tool_output(output: &Output, what: &str) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    Err(failure_message(what, output, &secret_values()).into())
}

fn check_output(output: &Output, what: &str) -> Result<()> {
    check_tool_output(output, &format!("wash {what}"))
}

/// Registry secrets that must never reach an error message: the password or
/// token from the environment, and the base64 `user:password` auth written
/// to the `DOCKER_CONFIG` file. Credentials never go in argv or the tool env.
fn secret_values() -> Vec<String> {
    let mut secrets: Vec<String> = ["DI_OCI_PASSWORD", "GHCR_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .filter_map(|name| env::var(name).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    if let Ok(Some((username, password))) = registry_credentials() {
        secrets.push(base64_encode(format!("{username}:{password}").as_bytes()));
    }
    secrets
}

fn redact(text: &str, secrets: &[String]) -> String {
    let mut secrets: Vec<&str> = secrets
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    // Longest first, so a secret that contains another is masked whole.
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets.into_iter().fold(text.to_owned(), |text, secret| {
        text.replace(secret, "[REDACTED]")
    })
}

/// `<what> failed (<status>): stdout: ...; stderr: ...`, each stream trimmed,
/// redacted, then cut to its last 2000 bytes. `wash --output json` reports
/// its failures on stdout and can leave stderr empty.
fn failure_message(what: &str, output: &Output, secrets: &[String]) -> String {
    let streams: Vec<String> = [("stdout", &output.stdout), ("stderr", &output.stderr)]
        .into_iter()
        .filter_map(|(name, bytes)| {
            let text = redact(String::from_utf8_lossy(bytes).trim(), secrets);
            (!text.is_empty()).then(|| format!("{name}: {}", tail(&text, 2000)))
        })
        .collect();
    let detail = if streams.is_empty() {
        "no output on stdout or stderr".to_owned()
    } else {
        streams.join("; ")
    };
    format!("{what} failed ({}): {detail}", output.status)
}

/// Validate `dist/` and, when `push_enabled`, push and verify it.
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
    let (imports, exports) = world_items(&wit)?;
    check_imports(&imports, spec.import_prefixes)?;
    if !exports.iter().any(|item| item == spec.required_export) {
        return Err(format!("built WIT lacks {}", spec.required_export).into());
    }
    let wasm_digest = digest(&wasm);
    let log = spec.log_prefix;
    if !push_enabled {
        eprintln!("[{log}] Validated {wasm_digest}; PUSH=true to publish");
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
    let insecure = use_insecure(&registry)?;
    let credentials = registry_credentials()?;
    match &credentials {
        None => eprintln!("[{log}] Registry auth: anonymous"),
        Some((username, _)) => eprintln!("[{log}] Registry auth: basic user {username}"),
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

    let mut tags = vec![tag.clone()];
    if let Some(version) = &spec.version_tag
        && *version != tag
    {
        validate_reference(&registry, &repository, version)?;
        tags.push(version.clone());
    }
    let wasm_path = dist.join(spec.wasm_file);
    let repo_ref = format!("{registry}/{repository}");
    let destination = format!("{repo_ref}:{tag}");
    // One push, one manifest digest. Extra tags are pointed at that same
    // manifest (a second `wash oci push` would create a new manifest because
    // wash stamps a creation time into the config).
    let manifest_digest = push_and_verify(
        &destination,
        &repo_ref,
        &wasm_path,
        &wasm,
        insecure,
        &wash_envs,
    )?;
    eprintln!("[{log}] Pushed tag: {destination} -> {manifest_digest}");
    let extra_tags = &tags[1..];
    if !extra_tags.is_empty() {
        let args = tag_args(insecure, &repo_ref, &manifest_digest, extra_tags);
        let output = run_tool("oras", &args, &wash_envs, Duration::from_secs(120))?;
        check_tool_output(&output, "oras tag")?;
        for extra in extra_tags {
            let resolved = resolve_tag(&repo_ref, extra, insecure, &wash_envs)?;
            if resolved != manifest_digest {
                return Err(format!(
                    "tag {extra} resolves to {resolved}, expected {manifest_digest}"
                )
                .into());
            }
            eprintln!("[{log}] Tagged {repo_ref}:{extra} -> {manifest_digest}");
        }
    }
    let local = format!("{repo_ref}@{manifest_digest}");
    let cluster = format!("{cluster_registry}/{repository}@{manifest_digest}");
    let report = dist.join(spec.report_file_name);
    let tag_digests: Vec<Value> = tags
        .iter()
        .map(|tag| serde_json::json!({ "tag": format!("{repo_ref}:{tag}"), "manifestDigest": manifest_digest }))
        .collect();
    fs::write(
        &report,
        serde_json::to_vec_pretty(&serde_json::json!({
            "tag": destination, "tags": tag_digests, "wasmDigest": wasm_digest,
            "manifestDigest": manifest_digest, "localComponent": local, "clusterComponent": cluster,
        }))?,
    )?;
    eprintln!("[{log}] Verified Wasm: {wasm_digest}");
    eprintln!("[{log}] Local component: {local}");
    eprintln!("[{log}] Cluster component: {cluster}");
    eprintln!("[{log}] Publish report: {}", report.display());
    Ok(())
}

/// Push `wasm_path` to `destination`, then pull it back by the manifest digest
/// that `wash` returned (not by the movable tag) and compare the bytes.
fn push_and_verify(
    destination: &str,
    repo_ref: &str,
    wasm_path: &Path,
    wasm: &[u8],
    insecure: bool,
    wash_envs: &[(&str, &Path)],
) -> Result<String> {
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
    push.push(destination.to_owned());
    push.push(wasm_path.to_string_lossy().into_owned());
    let output = run_wash(&push, wash_envs, Duration::from_secs(300))?;
    check_output(&output, "oci push")?;
    let manifest_digest = push_digest(&output.stdout)?;

    // Download to a temporary path outside dist/ so failed or unverified
    // artifacts never pollute the build output; the guard cleans up on all paths.
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
    pull.push(format!("{repo_ref}@{manifest_digest}"));
    pull.push(pulled.to_string_lossy().into_owned());
    let output = run_wash(&pull, wash_envs, Duration::from_secs(300))?;
    check_output(&output, "oci pull")?;
    if fs::read(&pulled)? != wasm {
        return Err("pulled Wasm differs from the local build".into());
    }
    Ok(manifest_digest)
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

/// Reject any world import outside `allowed` prefixes (when a policy is set).
fn check_imports(imports: &[String], allowed: Option<&[&str]>) -> Result<()> {
    let Some(prefixes) = allowed else {
        return Ok(());
    };
    match imports
        .iter()
        .find(|item| !prefixes.iter().any(|prefix| item.starts_with(prefix)))
    {
        Some(bad) => {
            Err(format!("built WIT has unexpected import {bad}; allowed: {prefixes:?}").into())
        }
        None => Ok(()),
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
                if let Some(rest) = line.strip_prefix(kind) {
                    match rest.strip_suffix(';') {
                        Some(item)
                            if !item.contains(char::is_whitespace) && !item.contains('{') =>
                        {
                            items.push(item.to_owned());
                        }
                        _ => {
                            return Err(format!(
                                "expected named top-level WIT interfaces, got `{line}`"
                            )
                            .into());
                        }
                    }
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

    #[cfg(unix)]
    fn exited(code: i32, stdout: &str, stderr: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn tool_failures_carry_stdout_and_stderr_without_secrets() {
        let secrets = vec![
            "s3cr3t-token".to_owned(),
            base64_encode(b"bot:s3cr3t-token"),
        ];
        // wash --output json fails on stdout with an empty stderr (#188).
        let push = exited(
            1,
            "{\"success\":false,\"message\":\"denied: permission_denied: write_package\"}\n",
            "",
        );
        let message = failure_message("wash oci push", &push, &secrets);
        assert!(
            message.starts_with("wash oci push failed (exit status: 1): stdout: {"),
            "{message}"
        );
        assert!(
            message.contains("permission_denied: write_package"),
            "{message}"
        );
        assert!(!message.contains("stderr"), "{message}");

        let both = exited(
            2,
            "  pushing ghcr.io/o/r:t with s3cr3t-token  \n",
            &format!("\nauth {} rejected\n", base64_encode(b"bot:s3cr3t-token")),
        );
        let message = failure_message("oras tag", &both, &secrets);
        assert_eq!(
            message,
            "oras tag failed (exit status: 2): stdout: pushing ghcr.io/o/r:t with [REDACTED]; \
             stderr: auth [REDACTED] rejected"
        );
        assert!(!message.contains("s3cr3t"));

        let silent = failure_message("wash oci pull", &exited(1, " \n", ""), &secrets);
        assert_eq!(
            silent,
            "wash oci pull failed (exit status: 1): no output on stdout or stderr"
        );

        let long = format!("{}é{}", "x".repeat(10), "y".repeat(1999));
        let message = failure_message("t", &exited(1, &long, ""), &[]);
        // The 2000-byte cut lands inside `é`: it moves to the next char boundary.
        assert_eq!(
            message,
            format!("t failed (exit status: 1): stdout: {}", "y".repeat(1999))
        );
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
    fn inline_imports_and_exports_are_rejected() {
        for item in [
            "import engine: interface {",
            "import run: func();",
            "export handler: interface {",
        ] {
            let wit = format!("world root {{\n  {item}\n  }}\n}}\n");
            assert!(world_items(&wit).is_err(), "{item}");
        }
    }

    #[test]
    fn tag_args_point_extra_tags_at_the_pushed_digest() {
        let tags = ["0.2.0".to_owned(), "stable".to_owned()];
        assert_eq!(
            tag_args(false, "ghcr.io/o/r", "sha256:abc", &tags),
            ["tag", "ghcr.io/o/r@sha256:abc", "0.2.0", "stable"]
        );
        assert_eq!(
            tag_args(true, "localhost:5000/r", "sha256:abc", &tags[..1])[..2],
            ["tag", "--plain-http"]
        );
    }

    #[test]
    fn rejects_imports_outside_the_allowed_prefixes() {
        let wasi = ["wasi:io/streams@0.2.6".to_owned()];
        let plug = [
            "wasi:io/streams@0.2.6".to_owned(),
            "di-framework:pglite-engine/engine@0.1.0".to_owned(),
        ];
        assert!(check_imports(&wasi, Some(&["wasi:"])).is_ok());
        assert!(check_imports(&plug, None).is_ok());
        let error = check_imports(&plug, Some(&["wasi:"])).unwrap_err();
        assert!(error.to_string().contains("pglite-engine"));
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
