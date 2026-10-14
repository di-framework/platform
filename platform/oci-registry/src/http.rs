//! Response construction and request-body handling over `wasi:http@0.3.0`.

use crate::bindings;
use crate::{Fields, Request, Response};

/// Read a header's first value as a UTF-8 string.
pub(crate) fn header_str(headers: &Fields, name: &str) -> Option<String> {
    headers
        .get(name)
        .into_iter()
        .next()
        .and_then(|value| String::from_utf8(value).ok())
}

/// Consume the request body into memory.
pub(crate) async fn read_request_body(request: Request) -> Vec<u8> {
    // `res` lets the guest signal an error back upstream; we always succeed, so
    // dropping the writer resolves it to `Ok(())` via the default.
    let (res_tx, res_rx) = bindings::wit_future::new(|| Ok(()));
    let (body, _trailers) = Request::consume_body(request, res_rx);
    let data = body.collect().await;
    drop(res_tx);
    data
}

/// Build a response with borrowed header pairs.
pub(crate) fn respond(status: u16, headers: &[(&str, &str)], body: Vec<u8>) -> Response {
    let fields = Fields::new();
    for &(name, value) in headers {
        let _ = fields.append(name, value.as_bytes());
    }
    finish_response(status, fields, body)
}

/// Build a response with owned header pairs (used where header values are
/// computed `String`s).
pub(crate) fn respond_owned(
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Response {
    let fields = Fields::new();
    for (name, value) in &headers {
        let _ = fields.append(name, value.as_bytes());
    }
    finish_response(status, fields, body)
}

fn finish_response(status: u16, headers: Fields, body: Vec<u8>) -> Response {
    let (mut tx, rx) = bindings::wit_stream::new();
    let (trailers_tx, trailers_rx) = bindings::wit_future::new(|| Ok(None));
    wit_bindgen::spawn_local(async move {
        if !body.is_empty() {
            tx.write_all(body).await;
        }
        drop(tx);
        let _ = trailers_tx.write(Ok(None)).await;
    });
    let (response, _result) = Response::new(headers, Some(rx), trailers_rx);
    let _ = response.set_status_code(status);
    response
}

/// Build a response whose body is forwarded from an existing byte stream (e.g.
/// a blobstore `get-data` reader), so the payload is never buffered in the guest.
pub(crate) fn stream_response(
    status: u16,
    headers: Vec<(String, String)>,
    body: wit_bindgen::StreamReader<u8>,
) -> Response {
    let fields = Fields::new();
    for (name, value) in &headers {
        let _ = fields.append(name, value.as_bytes());
    }
    let (trailers_tx, trailers_rx) = bindings::wit_future::new(|| Ok(None));
    wit_bindgen::spawn_local(async move {
        let _ = trailers_tx.write(Ok(None)).await;
    });
    let (response, _result) = Response::new(fields, Some(body), trailers_rx);
    let _ = response.set_status_code(status);
    response
}

/// An OCI error body: `{"errors":[{"code":..,"message":..}]}`.
pub(crate) fn error_body(code: &str, message: &str) -> Vec<u8> {
    serde_json::json!({
        "errors": [{ "code": code, "message": message }]
    })
    .to_string()
    .into_bytes()
}

pub(crate) fn error_response(status: u16, code: &str, message: &str) -> Response {
    respond(
        status,
        &[("content-type", "application/json")],
        error_body(code, message),
    )
}

pub(crate) fn method_not_allowed() -> Response {
    error_response(405, "UNSUPPORTED", "method not allowed for this route")
}

/// Headers for a manifest or blob `GET`/`HEAD` response.
///
/// A `HEAD` response has an empty body and the runtime rejects a declared `content-length` with an
/// empty body, so `HEAD` carries the size in the `docker-content-length` side header instead (the
/// tenant controller restores `Content-Length` from it). `GET` carries a real `content-length`.
pub(crate) fn entity_headers(
    head: bool,
    content_type: String,
    digest: String,
    len: usize,
) -> Vec<(String, String)> {
    let length_header = if head {
        "docker-content-length"
    } else {
        "content-length"
    };
    vec![
        ("content-type".to_string(), content_type),
        ("docker-content-digest".to_string(), digest),
        (length_header.to_string(), len.to_string()),
    ]
}

#[cfg(test)]
mod entity_header_tests {
    use super::entity_headers;

    fn get<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn head_uses_side_header_and_no_content_length() {
        let h = entity_headers(true, "application/json".into(), "sha256:ab".into(), 1234);
        assert_eq!(get(&h, "docker-content-length"), Some("1234"));
        assert_eq!(get(&h, "content-length"), None);
        assert_eq!(get(&h, "content-type"), Some("application/json"));
        assert_eq!(get(&h, "docker-content-digest"), Some("sha256:ab"));
    }

    #[test]
    fn get_uses_content_length_and_no_side_header() {
        let h = entity_headers(
            false,
            "application/octet-stream".into(),
            "sha256:ab".into(),
            0,
        );
        assert_eq!(get(&h, "content-length"), Some("0"));
        assert_eq!(get(&h, "docker-content-length"), None);
    }
}
