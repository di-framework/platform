//! The tenant controller's `GET /v1/auth/whoami` over outgoing `wasi:http`.
//!
//! The controller's base URL comes from component config: the
//! `tenant-controller-url` key, served by the `wasmcloud:secrets` plugin from
//! bind-time config (the same channel upstream used for its credentials), e.g.
//! `https://tenant-controller.di-runtime-<tenant>.svc:8788`. Plain `http://` is
//! accepted only for cluster-local hosts (`*.svc`, `*.svc.cluster.local`) and
//! loopback; see the README. The `tenant` key names the tenant this registry
//! belongs to, and the whoami principal's `account` must equal it.

use crate::auth::{Controller, Role, Whoami};
use crate::bindings;
use crate::bindings::wasi::http::client::send;
use crate::bindings::wasi::http::types::{
    ErrorCode, Fields, Request, RequestOptions, Response, Scheme,
};
use crate::bindings::wasmcloud::secrets::reveal::reveal;
use crate::bindings::wasmcloud::secrets::store::{self, SecretValue};

/// Config key holding the controller's base URL.
pub(crate) const URL_KEY: &str = "tenant-controller-url";
/// Config key holding the tenant (account) this registry serves.
pub(crate) const TENANT_KEY: &str = "tenant";
const WHOAMI_PATH: &str = "/v1/auth/whoami";
/// `wasi:http` timeouts for the whoami call, in nanoseconds: connect,
/// first byte, between bytes. The guest also races the whole call against
/// [`crate::auth::WHOAMI_DEADLINE_NANOS`] in case the host ignores them.
pub(crate) const TIMEOUTS: Timeouts = Timeouts {
    connect: 2_000_000_000,
    first_byte: 5_000_000_000,
    between_bytes: 5_000_000_000,
};

// The guest deadline must not cut the host's own timeouts short.
const _: () = assert!(TIMEOUTS.connect + TIMEOUTS.first_byte <= crate::auth::WHOAMI_DEADLINE_NANOS);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Timeouts {
    pub(crate) connect: u64,
    pub(crate) first_byte: u64,
    pub(crate) between_bytes: u64,
}
/// Largest whoami body read; a principal is a few hundred bytes.
const MAX_BODY: usize = 64 * 1024;

pub(crate) struct TenantController;

impl Controller for TenantController {
    async fn whoami(&self, bearer: &str) -> Whoami {
        let Some(base) = config_string(URL_KEY).await else {
            return Whoami::Denied;
        };
        let Some(tenant) = config_string(TENANT_KEY).await else {
            return Whoami::Denied;
        };
        let Some(target) = Target::parse(&base) else {
            return Whoami::Denied;
        };
        verdict(call(&target, bearer).await, tenant.trim())
    }
}

/// How one whoami call went.
#[derive(Debug)]
pub(crate) enum Outcome {
    /// The request could not be built, e.g. the credential is not a valid
    /// header value. Nothing was sent; the credential is at fault.
    Unsendable,
    /// `wasi:http` `send` failed: a refused or reset connection, a DNS or TLS
    /// failure, or one of the [`TIMEOUTS`].
    Failed(ErrorCode),
    /// The controller answered.
    Answered {
        status: u16,
        retry_after: Option<String>,
        body: Vec<u8>,
    },
}

/// Map a whoami call to a verdict. A 2xx is checked by [`role_from_body`]; a
/// `5xx` or a failed call means the controller is unavailable right now;
/// anything else (`401`, `403`, other statuses, an unsendable request) denies.
pub(crate) fn verdict(outcome: Outcome, tenant: &str) -> Whoami {
    match outcome {
        Outcome::Unsendable => Whoami::Denied,
        Outcome::Failed(error) => transport_failure(&error),
        Outcome::Answered { status, body, .. } if (200..300).contains(&status) => {
            role_from_body(&body, tenant)
        }
        Outcome::Answered {
            status,
            retry_after,
            ..
        } if (500..600).contains(&status) => Whoami::Unavailable {
            retry_after: retry_after.as_deref().and_then(parse_retry_after),
        },
        // A `429` deliberately gets the `401` challenge, not a retryable `503`:
        // the controller does not rate-limit whoami, so a `429` here is not a
        // condition the registry knows will clear. If whoami is ever
        // rate-limited, revisit this (and its test) so clients back off
        // instead of re-prompting for credentials.
        Outcome::Answered { status: 429, .. } => Whoami::Denied,
        Outcome::Answered { .. } => Whoami::Denied,
    }
}

