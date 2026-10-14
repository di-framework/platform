//! Validate and publish Wasm components with `oras` and `wash`, shared by every component
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
    // Tools reach registry credentials only through `DOCKER_CONFIG`; they
    // never inherit the raw password or token, so they cannot echo it.
    for name in CREDENTIAL_ENV {
        command.env_remove(name);
    }
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
    resolved_digest(&output.stdout, &secret_values())
}

/// The digest `oras resolve` printed, or an error carrying its masked output.
fn resolved_digest(stdout: &[u8], secrets: &[String]) -> Result<String> {
    let resolved = String::from_utf8_lossy(stdout).trim().to_owned();
    if !is_digest(&resolved) {
        return Err(format!(
            "oras resolve returned no digest: {}",
            tool_text(stdout, secrets, 200)
        )
        .into());
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

/// Environment variables the publisher reads registry passwords or tokens
/// from. `run_tool` removes them from every tool's environment.
const CREDENTIAL_ENV: [&str; 3] = ["DI_OCI_PASSWORD", "GHCR_TOKEN", "GITHUB_TOKEN"];

/// Registry secrets that must never reach an error message: the password or
/// token from the environment (raw, JSON-escaped and percent-encoded), and
/// the base64 `user:password` auth written to the `DOCKER_CONFIG` file.
/// Credentials never go in argv, and `run_tool` strips `CREDENTIAL_ENV` from
/// the tool env, so tools only see the auth inside `DOCKER_CONFIG`. Masking
/// is the second layer, in case a tool echoes what it read from there.
fn secret_values() -> Vec<String> {
    let mut secrets: Vec<String> = Vec::new();
    for value in CREDENTIAL_ENV
        .iter()
        .filter_map(|name| env::var(name).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        secrets.extend(encoded_forms(&value));
    }
    if let Ok(Some((username, password))) = registry_credentials() {
        secrets.push(base64_encode(format!("{username}:{password}").as_bytes()));
    }
    secrets.sort();
    secrets.dedup();
    secrets
}

/// `value` as a tool might print it: raw, JSON-escaped (as inside
/// `wash --output json`) and percent-encoded (as inside a URL).
fn encoded_forms(value: &str) -> Vec<String> {
    let json = serde_json::to_string(value).unwrap_or_default();
    let json = json
        .strip_prefix('"')
        .and_then(|j| j.strip_suffix('"'))
        .unwrap_or_default()
        .to_owned();
    let mut forms = vec![value.to_owned(), json, percent_encode(value)];
    forms.retain(|form| !form.is_empty());
    forms.dedup();
    forms
}

/// RFC 3986 percent-encoding: everything but unreserved characters.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
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

/// Tool output fit for an error message: trimmed, `secrets` masked, and only
/// then cut to its last `max` bytes, so the cut cannot split a secret and
/// leave a fragment of it unmasked. Every error that carries tool output
/// goes through here.
fn tool_text(bytes: &[u8], secrets: &[String], max: usize) -> String {
    let text = redact(String::from_utf8_lossy(bytes).trim(), secrets);
    tail(&text, max).to_owned()
}

/// `<what> failed (<status>): stdout: ...; stderr: ...`, each stream trimmed,
/// redacted, then cut to its last 2000 bytes. `wash --output json` reports
/// its failures on stdout and can leave stderr empty.
fn failure_message(what: &str, output: &Output, secrets: &[String]) -> String {
    let streams: Vec<String> = [("stdout", &output.stdout), ("stderr", &output.stderr)]
        .into_iter()
        .filter_map(|(name, bytes)| {
            let text = tool_text(bytes, secrets, 2000);
            (!text.is_empty()).then(|| format!("{name}: {text}"))
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
    // BUILD-INFO.txt is checksum-verified but not published: its build time
    // must not reach the OCI artifact, whose digest depends only on the
    // component (see `created_time`).
    let _ = read_checked(spec.build_info_file)?;
    let (imports, exports) = world_items(&wit)?;
    check_imports(&imports, spec.import_prefixes)?;
    if !exports.iter().any(|item| item == spec.required_export) {
        return Err(format!("built WIT lacks {}", spec.required_export).into());
    }
    let created = created_time(source_date_epoch()?.as_deref())?;
    let artifact = WasmArtifact::new(&wasm, &imports, &exports, &created);
    let wasm_digest = digest(&wasm);
    let log = spec.log_prefix;
    if !push_enabled {
        eprintln!(
            "[{log}] Validated {wasm_digest} (manifest {}); PUSH=true to publish",
            artifact.manifest_digest()
        );
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
    let tool_envs: Vec<(&str, &Path)> = match &docker_config {
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
    // One manifest, built here from the component alone, so every tag and
    // every publish of the same bytes share one manifest digest.
    let manifest_digest = push_and_verify(
        &repo_ref, &tags, &wasm_path, &wasm, &artifact, insecure, &tool_envs,
    )?;
    for tag in &tags {
        eprintln!("[{log}] Pushed tag: {repo_ref}:{tag} -> {manifest_digest}");
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

/// Manifest media type of the published artifact (OCI image manifest v1).
const MANIFEST_MEDIA_TYPE: &str = "application/vnd.oci.image.manifest.v1+json";
/// Config media type of the CNCF Wasm OCI artifact layout (`wash`, `wkg`).
const CONFIG_MEDIA_TYPE: &str = "application/vnd.wasm.config.v0+json";
/// Media type of the single component layer.
const WASM_LAYER_MEDIA_TYPE: &str = "application/wasm";
/// Latest second RFC 3339 can express: 9999-12-31T23:59:59Z.
const MAX_RFC3339_SECONDS: u64 = 253_402_300_799;

/// `SOURCE_DATE_EPOCH` from the environment; unset or empty means none.
fn source_date_epoch() -> Result<Option<String>> {
    match env::var("SOURCE_DATE_EPOCH") {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value.trim().to_owned())),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => {
            Err("SOURCE_DATE_EPOCH must be a decimal number of seconds".into())
        }
    }
}

/// The `created` time written into the config and the manifest annotation:
/// `SOURCE_DATE_EPOCH` when set (the reproducible-builds.org convention),
/// else the Unix epoch. Never the wall clock, so the manifest digest is a
/// function of the published bytes. The publish workflows leave
/// `SOURCE_DATE_EPOCH` unset, so the same component gets the same digest
/// whichever commit publishes it.
fn created_time(source_date_epoch: Option<&str>) -> Result<String> {
    let Some(value) = source_date_epoch else {
        return Ok(rfc3339_utc(0));
    };
    let seconds = value
        .bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| value.parse::<u64>().ok())
        .flatten()
        .filter(|seconds| *seconds <= MAX_RFC3339_SECONDS)
        .ok_or_else(|| {
            format!(
                "SOURCE_DATE_EPOCH must be a decimal number of seconds up to \
                 {MAX_RFC3339_SECONDS}, got {value:?}"
            )
        })?;
    Ok(rfc3339_utc(seconds))
}

/// `seconds` after the Unix epoch as RFC 3339 UTC (`1970-01-01T00:00:00Z`).
/// Days to a civil date: Howard Hinnant's `civil_from_days`.
fn rfc3339_utc(seconds: u64) -> String {
    let (days, time) = (seconds / 86_400, seconds % 86_400);
    let z = days + 719_468;
    let era = z / 146_097;
    let day_of_era = z % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        time / 60 % 60,
        time % 60
    )
}

/// A JSON string literal.
fn json_string(value: &str) -> String {
    Value::from(value).to_string()
}

/// A JSON array of string literals, in the given order.
fn json_strings(values: &[String]) -> String {
    let items: Vec<String> = values.iter().map(|value| json_string(value)).collect();
    format!("[{}]", items.join(","))
}

/// The config and manifest of a Wasm OCI artifact, in the layout `wash oci
/// push` and `wkg` produce: one `application/wasm` layer and an
/// `application/vnd.wasm.config.v0+json` config. The JSON is written with a
/// fixed field order and no whitespace, independent of `serde_json` features,
/// so equal inputs always give equal bytes and equal digests.
struct WasmArtifact {
    config: Vec<u8>,
    manifest: Vec<u8>,
}

impl WasmArtifact {
    fn new(wasm: &[u8], imports: &[String], exports: &[String], created: &str) -> Self {
        let wasm_digest = json_string(&digest(wasm));
        let created = json_string(created);
        let config = format!(
            "{{\"created\":{created},\"author\":null,\"architecture\":\"wasm\",\
             \"os\":\"wasip2\",\"layerDigests\":[{wasm_digest}],\
             \"component\":{{\"exports\":{},\"imports\":{},\"target\":null}}}}",
            json_strings(exports),
            json_strings(imports),
        )
        .into_bytes();
        let manifest = format!(
            "{{\"schemaVersion\":2,\"mediaType\":{},\
             \"config\":{{\"mediaType\":{},\"digest\":{},\"size\":{}}},\
             \"layers\":[{{\"mediaType\":{},\"digest\":{wasm_digest},\"size\":{}}}],\
             \"annotations\":{{\"org.opencontainers.image.created\":{created}}}}}",
            json_string(MANIFEST_MEDIA_TYPE),
            json_string(CONFIG_MEDIA_TYPE),
            json_string(&digest(&config)),
            config.len(),
            json_string(WASM_LAYER_MEDIA_TYPE),
            wasm.len(),
        )
        .into_bytes();
        Self { config, manifest }
    }

    fn config_digest(&self) -> String {
        digest(&self.config)
    }

    fn manifest_digest(&self) -> String {
        digest(&self.manifest)
    }
}

/// Private (0700) scratch directory, removed with its contents on drop.
struct ScratchDir(std::path::PathBuf);

impl ScratchDir {
    fn new(prefix: &str) -> Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&path)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `oras blob push <repo>@<digest> <file>`: upload one blob, checked against
/// its digest.
fn blob_push_args(insecure: bool, repo_ref: &str, digest: &str, file: &Path) -> Vec<String> {
    let mut args = vec!["blob".to_owned(), "push".to_owned()];
    if insecure {
        args.push("--plain-http".to_owned());
    }
    args.push(format!("{repo_ref}@{digest}"));
    args.push(file.to_string_lossy().into_owned());
    args
}

/// `oras manifest push <repo>:<tag>[,<tag>...] <file>`: one manifest, every tag.
fn manifest_push_args(insecure: bool, repo_ref: &str, tags: &[String], file: &Path) -> Vec<String> {
    let mut args = vec!["manifest".to_owned(), "push".to_owned()];
    if insecure {
        args.push("--plain-http".to_owned());
    }
    args.push("--media-type".to_owned());
    args.push(MANIFEST_MEDIA_TYPE.to_owned());
    args.push(format!("{repo_ref}:{}", tags.join(",")));
    args.push(file.to_string_lossy().into_owned());
    args
}

/// Push the component layer, the config and the manifest with `oras`, check
/// that every tag resolves to the manifest digest computed here, then pull
/// the component back with `wash` by that digest (not by a movable tag) and
/// compare the bytes.
fn push_and_verify(
    repo_ref: &str,
    tags: &[String],
    wasm_path: &Path,
    wasm: &[u8],
    artifact: &WasmArtifact,
    insecure: bool,
    envs: &[(&str, &Path)],
) -> Result<String> {
    let manifest_digest = artifact.manifest_digest();
    // Config, manifest and the pulled copy stay outside dist/, so failed or
    // unverified files never pollute the build output.
    let scratch = ScratchDir::new("wasm-publish")?;
    let config_path = scratch.0.join("config.json");
    let manifest_path = scratch.0.join("manifest.json");
    fs::write(&config_path, &artifact.config)?;
    fs::write(&manifest_path, &artifact.manifest)?;
    for (blob_digest, path) in [
        (digest(wasm), wasm_path),
        (artifact.config_digest(), config_path.as_path()),
    ] {
        let args = blob_push_args(insecure, repo_ref, &blob_digest, path);
        let output = run_tool("oras", &args, envs, Duration::from_secs(300))?;
        check_tool_output(&output, "oras blob push")?;
    }
    let args = manifest_push_args(insecure, repo_ref, tags, &manifest_path);
    let output = run_tool("oras", &args, envs, Duration::from_secs(120))?;
    check_tool_output(&output, "oras manifest push")?;
    for tag in tags {
        let resolved = resolve_tag(repo_ref, tag, insecure, envs)?;
        if resolved != manifest_digest {
            return Err(
                format!("tag {tag} resolves to {resolved}, expected {manifest_digest}").into(),
            );
        }
    }

    let pulled = scratch.0.join("pulled.wasm");
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
    let output = run_wash(&pull, envs, Duration::from_secs(300))?;
    check_output(&output, "oci pull")?;
    if fs::read(&pulled)? != wasm {
        return Err("pulled Wasm differs from the local build".into());
    }
    Ok(manifest_digest)
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

    /// Asserts that no fragment of `secret` of 4 or more bytes is in `message`.
    fn assert_no_fragment(message: &str, secret: &str) {
        for len in 4..=secret.len() {
            for start in 0..=secret.len() - len {
                let fragment = &secret[start..start + len];
                assert!(!message.contains(fragment), "{fragment:?} in {message}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn secrets_straddling_the_cut_are_masked_before_it() {
        let secret = "ghs_Q7wZ9xK2vT4mN8pR";
        let secrets = vec![secret.to_owned()];
        // The 2000-byte cut lands inside the secret: cut-then-mask would keep
        // its last 15 bytes, which no longer match the secret and survive.
        let stdout = format!("{}{secret}{}", "a".repeat(10), "b".repeat(1985));
        let message = failure_message("wash oci push", &exited(1, &stdout, ""), &secrets);
        assert_no_fragment(&message, secret);
        assert_eq!(
            message,
            format!(
                "wash oci push failed (exit status: 1): stdout: aaaaa[REDACTED]{}",
                "b".repeat(1985)
            )
        );
        // The same holds for the 200-byte cut on `oras resolve` output.
        let resolved = format!("{}{secret}{}", "a".repeat(10), "b".repeat(185));
        let error = resolved_digest(resolved.as_bytes(), &secrets)
            .unwrap_err()
            .to_string();
        assert_no_fragment(&error, secret);
        assert!(
            error.ends_with(&format!("aaaaa[REDACTED]{}", "b".repeat(185))),
            "{error}"
        );
    }

    #[test]
    fn oras_resolve_output_without_a_digest_is_masked() {
        let secrets = vec!["s3cr3t-token".to_owned()];
        let error = resolved_digest(b"  error: s3cr3t-token rejected\n", &secrets)
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "oras resolve returned no digest: error: [REDACTED] rejected"
        );
        let digest = format!("sha256:{}", "c".repeat(64));
        assert_eq!(
            resolved_digest(format!("{digest}\n").as_bytes(), &secrets).unwrap(),
            digest
        );
    }

    #[test]
    fn free_form_passwords_are_masked_in_encoded_forms() {
        let password = r#"p@ss "w/rd"\+%"#;
        let forms = encoded_forms(password);
        assert_eq!(
            forms,
            [
                password.to_owned(),
                r#"p@ss \"w/rd\"\\+%"#.to_owned(),
                "p%40ss%20%22w%2Frd%22%5C%2B%25".to_owned(),
            ]
        );
        let json = serde_json::json!({"success": false, "message": format!("bad {password}")});
        let url = format!("https://u:{}@ghcr.io/v2/", percent_encode(password));
        for text in [json.to_string(), url, format!("raw {password}")] {
            let masked = redact(&text, &forms);
            assert!(masked.contains("[REDACTED]"), "{masked}");
            assert!(
                !masked.contains("w/rd") && !masked.contains("w%2Frd"),
                "{masked}"
            );
        }
        // Tokens made of unreserved characters have a single form.
        assert_eq!(encoded_forms("ghs_abc123"), ["ghs_abc123"]);
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
    fn scratch_dir_is_private_and_removed_on_drop() {
        let path = {
            let scratch = ScratchDir::new("test-scratch").unwrap();
            fs::write(scratch.0.join("file"), b"temp").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&scratch.0).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o700);
            }
            scratch.0.clone()
        };
        assert!(!path.exists());
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn created_time_is_source_date_epoch_or_the_unix_epoch() {
        assert_eq!(created_time(None).unwrap(), "1970-01-01T00:00:00Z");
        for (epoch, expected) in [
            ("0", "1970-01-01T00:00:00Z"),
            ("951782400", "2000-02-29T00:00:00Z"),
            ("1700000000", "2023-11-14T22:13:20Z"),
            ("1709251199", "2024-02-29T23:59:59Z"),
            ("4102444800", "2100-01-01T00:00:00Z"),
            ("253402300799", "9999-12-31T23:59:59Z"),
        ] {
            assert_eq!(created_time(Some(epoch)).unwrap(), expected, "{epoch}");
        }
        for bad in [
            "-1",
            "+5",
            "1.5",
            "1e9",
            "now",
            "253402300800",
            "99999999999999999999",
        ] {
            let error = created_time(Some(bad)).unwrap_err().to_string();
            assert!(
                error.starts_with("SOURCE_DATE_EPOCH must be"),
                "{bad}: {error}"
            );
        }
    }

    #[test]
    fn artifact_bytes_and_digest_depend_only_on_the_inputs() {
        let imports = strings(&["wasi:io/error@0.2.9", "wasi:io/streams@0.2.9"]);
        let exports = strings(&["a:b/c@0.2.0"]);
        let created = created_time(None).unwrap();
        let first = WasmArtifact::new(b"wasm-bytes", &imports, &exports, &created);
        let second = WasmArtifact::new(b"wasm-bytes", &imports, &exports, &created);
        assert_eq!(first.config, second.config);
        assert_eq!(first.manifest, second.manifest);
        assert_eq!(first.manifest_digest(), second.manifest_digest());

        let wasm_digest = digest(b"wasm-bytes");
        assert_eq!(
            String::from_utf8(first.config.clone()).unwrap(),
            format!(
                "{{\"created\":\"1970-01-01T00:00:00Z\",\"author\":null,\"architecture\":\"wasm\",\
                 \"os\":\"wasip2\",\"layerDigests\":[\"{wasm_digest}\"],\"component\":{{\
                 \"exports\":[\"a:b/c@0.2.0\"],\
                 \"imports\":[\"wasi:io/error@0.2.9\",\"wasi:io/streams@0.2.9\"],\
                 \"target\":null}}}}"
            )
        );
        assert_eq!(
            String::from_utf8(first.manifest.clone()).unwrap(),
            format!(
                "{{\"schemaVersion\":2,\"mediaType\":\"application/vnd.oci.image.manifest.v1+json\",\
                 \"config\":{{\"mediaType\":\"application/vnd.wasm.config.v0+json\",\
                 \"digest\":\"{}\",\"size\":{}}},\
                 \"layers\":[{{\"mediaType\":\"application/wasm\",\"digest\":\"{wasm_digest}\",\
                 \"size\":10}}],\
                 \"annotations\":{{\"org.opencontainers.image.created\":\"1970-01-01T00:00:00Z\"}}}}",
                first.config_digest(),
                first.config.len()
            )
        );
        // Both documents are valid JSON with the OCI fields the registry checks.
        let manifest: Value = serde_json::from_slice(&first.manifest).unwrap();
        assert_eq!(manifest["config"]["digest"], first.config_digest());
        assert_eq!(manifest["config"]["size"], first.config.len());
        assert_eq!(manifest["layers"][0]["digest"], wasm_digest);
        let config: Value = serde_json::from_slice(&first.config).unwrap();
        assert_eq!(config["layerDigests"][0], wasm_digest);

        // Different component bytes, a different world or a different
        // SOURCE_DATE_EPOCH each give a different manifest digest.
        let other_wasm = WasmArtifact::new(b"wasm-bytez", &imports, &exports, &created);
        assert_ne!(other_wasm.manifest_digest(), first.manifest_digest());
        assert_ne!(other_wasm.config_digest(), first.config_digest());
        let other_world = WasmArtifact::new(b"wasm-bytes", &imports[..1], &exports, &created);
        assert_ne!(other_world.manifest_digest(), first.manifest_digest());
        let dated = created_time(Some("1700000000")).unwrap();
        let other_time = WasmArtifact::new(b"wasm-bytes", &imports, &exports, &dated);
        assert_ne!(other_time.manifest_digest(), first.manifest_digest());
    }

    #[test]
    fn json_strings_are_escaped() {
        let artifact = WasmArtifact::new(b"w", &strings(&["a\"b\\c"]), &[], "t");
        let config: Value = serde_json::from_slice(&artifact.config).unwrap();
        assert_eq!(config["component"]["imports"][0], "a\"b\\c");
        assert_eq!(config["component"]["exports"], serde_json::json!([]));
    }

    #[test]
    fn oras_args_push_blobs_by_digest_and_one_manifest_for_every_tag() {
        let tags = strings(&["commit1", "0.2.0"]);
        let file = Path::new("/tmp/m.json");
        assert_eq!(
            blob_push_args(false, "ghcr.io/o/r", "sha256:abc", file),
            ["blob", "push", "ghcr.io/o/r@sha256:abc", "/tmp/m.json"]
        );
        assert_eq!(
            blob_push_args(true, "localhost:5000/r", "sha256:abc", file)[..3],
            ["blob", "push", "--plain-http"]
        );
        assert_eq!(
            manifest_push_args(false, "ghcr.io/o/r", &tags, file),
            [
                "manifest",
                "push",
                "--media-type",
                "application/vnd.oci.image.manifest.v1+json",
                "ghcr.io/o/r:commit1,0.2.0",
                "/tmp/m.json"
            ]
        );
        assert_eq!(
            manifest_push_args(true, "localhost:5000/r", &tags[..1], file)[2..],
            [
                "--plain-http",
                "--media-type",
                "application/vnd.oci.image.manifest.v1+json",
                "localhost:5000/r:commit1",
                "/tmp/m.json"
            ]
        );
    }
}
