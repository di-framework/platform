//! Registry authorization through the tenant controller.
//!
//! di-framework replaces upstream's single shared Basic credential with a
//! callback: the Basic *password* is an identity-server access token or a
//! `dik_` API key (the username is ignored). The registry presents it as a
//! bearer credential to the tenant controller's `GET /v1/auth/whoami` in the
//! same namespace and maps the returned role onto registry operations:
//!
//! | Role        | Pull (`GET`, `HEAD`) | Push / delete (`POST`, `PUT`, `PATCH`, `DELETE`) |
//! | ----------- | -------------------- | ------------------------------------------------ |
//! | `viewer`    | allowed              | `403 DENIED`                                     |
//! | `developer` | allowed              | allowed                                          |
//!
//! Positive answers are cached briefly (bounded size and TTL) under the
//! SHA-256 of the credential, never the raw token. The registry fails closed:
//! only a 2xx with a known role authorizes. A controller that is temporarily
//! unavailable (a `5xx`, a timeout, a refused or failed connection) gets
//! `503 UNAVAILABLE` with `Retry-After`, so clients retry instead of blaming
//! their credentials. Anything else (misconfiguration, a `401` or `403`, an
//! unparseable body, a principal of another tenant) gets the `401` challenge.
//! Every request needs credentials — including the `GET /v2/` probe, which is
//! where an OCI client discovers it must authenticate.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::pin::pin;
use std::rc::Rc;
use std::task::Poll;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};

use crate::http::{error_body, error_response, header_str, respond};
use crate::{Fields, Method, Response};

const REALM: &str = "di-framework-tenant-registry";
/// How long a positive controller answer is reused.
pub(crate) const CACHE_TTL_NANOS: u64 = 30 * 1_000_000_000;
/// Upper bound on cached credentials.
pub(crate) const CACHE_CAPACITY: usize = 256;
/// Upper bound on one whoami callback, enforced in the guest on top of the
/// `wasi:http` request options (which a host may ignore). Expiry answers `503`.
pub(crate) const WHOAMI_DEADLINE_NANOS: u64 = 12 * 1_000_000_000;
/// `Retry-After` (seconds) sent with a `503` when the controller gave none.
pub(crate) const RETRY_AFTER_DEFAULT_SECS: u32 = 5;
/// Bounds on the `Retry-After` (seconds) passed through from the controller.
pub(crate) const RETRY_AFTER_MIN_SECS: u32 = 1;
pub(crate) const RETRY_AFTER_MAX_SECS: u32 = 60;

/// The tenant role the controller reports for a credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    Viewer,
    Developer,
}

impl Role {
    pub(crate) fn parse(role: &str) -> Option<Self> {
        match role {
            "viewer" => Some(Self::Viewer),
            "developer" => Some(Self::Developer),
            _ => None,
        }
    }

    fn allows(self, access: Access) -> bool {
        match access {
            Access::Read => true,
            Access::Write => self == Self::Developer,
        }
    }
}

/// What a registry operation needs: reading (pull) or writing (push, delete).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Access {
    Read,
    Write,
}

/// Map a registry request to the access it needs. Pulls, existence checks, tag
/// listing, referrers and the `/v2/` probe are `GET`/`HEAD`; uploads, mounts,
/// manifest pushes and deletes are `POST`/`PUT`/`PATCH`/`DELETE`. Any other
/// method is treated as a write so an unknown verb never slips through as a
/// read. Every registry route (see the table in `lib.rs`) reads with
/// `GET`/`HEAD` and writes with the others, so the method alone decides.
pub(crate) fn required_access(method: &str) -> Access {
    match method {
        "GET" | "HEAD" => Access::Read,
        _ => Access::Write,
    }
}