/// How a `send` error is answered. Neither says anything about the
/// credential, which was never checked. A transient failure (the controller
/// restarting, a refused or reset connection, DNS, a timeout) is `503` so
/// clients retry; a configuration-type failure (the host's outgoing-HTTP
/// policy, a bad certificate, a request the host will never send) cannot clear
/// on retry, so it gets the `401` challenge like a missing configuration does.
/// The error code is logged, never its payload, the URL or the credential.
fn transport_failure(error: &ErrorCode) -> Whoami {
    let (code, transient) = classify(error);
    let answer = if transient { 503 } else { 401 };
    eprintln!("oci-registry: tenant controller whoami failed: {code}; answering {answer}");
    if transient {
        Whoami::Unavailable { retry_after: None }
    } else {
        Whoami::Denied
    }
}

/// The WIT name of a `wasi:http` error code (without its payload), and whether
/// the failure may clear on retry. Exhaustive, so a new code is a deliberate
/// choice.
fn classify(error: &ErrorCode) -> (&'static str, bool) {
    match error {
        // The controller or the network between is down, restarting or slow.
        ErrorCode::DnsTimeout => ("DNS-timeout", true),
        ErrorCode::DnsError(_) => ("DNS-error", true),
        ErrorCode::DestinationNotFound => ("destination-not-found", true),
        ErrorCode::DestinationUnavailable => ("destination-unavailable", true),
        ErrorCode::DestinationIpUnroutable => ("destination-IP-unroutable", true),
        ErrorCode::ConnectionRefused => ("connection-refused", true),
        ErrorCode::ConnectionTerminated => ("connection-terminated", true),
        ErrorCode::ConnectionTimeout => ("connection-timeout", true),
        ErrorCode::ConnectionReadTimeout => ("connection-read-timeout", true),
        ErrorCode::ConnectionWriteTimeout => ("connection-write-timeout", true),
        ErrorCode::ConnectionLimitReached => ("connection-limit-reached", true),
        ErrorCode::TlsProtocolError => ("TLS-protocol-error", true),
        ErrorCode::TlsAlertReceived(_) => ("TLS-alert-received", true),
        ErrorCode::HttpResponseIncomplete => ("HTTP-response-incomplete", true),
        ErrorCode::HttpResponseHeaderSectionSize(_) => ("HTTP-response-header-section-size", true),
        ErrorCode::HttpResponseHeaderSize(_) => ("HTTP-response-header-size", true),
        ErrorCode::HttpResponseBodySize(_) => ("HTTP-response-body-size", true),
        ErrorCode::HttpResponseTrailerSectionSize(_) => {
            ("HTTP-response-trailer-section-size", true)
        }
        ErrorCode::HttpResponseTrailerSize(_) => ("HTTP-response-trailer-size", true),
        ErrorCode::HttpResponseTransferCoding(_) => ("HTTP-response-transfer-coding", true),
        ErrorCode::HttpResponseContentCoding(_) => ("HTTP-response-content-coding", true),
        ErrorCode::HttpResponseTimeout => ("HTTP-response-timeout", true),
        ErrorCode::HttpProtocolError => ("HTTP-protocol-error", true),
        // A catch-all the host gives no detail for; assume it may clear.
        ErrorCode::InternalError(_) => ("internal-error", true),
        // Configuration: the host's policy, the controller's certificate, or
        // a request the host will refuse every time.
        ErrorCode::ConfigurationError => ("configuration-error", false),
        ErrorCode::HttpRequestDenied => ("HTTP-request-denied", false),
        ErrorCode::TlsCertificateError => ("TLS-certificate-error", false),
        ErrorCode::DestinationIpProhibited => ("destination-IP-prohibited", false),
        ErrorCode::LoopDetected => ("loop-detected", false),
        ErrorCode::HttpUpgradeFailed => ("HTTP-upgrade-failed", false),
        ErrorCode::HttpRequestLengthRequired => ("HTTP-request-length-required", false),
        ErrorCode::HttpRequestBodySize(_) => ("HTTP-request-body-size", false),
        ErrorCode::HttpRequestMethodInvalid => ("HTTP-request-method-invalid", false),
        ErrorCode::HttpRequestUriInvalid => ("HTTP-request-URI-invalid", false),
        ErrorCode::HttpRequestUriTooLong => ("HTTP-request-URI-too-long", false),
        ErrorCode::HttpRequestHeaderSectionSize(_) => ("HTTP-request-header-section-size", false),
        ErrorCode::HttpRequestHeaderSize(_) => ("HTTP-request-header-size", false),
        ErrorCode::HttpRequestTrailerSectionSize(_) => ("HTTP-request-trailer-section-size", false),
        ErrorCode::HttpRequestTrailerSize(_) => ("HTTP-request-trailer-size", false),
    }
}

