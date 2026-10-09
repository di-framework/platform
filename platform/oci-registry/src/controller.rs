//! The tenant controller's `GET /v1/auth/whoami` over outgoing `wasi:http`.
//!
//! The controller's base URL comes from component config: the
//! `tenant-controller-url` key, served by the `wasmcloud:secrets` plugin from
//! bind-time config (the same channel upstream used for its credentials). It is
//! expected to be the in-namespace Service, e.g.
//! `http://tenant-auth-controller.<namespace>.svc:8080`; see the README for why
//! plain HTTP inside the namespace rather than the controller's private-CA TLS.

use crate::auth::{Controller, Role, Whoami};
use crate::bindings;
use crate::bindings::wasi::http::client::send;
use crate::bindings::wasi::http::types::{Fields, Request, Response, Scheme};
use crate::bindings::wasmcloud::secrets::reveal::reveal;
use crate::bindings::wasmcloud::secrets::store::{self, SecretValue};

/// Config key holding the controller's base URL.
pub(crate) const URL_KEY: &str = "tenant-controller-url";
const WHOAMI_PATH: &str = "/v1/auth/whoami";
/// Largest whoami body read; a principal is a few hundred bytes.
const MAX_BODY: usize = 64 * 1024;

pub(crate) struct TenantController;

impl Controller for TenantController {
    async fn whoami(&self, bearer: &str) -> Whoami {
        let Some(base) = config_string(URL_KEY).await else {
            return Whoami::Denied;
        };
        let Some(target) = Target::parse(&base) else {
            return Whoami::Denied;
        };
        match call(&target, bearer).await {
            Some((status, body)) if (200..300).contains(&status) => role_from_body(&body),
            _ => Whoami::Denied,
        }
    }
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

/// Map a 2xx whoami body (`{"role": "viewer" | "developer", ...}`) to a role.
pub(crate) fn role_from_body(body: &[u8]) -> Whoami {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("role").and_then(|r| r.as_str()).and_then(Role::parse))
        .map_or(Whoami::Denied, Whoami::Role)
}

async fn call(target: &Target, bearer: &str) -> Option<(u16, Vec<u8>)> {
    let headers = Fields::new();
    headers
        .append("authorization", format!("Bearer {bearer}").as_bytes())
        .ok()?;
    headers.append("accept", b"application/json").ok()?;
    let (trailers_tx, trailers_rx) = bindings::wit_future::new(|| Ok(None));
    drop(trailers_tx);
    let (request, _sent) = Request::new(headers, None, trailers_rx, None);
    request
        .set_scheme(Some(if target.https {
            &Scheme::Https
        } else {
            &Scheme::Http
        }))
        .ok()?;
    request.set_authority(Some(&target.authority)).ok()?;
    request.set_path_with_query(Some(&target.path)).ok()?;
    let response = send(request).await.ok()?;
    let status = response.get_status_code();
    Some((status, read_body(response).await))
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

    #[test]
    fn parses_controller_base_urls() {
        assert_eq!(
            Target::parse("http://tenant-auth-controller.acme.svc:8080"),
            Some(Target {
                https: false,
                authority: "tenant-auth-controller.acme.svc:8080".into(),
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
    fn whoami_body_maps_to_a_role_or_denies() {
        assert_eq!(
            role_from_body(br#"{"user":"a","role":"developer","via":"api-key"}"#),
            Whoami::Role(Role::Developer)
        );
        assert_eq!(
            role_from_body(br#"{"role":"viewer"}"#),
            Whoami::Role(Role::Viewer)
        );
        for body in [
            &b""[..],
            b"not json",
            br#"{"role":"admin"}"#,
            br#"{"role":1}"#,
            b"{}",
        ] {
            assert_eq!(role_from_body(body), Whoami::Denied);
        }
    }
}
