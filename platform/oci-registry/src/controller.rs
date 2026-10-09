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
use crate::bindings::wasi::http::types::{Fields, Request, RequestOptions, Response, Scheme};
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
        match call(&target, bearer).await {
            Some((status, body)) if (200..300).contains(&status) => {
                role_from_body(&body, tenant.trim())
            }
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
        rest.split_once(']').map_or("", |(host, _)| host)
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host == "::1"
        || host.starts_with("127.")
        || ((host.ends_with(".svc") || host.ends_with(".svc.cluster.local"))
            && !host.starts_with('.'))
}

/// Map a 2xx whoami body to a role. The body must be the contract's
/// `Principal` (`user`, `account`, `role`, `via` all present) and its `account`
/// must be `tenant`; anything else denies.
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
    if tenant.is_empty() || account != tenant || !matches!(via, "identity" | "api-key") {
        return Whoami::Denied;
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

async fn call(target: &Target, bearer: &str) -> Option<(u16, Vec<u8>)> {
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
        ] {
            assert_eq!(Target::parse(bad), None, "{bad}");
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