/// `Retry-After` as delta-seconds (RFC 9110). An HTTP-date or anything else
/// is ignored (the registry then uses its default); a value beyond `u32`
/// saturates and is clamped later.
pub(crate) fn parse_retry_after(value: &str) -> Option<u32> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(value.parse().unwrap_or(u32::MAX))
}

/// Where `whoami` lives: scheme, authority and the full path.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) https: bool,
    pub(crate) authority: String,
    pub(crate) path: String,
}

impl Target {
    /// Parse `http[s]://authority[/prefix]` into the whoami target. Anything
    /// else (no scheme, other schemes, empty authority, query or fragment)
    /// is rejected, which denies every request.
    pub(crate) fn parse(base: &str) -> Option<Self> {
        let base = base.trim();
        let (https, rest) = if let Some(rest) = base.strip_prefix("https://") {
            (true, rest)
        } else {
            (false, base.strip_prefix("http://")?)
        };
        if rest.contains(['?', '#']) {
            return None;
        }
        let (authority, prefix) = rest.split_once('/').unwrap_or((rest, ""));
        if authority.is_empty() || authority.contains('@') {
            return None;
        }
        if !https && !is_cluster_local(authority) {
            return None;
        }
        let prefix = prefix.trim_end_matches('/');
        let path = if prefix.is_empty() {
            WHOAMI_PATH.to_string()
        } else {
            format!("/{prefix}{WHOAMI_PATH}")
        };
        Some(Self {
            https,
            authority: authority.to_string(),
            path,
        })
    }
}

/// Hosts that may be reached over plain `http://`: in-cluster Service names
/// and loopback (for `wash dev`).
fn is_cluster_local(authority: &str) -> bool {
    let host = if let Some(rest) = authority.strip_prefix('[') {
        // After `]` only nothing or `:<digits>` (a port) may follow.
        match rest.split_once(']') {
            Some((host, "")) => host,
            Some((host, port))
                if port.len() > 1
                    && port.starts_with(':')
                    && port[1..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                host
            }
            _ => return false,
        }
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    (host.ends_with(".svc") || host.ends_with(".svc.cluster.local")) && !host.starts_with('.')
}

/// Map a 2xx whoami body to a role. The body must be the contract's
/// `Principal` (`user`, `account`, `role`, `via` all present) and its `account`
/// must be `tenant`; anything else denies. `via: "host-pull"` is the tenant
/// hosts' pull credential (platform#83): it is capped at [`Role::Viewer`]
/// whatever `role` the body claims, so the registry itself limits it to pulls.
pub(crate) fn role_from_body(body: &[u8], tenant: &str) -> Whoami {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return Whoami::Denied;
    };
    let field = |name: &str| value.get(name).and_then(|v| v.as_str());
    let (Some(_user), Some(account), Some(role), Some(via)) =
        (field("user"), field("account"), field("role"), field("via"))
    else {
        return Whoami::Denied;
    };
    if tenant.is_empty() || account != tenant {
        return Whoami::Denied;
    }
    match via {
        "identity" | "api-key" => {}
        "host-pull" => return Whoami::Role(Role::Viewer),
        _ => return Whoami::Denied,
    }
    Role::parse(role).map_or(Whoami::Denied, Whoami::Role)
}

/// Request options carrying [`TIMEOUTS`]. A host may refuse a setter; the
/// guest-side deadline still bounds the call then.
fn request_options(timeouts: Timeouts) -> RequestOptions {
    let options = RequestOptions::new();
    let _ = options.set_connect_timeout(Some(timeouts.connect));
    let _ = options.set_first_byte_timeout(Some(timeouts.first_byte));
    let _ = options.set_between_bytes_timeout(Some(timeouts.between_bytes));
    options
}

async fn call(target: &Target, bearer: &str) -> Outcome {
    let Some(request) = build_request(target, bearer) else {
        return Outcome::Unsendable;
    };
    let response = match send(request).await {
        Ok(response) => response,
        Err(error) => return Outcome::Failed(error),
    };
    let status = response.get_status_code();
    let retry_after = response
        .get_headers()
        .get("retry-after")
        .into_iter()
        .next()
        .and_then(|value| String::from_utf8(value).ok());
    Outcome::Answered {
        status,
        retry_after,
        body: read_body(response).await,
    }
}