/// The controller's verdict on a credential. Neither `Denied` nor
/// `Unavailable` ever authorizes, and only `Role` is cached.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Whoami {
    Role(Role),
    /// The controller rejected the credential (`401`, `403`), vouched for a
    /// principal this registry does not serve, or is not configured.
    Denied,
    /// The controller could not answer right now: a `5xx`, a timeout or a
    /// failed connection. `retry_after` is the controller's own `Retry-After`
    /// in seconds, when it sent one.
    Unavailable {
        retry_after: Option<u32>,
    },
}

/// The tenant controller's `GET /v1/auth/whoami`, called with the credential
/// as a bearer token. Implemented over `wasi:http` in [`crate::controller`] and
/// by a fake in the tests.
pub(crate) trait Controller {
    async fn whoami(&self, bearer: &str) -> Whoami;
}

/// Bounded, TTL'd cache of positive answers keyed by the credential's SHA-256.
pub(crate) struct Cache {
    entries: HashMap<[u8; 32], (Role, u64)>,
    capacity: usize,
    ttl: u64,
}

impl Cache {
    pub(crate) fn new(capacity: usize, ttl: u64) -> Self {
        Self {
            entries: HashMap::new(),
            capacity,
            ttl,
        }
    }

    fn get(&mut self, key: &[u8; 32], now: u64) -> Option<Role> {
        match self.entries.get(key) {
            Some(&(role, expires)) if now < expires => Some(role),
            Some(_) => {
                self.entries.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&mut self, key: [u8; 32], role: Role, now: u64) {
        if self.capacity == 0 {
            return;
        }
        if !self.entries.contains_key(&key) && self.entries.len() >= self.capacity {
            self.entries.retain(|_, &mut (_, expires)| now < expires);
            if self.entries.len() >= self.capacity
                && let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (_, expires))| *expires)
                    .map(|(k, _)| *k)
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries
            .insert(key, (role, now.saturating_add(self.ttl)));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Outcome of authorizing one request.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Allow,
    /// No usable credential, or the controller did not vouch for it: `401`.
    Challenge,
    /// A known principal whose role does not permit the operation: `403`.
    Forbidden,
    /// The controller is temporarily unavailable: `503` with `Retry-After`
    /// (seconds, already clamped).
    Unavailable {
        retry_after: u32,
    },
}

/// The `Retry-After` to send: the controller's value clamped to
/// [`RETRY_AFTER_MIN_SECS`]..=[`RETRY_AFTER_MAX_SECS`], or
/// [`RETRY_AFTER_DEFAULT_SECS`] when it sent none.
pub(crate) fn retry_after_secs(from_controller: Option<u32>) -> u32 {
    from_controller.map_or(RETRY_AFTER_DEFAULT_SECS, |secs| {
        secs.clamp(RETRY_AFTER_MIN_SECS, RETRY_AFTER_MAX_SECS)
    })
}

/// Run `work` until it finishes or `deadline` fires, whichever is first.
/// `None` means the deadline won.
pub(crate) async fn race<W: Future, D: Future<Output = ()>>(
    work: W,
    deadline: D,
) -> Option<W::Output> {
    let mut work = pin!(work);
    let mut deadline = pin!(deadline);
    poll_fn(|cx| {
        if let Poll::Ready(value) = work.as_mut().poll(cx) {
            return Poll::Ready(Some(value));
        }
        if deadline.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

/// Decide a request from its `Authorization` header and the access it needs.
/// The controller call is abandoned when `deadline` completes first, which
/// counts as the controller being unavailable; a cache hit never waits on it.
pub(crate) async fn authorize<C: Controller, D: Future<Output = ()>>(
    cache: &RefCell<Cache>,
    controller: &C,
    authorization: Option<&str>,
    access: Access,
    now: u64,
    deadline: D,
) -> Decision {
    let Some(password) = authorization.and_then(basic_password) else {
        return Decision::Challenge;
    };
    let key: [u8; 32] = Sha256::digest(password.as_bytes()).into();
    let cached = cache.borrow_mut().get(&key, now);
    let role = match cached {
        Some(role) => role,
        None => match race(controller.whoami(&password), deadline).await {
            Some(Whoami::Role(role)) => {
                cache.borrow_mut().put(key, role, now);
                role
            }
            Some(Whoami::Denied) => return Decision::Challenge,
            Some(Whoami::Unavailable { retry_after }) => {
                return Decision::Unavailable {
                    retry_after: retry_after_secs(retry_after),
                };
            }
            None => {
                return Decision::Unavailable {
                    retry_after: retry_after_secs(None),
                };
            }
        },
    };
    if role.allows(access) {
        Decision::Allow
    } else {
        Decision::Forbidden
    }
}

/// Extract the password from an `Authorization: Basic <base64(user:pass)>`
/// header. The scheme is matched case-insensitively per RFC 7617; the username
/// is ignored; an empty password, another scheme or bad encoding yields `None`.
pub(crate) fn basic_password(header: &str) -> Option<String> {
    let (scheme, token) = header.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Basic") {
        return None;
    }
    let decoded = STANDARD.decode(token.trim()).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (_user, password) = decoded.split_once(':')?;
    (!password.is_empty()).then(|| password.to_string())
}

thread_local! {
    // Shared by every request this instance serves. `authorize` borrows it
    // only for a single get or put, never across the controller await, so
    // concurrent requests in one instance see each other's entries.
    static CACHE: Rc<RefCell<Cache>> =
        Rc::new(RefCell::new(Cache::new(CACHE_CAPACITY, CACHE_TTL_NANOS)));
}

/// Returns `Some(response)` — `401` with a `WWW-Authenticate: Basic` challenge,
/// `403`, or `503` with `Retry-After` — when the request may not proceed, and
/// `None` when it may.
pub(crate) async fn require_access(headers: &Fields, method: &Method) -> Option<Response> {
    let access = required_access(method_name(method));
    let authorization = header_str(headers, "authorization");
    use crate::bindings::wasi::clocks::monotonic_clock;
    let now = monotonic_clock::now();
    let controller = crate::controller::TenantController;
    let cache = CACHE.with(Rc::clone);
    let deadline = monotonic_clock::wait_for(WHOAMI_DEADLINE_NANOS);
    let decision = authorize(
        &cache,
        &controller,
        authorization.as_deref(),
        access,
        now,
        deadline,
    )
    .await;
    match decision {
        Decision::Allow => None,
        Decision::Challenge => Some(challenge()),
        Decision::Forbidden => Some(error_response(
            403,
            "DENIED",
            "your tenant role does not allow this operation",
        )),
        Decision::Unavailable { retry_after } => Some(unavailable(retry_after)),
    }
}

fn method_name(method: &Method) -> &str {
    match method {
        Method::Get => "GET",
        Method::Head => "HEAD",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Delete => "DELETE",
        Method::Connect => "CONNECT",
        Method::Options => "OPTIONS",
        Method::Trace => "TRACE",
        Method::Patch => "PATCH",
        Method::Other(other) => other.as_str(),
    }
}

fn challenge() -> Response {
    let header = format!("Basic realm=\"{REALM}\"");
    respond(
        401,
        &[
            ("www-authenticate", header.as_str()),
            ("content-type", "application/json"),
            ("docker-distribution-api-version", "registry/2.0"),
        ],
        br#"{"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}"#.to_vec(),
    )
}

/// `503` while the tenant controller cannot vouch for credentials. No
/// `WWW-Authenticate`: the credential was not rejected.
fn unavailable(retry_after: u32) -> Response {
    let retry_after = retry_after.to_string();
    respond(
        503,
        &[
            ("retry-after", retry_after.as_str()),
            ("content-type", "application/json"),
            ("docker-distribution-api-version", "registry/2.0"),
        ],
        error_body(
            "UNAVAILABLE",
            "the tenant controller is temporarily unavailable; retry shortly",
        ),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    /// Drive a future that never actually suspends (the fake controller answers
    /// synchronously).
    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("fake controller suspended"),
        }
    }

    /// A fake tenant controller: a fixed token → role table, an "unavailable"
    /// switch (with the `Retry-After` it reports), and a call counter.
    struct FakeController {
        tokens: Vec<(&'static str, Role)>,
        unavailable: Option<Option<u32>>,
        calls: Cell<usize>,
        seen: RefCell<Vec<String>>,
    }

    impl FakeController {
        fn new(tokens: Vec<(&'static str, Role)>) -> Self {
            Self {
                tokens,
                unavailable: None,
                calls: Cell::new(0),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl Controller for FakeController {
        async fn whoami(&self, bearer: &str) -> Whoami {
            self.calls.set(self.calls.get() + 1);
            self.seen.borrow_mut().push(bearer.to_string());
            if let Some(retry_after) = self.unavailable {
                return Whoami::Unavailable { retry_after };
            }
            self.tokens
                .iter()
                .find(|(token, _)| *token == bearer)
                .map_or(Whoami::Denied, |(_, role)| Whoami::Role(*role))
        }
    }

    fn basic(user: &str, password: &str) -> String {
        format!("Basic {}", STANDARD.encode(format!("{user}:{password}")))
    }

    fn cache() -> RefCell<Cache> {
        RefCell::new(Cache::new(CACHE_CAPACITY, CACHE_TTL_NANOS))
    }

    fn fake() -> FakeController {
        FakeController::new(vec![
            ("viewer-token", Role::Viewer),
            ("dik_developer", Role::Developer),
        ])
    }

    fn decide(
        c: &RefCell<Cache>,
        f: &FakeController,
        header: Option<&str>,
        method: &str,
    ) -> Decision {
        block_on(authorize(
            c,
            f,
            header,
            required_access(method),
            0,
            std::future::pending(),
        ))
    }

    #[test]
    fn methods_map_to_read_or_write() {
        assert_eq!(required_access("GET"), Access::Read);
        assert_eq!(required_access("HEAD"), Access::Read);
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PURGE"] {
            assert_eq!(required_access(method), Access::Write, "{method}");
        }
    }

    #[test]
    fn viewer_may_pull_but_not_push_or_delete() {
        let (c, f) = (cache(), fake());
        let auth = basic("anything", "viewer-token");
        assert_eq!(decide(&c, &f, Some(&auth), "GET"), Decision::Allow);
        assert_eq!(decide(&c, &f, Some(&auth), "HEAD"), Decision::Allow);
        for method in ["POST", "PUT", "PATCH", "DELETE"] {
            assert_eq!(
                decide(&c, &f, Some(&auth), method),
                Decision::Forbidden,
                "{method}"
            );
        }
    }

    #[test]
    fn developer_may_pull_push_and_delete() {
        let (c, f) = (cache(), fake());
        let auth = basic("", "dik_developer");
        for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] {
            assert_eq!(
                decide(&c, &f, Some(&auth), method),
                Decision::Allow,
                "{method}"
            );
        }
    }

    #[test]
    fn password_is_sent_as_bearer_and_username_is_ignored() {
        let (c, f) = (cache(), fake());
        assert_eq!(
            decide(&c, &f, Some(&basic("someone-else", "viewer-token")), "GET"),
            Decision::Allow
        );
        assert_eq!(f.seen.borrow().as_slice(), ["viewer-token"]);
    }

    #[test]
    fn missing_or_malformed_credentials_are_challenged_without_a_callback() {
        let (c, f) = (cache(), fake());
        for header in [
            None,
            Some("Bearer viewer-token"),
            Some("Basic !!!not-base64"),
            Some("Basic"),
            Some(basic("user", "").as_str()),
            Some(format!("Basic {}", STANDARD.encode("no-colon")).as_str()),
            Some(format!("Basic {}", STANDARD.encode([0xff, b':', 0xfe])).as_str()),
        ] {
            assert_eq!(
                decide(&c, &f, header, "GET"),
                Decision::Challenge,
                "{header:?}"
            );
        }
        assert_eq!(f.calls.get(), 0);
        assert_eq!(
            basic_password(&format!("bAsIc {}", STANDARD.encode("u:p"))).as_deref(),
            Some("p")
        );
    }

    #[test]
    fn unknown_token_is_challenged_and_not_cached() {
        let (c, f) = (cache(), fake());
        let auth = basic("u", "stolen");
        assert_eq!(decide(&c, &f, Some(&auth), "GET"), Decision::Challenge);
        assert_eq!(decide(&c, &f, Some(&auth), "GET"), Decision::Challenge);
        assert_eq!(f.calls.get(), 2);
        assert_eq!(c.borrow().len(), 0);
    }

    #[test]
    fn an_unavailable_controller_answers_503_and_never_authorizes() {
        let c = cache();
        let mut f = fake();
        f.unavailable = Some(None);
        for method in ["GET", "HEAD", "PUT", "DELETE"] {
            assert_eq!(
                decide(&c, &f, Some(&basic("u", "dik_developer")), method),
                Decision::Unavailable {
                    retry_after: RETRY_AFTER_DEFAULT_SECS
                },
                "{method}"
            );
        }
        assert_eq!(c.borrow().len(), 0);
    }

    #[test]
    fn the_controllers_retry_after_is_passed_through_clamped() {
        for (from_controller, sent) in [
            (Some(30), 30),
            (Some(1), 1),
            (Some(0), RETRY_AFTER_MIN_SECS),
            (Some(3600), RETRY_AFTER_MAX_SECS),
            (Some(u32::MAX), RETRY_AFTER_MAX_SECS),
            (None, RETRY_AFTER_DEFAULT_SECS),
        ] {
            let c = cache();
            let mut f = fake();
            f.unavailable = Some(from_controller);
            assert_eq!(
                decide(&c, &f, Some(&basic("u", "viewer-token")), "GET"),
                Decision::Unavailable { retry_after: sent },
                "{from_controller:?}"
            );
            assert_eq!(c.borrow().len(), 0, "{from_controller:?}");
        }
    }

    #[test]
    fn unavailable_is_not_cached_so_the_next_request_asks_again() {
        let c = cache();
        let mut f = fake();
        let auth = basic("u", "dik_developer");
        f.unavailable = Some(Some(10));
        assert_eq!(
            decide(&c, &f, Some(&auth), "PUT"),
            Decision::Unavailable { retry_after: 10 }
        );
        f.unavailable = None;
        assert_eq!(decide(&c, &f, Some(&auth), "PUT"), Decision::Allow);
        assert_eq!(f.calls.get(), 2);
        assert_eq!(c.borrow().len(), 1);
    }

    #[test]
    fn a_rejected_credential_still_gets_the_challenge() {
        // The controller's 401 / 403 arrive here as `Denied` (see
        // `controller::verdict`).
        let (c, f) = (cache(), fake());
        for method in ["GET", "PUT"] {
            assert_eq!(
                decide(&c, &f, Some(&basic("u", "revoked")), method),
                Decision::Challenge,
                "{method}"
            );
        }
        assert_eq!(c.borrow().len(), 0);
    }

    #[test]
    fn positive_answers_are_cached_until_the_ttl_expires() {
        let c = RefCell::new(Cache::new(8, 100));
        let f = fake();
        let auth = basic("u", "viewer-token");
        let at = |now| {
            block_on(authorize(
                &c,
                &f,
                Some(&auth),
                Access::Read,
                now,
                std::future::pending(),
            ))
        };
        assert_eq!(at(0), Decision::Allow);
        assert_eq!(at(99), Decision::Allow);
        assert_eq!(f.calls.get(), 1);
        assert_eq!(at(100), Decision::Allow);
        assert_eq!(f.calls.get(), 2);
    }

    #[test]
    fn cache_is_keyed_by_a_hash_of_the_credential() {
        let c = cache();
        let f = fake();
        decide(&c, &f, Some(&basic("u", "viewer-token")), "GET");
        let key: [u8; 32] = Sha256::digest(b"viewer-token").into();
        assert!(c.borrow().entries.contains_key(&key));
    }

    #[test]
    fn cache_is_bounded_and_evicts_expired_then_oldest() {
        let mut cache = Cache::new(2, 10);
        cache.put([1; 32], Role::Viewer, 0);
        cache.put([2; 32], Role::Viewer, 5);
        cache.put([3; 32], Role::Developer, 6);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get(&[1; 32], 6), None);
        assert_eq!(cache.get(&[3; 32], 6), Some(Role::Developer));
        // Re-putting an existing key does not evict anything.
        cache.put([3; 32], Role::Developer, 7);
        assert_eq!(cache.len(), 2);
        // Expired entries are dropped first when full.
        cache.put([4; 32], Role::Viewer, 15);
        assert_eq!(cache.get(&[2; 32], 15), None);
        assert_eq!(cache.get(&[4; 32], 15), Some(Role::Viewer));
        assert_eq!(cache.len(), 2);

        let mut disabled = Cache::new(0, 10);
        disabled.put([1; 32], Role::Viewer, 0);
        assert_eq!(disabled.len(), 0);
    }

    /// A controller that accepts the call and never answers.
    struct HangingController;

    impl Controller for HangingController {
        async fn whoami(&self, _bearer: &str) -> Whoami {
            std::future::pending().await
        }
    }

    #[test]
    fn a_hanging_controller_times_out_with_503() {
        let c = cache();
        let auth = basic("u", "dik_developer");
        for access in [Access::Read, Access::Write] {
            let decision = block_on(authorize(
                &c,
                &HangingController,
                Some(&auth),
                access,
                0,
                std::future::ready(()),
            ));
            assert_eq!(
                decision,
                Decision::Unavailable {
                    retry_after: RETRY_AFTER_DEFAULT_SECS
                }
            );
        }
        assert_eq!(c.borrow().len(), 0);
    }

    #[test]
    fn concurrent_requests_share_one_cache() {
        // Two requests interleave: the first is suspended inside its controller
        // call while the second completes. Both entries must survive.
        let c = Rc::new(cache());
        let f = fake();
        let mut cx = Context::from_waker(Waker::noop());
        let gate = Cell::new(false);
        let viewer = basic("u", "viewer-token");
        let developer = basic("u", "dik_developer");
        struct Slow<'a>(&'a FakeController, &'a Cell<bool>);
        impl Controller for Slow<'_> {
            async fn whoami(&self, bearer: &str) -> Whoami {
                poll_fn(|_| {
                    if self.1.get() {
                        Poll::Ready(())
                    } else {
                        Poll::Pending
                    }
                })
                .await;
                self.0.whoami(bearer).await
            }
        }
        let slow = Slow(&f, &gate);
        let mut first = pin!(authorize(
            &c,
            &slow,
            Some(&viewer),
            Access::Read,
            0,
            std::future::pending()
        ));
        assert!(first.as_mut().poll(&mut cx).is_pending());
        assert_eq!(
            block_on(authorize(
                &c,
                &f,
                Some(&developer),
                Access::Write,
                0,
                std::future::pending()
            )),
            Decision::Allow
        );
        assert_eq!(c.borrow().len(), 1);
        gate.set(true);
        assert_eq!(first.as_mut().poll(&mut cx), Poll::Ready(Decision::Allow));
        assert_eq!(c.borrow().len(), 2);
    }

    #[test]
    fn roles_parse_strictly() {
        assert_eq!(Role::parse("viewer"), Some(Role::Viewer));
        assert_eq!(Role::parse("developer"), Some(Role::Developer));
        assert_eq!(Role::parse("admin"), None);
        assert_eq!(Role::parse("Developer"), None);
    }
}