fn build_request(target: &Target, bearer: &str) -> Option<Request> {
    let headers = Fields::new();
    headers
        .append("authorization", format!("Bearer {bearer}").as_bytes())
        .ok()?;
    headers.append("accept", b"application/json").ok()?;
    let (trailers_tx, trailers_rx) = bindings::wit_future::new(|| Ok(None));
    drop(trailers_tx);
    let (request, _sent) =
        Request::new(headers, None, trailers_rx, Some(request_options(TIMEOUTS)));
    request
        .set_scheme(Some(if target.https {
            &Scheme::Https
        } else {
            &Scheme::Http
        }))
        .ok()?;
    request.set_authority(Some(&target.authority)).ok()?;
    request.set_path_with_query(Some(&target.path)).ok()?;
    Some(request)
}

async fn read_body(response: Response) -> Vec<u8> {
    let (res_tx, res_rx) = bindings::wit_future::new(|| Ok(()));
    let (mut body, _trailers) = Response::consume_body(response, res_rx);
    let mut out = Vec::new();
    while out.len() <= MAX_BODY {
        let (status, chunk) = body.read(Vec::with_capacity(4096)).await;
        out.extend_from_slice(&chunk);
        if !matches!(status, wit_bindgen::StreamResult::Complete(_)) {
            break;
        }
    }
    drop(res_tx);
    out
}

/// Read one bind-time config value through `wasmcloud:secrets`.
async fn config_string(key: &str) -> Option<String> {
    let secret = store::get(key.to_string()).await.ok()?;
    match reveal(&secret).await {
        SecretValue::String(value) => Some(value),
        SecretValue::Bytes(bytes) => String::from_utf8(bytes).ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bindings::wasi::http::types::DnsErrorPayload;

    #[test]
    fn parses_controller_base_urls() {
        assert_eq!(
            Target::parse("http://tenant-controller.di-runtime-acme.svc:8788"),
            Some(Target {
                https: false,
                authority: "tenant-controller.di-runtime-acme.svc:8788".into(),
                path: "/v1/auth/whoami".into(),
            })
        );
        assert_eq!(
            Target::parse(" https://controller.acme.svc/prefix/ "),
            Some(Target {
                https: true,
                authority: "controller.acme.svc".into(),
                path: "/prefix/v1/auth/whoami".into(),
            })
        );
        for bad in [
            "",
            "controller:8080",
            "ftp://controller",
            "http://",
            "http:///v1",
            "http://user:pw@controller",
            "http://controller/?x=1",
            "http://controller#frag",
        ] {
            assert_eq!(Target::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn plain_http_is_only_for_cluster_local_hosts() {
        for ok in [
            "http://c.ns.svc",
            "http://c.ns.svc.cluster.local:8788",
            "http://localhost:8788",
            "http://127.0.0.1:8788",
            "http://[::1]:8788",
            "http://[::1]",
            "https://controller.example.com",
        ] {
            assert!(Target::parse(ok).is_some(), "{ok}");
        }
        for bad in [
            "http://controller.example.com",
            "http://controller",
            "http://svc",
            "http://.svc",
            "http://c.svc.example.com",
            "http://10.0.0.1:8788",
            "http://[::2]",
            "http://127.attacker.example",
            "http://127.0.0.1.nip.io",
            "http://localhost.evil",
            "http://127.attacker.example:8788",
            "http://[::1]evil.example",
            "http://[::1].attacker.example",
            "http://[::1]:",
            "http://[::1]:80x",
            "http://[::1]:8788:1",
            "http://[::1",
        ] {
            assert_eq!(Target::parse(bad), None, "{bad}");
        }
    }

    fn answered(status: u16, retry_after: Option<&str>, body: &[u8]) -> Outcome {
        Outcome::Answered {
            status,
            retry_after: retry_after.map(str::to_string),
            body: body.to_vec(),
        }
    }

    const PRINCIPAL: &[u8] =
        br#"{"user":"a","account":"acme","role":"developer","via":"identity"}"#;

    #[test]
    fn a_2xx_principal_is_a_role() {
        assert_eq!(
            verdict(answered(200, None, PRINCIPAL), "acme"),
            Whoami::Role(Role::Developer)
        );
    }

    #[test]
    fn a_controller_503_is_unavailable_with_or_without_retry_after() {
        assert_eq!(
            verdict(answered(503, Some("30"), b""), "acme"),
            Whoami::Unavailable {
                retry_after: Some(30)
            }
        );
        assert_eq!(
            verdict(answered(503, None, b""), "acme"),
            Whoami::Unavailable { retry_after: None }
        );
        // An HTTP-date is not passed through; the registry uses its default.
        assert_eq!(
            verdict(
                answered(503, Some("Wed, 21 Oct 2026 07:28:00 GMT"), b""),
                "acme"
            ),
            Whoami::Unavailable { retry_after: None }
        );
    }

    #[test]
    fn every_5xx_is_unavailable_even_with_a_principal_body() {
        for status in [500, 502, 504, 599] {
            assert_eq!(
                verdict(answered(status, Some("7"), PRINCIPAL), "acme"),
                Whoami::Unavailable {
                    retry_after: Some(7)
                },
                "{status}"
            );
        }
    }

    #[test]
    fn a_timeout_or_refused_connection_is_unavailable() {
        for error in [
            ErrorCode::ConnectionRefused,
            ErrorCode::ConnectionTimeout,
            ErrorCode::ConnectionReadTimeout,
            ErrorCode::ConnectionTerminated,
            ErrorCode::DnsTimeout,
            ErrorCode::DestinationUnavailable,
        ] {
            let label = format!("{error:?}");
            assert_eq!(
                verdict(Outcome::Failed(error), "acme"),
                Whoami::Unavailable { retry_after: None },
                "{label}"
            );
        }
    }

    #[test]
    fn configuration_type_transport_errors_get_the_challenge() {
        for error in [
            ErrorCode::ConfigurationError,
            ErrorCode::HttpRequestDenied,
            ErrorCode::TlsCertificateError,
            ErrorCode::DestinationIpProhibited,
            ErrorCode::LoopDetected,
            ErrorCode::HttpRequestUriInvalid,
            ErrorCode::HttpRequestHeaderSize(None),
        ] {
            let label = format!("{error:?}");
            assert_eq!(
                verdict(Outcome::Failed(error), "acme"),
                Whoami::Denied,
                "{label}"
            );
        }
    }

    #[test]
    fn transient_transport_errors_stay_unavailable() {
        for error in [
            ErrorCode::DnsError(DnsErrorPayload {
                rcode: Some("SERVFAIL".to_string()),
                info_code: None,
            }),
            ErrorCode::TlsProtocolError,
            ErrorCode::HttpResponseIncomplete,
            ErrorCode::HttpResponseTimeout,
            ErrorCode::ConnectionWriteTimeout,
            ErrorCode::InternalError(Some("token=secret".to_string())),
        ] {
            let label = format!("{error:?}");
            assert_eq!(
                verdict(Outcome::Failed(error), "acme"),
                Whoami::Unavailable { retry_after: None },
                "{label}"
            );
        }
    }

    #[test]
    fn the_logged_code_is_the_wit_name_without_its_payload() {
        assert_eq!(
            classify(&ErrorCode::ConfigurationError),
            ("configuration-error", false)
        );
        assert_eq!(
            classify(&ErrorCode::HttpRequestDenied),
            ("HTTP-request-denied", false)
        );
        assert_eq!(
            classify(&ErrorCode::TlsCertificateError),
            ("TLS-certificate-error", false)
        );
        assert_eq!(
            classify(&ErrorCode::ConnectionRefused),
            ("connection-refused", true)
        );
        // A payload never reaches the log line.
        assert_eq!(
            classify(&ErrorCode::InternalError(Some(
                "Bearer dik_secret".to_string()
            ))),
            ("internal-error", true)
        );
    }

    #[test]
    fn a_controller_429_gets_the_challenge_not_a_retry() {
        // Pinned: whoami is not rate-limited, so a 429 denies (see `verdict`).
        for retry_after in [None, Some("30")] {
            assert_eq!(
                verdict(answered(429, retry_after, PRINCIPAL), "acme"),
                Whoami::Denied,
                "{retry_after:?}"
            );
        }
    }

    #[test]
    fn a_controller_401_or_403_denies() {
        for status in [401, 403] {
            for retry_after in [None, Some("30")] {
                assert_eq!(
                    verdict(answered(status, retry_after, PRINCIPAL), "acme"),
                    Whoami::Denied,
                    "{status} {retry_after:?}"
                );
            }
        }
    }

    #[test]
    fn other_statuses_and_unsendable_requests_deny() {
        for status in [100, 301, 400, 404, 600] {
            assert_eq!(
                verdict(answered(status, Some("5"), PRINCIPAL), "acme"),
                Whoami::Denied,
                "{status}"
            );
        }
        assert_eq!(verdict(Outcome::Unsendable, "acme"), Whoami::Denied);
    }

    #[test]
    fn retry_after_is_delta_seconds_only() {
        assert_eq!(parse_retry_after("0"), Some(0));
        assert_eq!(parse_retry_after(" 120 "), Some(120));
        assert_eq!(parse_retry_after("99999999999999999999"), Some(u32::MAX));
        for bad in [
            "",
            " ",
            "-1",
            "1.5",
            "+5",
            "5s",
            "Wed, 21 Oct 2026 07:28:00 GMT",
        ] {
            assert_eq!(parse_retry_after(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn timeouts_are_short() {
        assert_eq!(TIMEOUTS.connect, 2_000_000_000);
        assert_eq!(TIMEOUTS.first_byte, 5_000_000_000);
        assert_eq!(TIMEOUTS.between_bytes, 5_000_000_000);
    }

    #[test]
    fn whoami_body_maps_to_a_role_or_denies() {
        assert_eq!(
            role_from_body(
                br#"{"user":"a","account":"acme","role":"developer","via":"api-key"}"#,
                "acme"
            ),
            Whoami::Role(Role::Developer)
        );
        assert_eq!(
            role_from_body(
                br#"{"user":"a","account":"acme","role":"viewer","via":"identity","credentialId":"k"}"#,
                "acme"
            ),
            Whoami::Role(Role::Viewer)
        );
        for body in [
            &b""[..],
            b"not json",
            br#"{"role":"viewer"}"#,
            br#"{"user":"a","account":"acme","role":"admin","via":"identity"}"#,
            br#"{"user":"a","account":"acme","role":1,"via":"identity"}"#,
            br#"{"user":"a","account":"acme","role":"viewer","via":"other"}"#,
            br#"{"user":"a","account":"acme","role":"viewer"}"#,
            br#"{"account":"acme","role":"viewer","via":"identity"}"#,
            b"{}",
        ] {
            assert_eq!(role_from_body(body, "acme"), Whoami::Denied);
        }
    }

    /// The exact body the tenant controller answers for the host pull token;
    /// `platform/tenant-auth/tests/controller-host-pull.test.ts` pins the same
    /// fixture, so the two sides cannot drift.
    const HOST_PULL_FIXTURE: &[u8] = include_bytes!("../fixtures/whoami-host-pull.json");

    #[test]
    fn host_pull_body_from_the_controller_is_a_viewer() {
        assert_eq!(
            role_from_body(HOST_PULL_FIXTURE, "acme"),
            Whoami::Role(Role::Viewer)
        );
        assert_eq!(role_from_body(HOST_PULL_FIXTURE, "other"), Whoami::Denied);
    }

    #[test]
    fn host_pull_is_capped_at_viewer_whatever_role_it_claims() {
        for role in ["viewer", "developer", "admin", "owner"] {
            let body = format!(
                r#"{{"user":"system:tenant-host","account":"acme","role":"{role}","via":"host-pull"}}"#
            );
            assert_eq!(
                role_from_body(body.as_bytes(), "acme"),
                Whoami::Role(Role::Viewer),
                "{role}"
            );
        }
        for via in ["Host-Pull", "host-pull ", "hostpull", ""] {
            let body = format!(
                r#"{{"user":"system:tenant-host","account":"acme","role":"viewer","via":"{via}"}}"#
            );
            assert_eq!(
                role_from_body(body.as_bytes(), "acme"),
                Whoami::Denied,
                "{via:?}"
            );
        }
    }

    #[test]
    fn whoami_principal_must_belong_to_this_tenant() {
        let body = br#"{"user":"a","account":"other","role":"developer","via":"api-key"}"#;
        assert_eq!(
            role_from_body(body, "acme"),
            Whoami::Denied,
            "wrong account"
        );
        let missing = br#"{"user":"a","role":"developer","via":"api-key"}"#;
        assert_eq!(
            role_from_body(missing, "acme"),
            Whoami::Denied,
            "missing account"
        );
        let ok = br#"{"user":"a","account":"acme","role":"developer","via":"api-key"}"#;
        assert_eq!(
            role_from_body(ok, ""),
            Whoami::Denied,
            "missing tenant config"
        );
    }
}
