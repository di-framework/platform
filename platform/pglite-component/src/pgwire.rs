//! Postgres wire protocol over the blocking socket shim.
//!
//! Covers what `di-framework:pglite/database` needs: the startup handshake
//! (cleartext/MD5), the simple protocol for `exec`, and the extended
//! protocol (`Parse`/`Bind`/`Execute`/`Sync`) for parameterized
//! `run`/`query`/`first`. All values travel in text format.

use crate::exports::di_framework::pglite::types::{Error, PgError, Row, Value};
use crate::sock::Sock;

const PROTOCOL_VERSION: u32 = 196608; // 3.0

// Well-known type OIDs used for parameter inference and result decoding.
const OID_BOOL: u32 = 16;
const OID_BYTEA: u32 = 17;
const OID_INT8: u32 = 20;
const OID_INT2: u32 = 21;
const OID_INT4: u32 = 23;
const OID_TEXT: u32 = 25;
const OID_FLOAT4: u32 = 700;
const OID_FLOAT8: u32 = 701;

/// One live pgwire session: an authenticated TCP connection plus per-call
/// bookkeeping (`txn_depth`, `last_affected`).
pub struct Session {
    sock: Sock,
    buf: Vec<u8>,
}

fn conn_lost(msg: impl Into<String>) -> Error {
    Error::ConnectionLost(msg.into())
}

fn u32_at(buf: &[u8], off: usize) -> Result<u32, Error> {
    let mut v = 0u32;
    for i in 0..4usize {
        let b = buf
            .get(off + i)
            .copied()
            .ok_or_else(|| conn_lost("short message from server"))?;
        v = (v << 8) | u32::from(b);
    }
    Ok(v)
}

fn i32_at(buf: &[u8], off: usize) -> Result<i32, Error> {
    u32_at(buf, off).map(|v| v as i32)
}

fn i16_at(buf: &[u8], off: usize) -> Result<i16, Error> {
    let hi = buf
        .get(off)
        .copied()
        .ok_or_else(|| conn_lost("short message from server"))?;
    let lo = buf
        .get(off + 1)
        .copied()
        .ok_or_else(|| conn_lost("short message from server"))?;
    Ok(((i16::from(hi)) << 8) | i16::from(lo))
}

/// Read a NUL-terminated string starting at `off`; returns text and the
/// offset just past the terminator.
fn cstring_at(buf: &[u8], off: usize) -> Result<(String, usize), Error> {
    let mut end = off;
    while buf.get(end).is_some_and(|b| *b != 0) {
        end += 1;
    }
    let text = buf
        .get(off..end)
        .ok_or_else(|| conn_lost("short message from server"))?;
    Ok((String::from_utf8_lossy(text).to_string(), end + 1))
}

fn push_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn push_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn push_cstring(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.as_bytes());
    out.push(0);
}

/// Wrap a payload (without tag/length) in a frontend message.
fn framed(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 5);
    out.push(tag);
    let len = u32::try_from(payload.len() + 4).unwrap_or(u32::MAX);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn startup_message(user: &str, database: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&PROTOCOL_VERSION.to_be_bytes());
    for (key, val) in [
        ("user", user),
        ("database", database),
        ("client_encoding", "UTF8"),
        ("application_name", "pglite-provider-component"),
    ] {
        push_cstring(&mut body, key);
        push_cstring(&mut body, val);
    }
    body.push(0);
    let mut out = Vec::with_capacity(body.len() + 4);
    let len = u32::try_from(body.len() + 4).unwrap_or(u32::MAX);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&body);
    out
}

fn password_message(secret: &str) -> Vec<u8> {
    let mut payload = Vec::with_capacity(secret.len() + 1);
    push_cstring(&mut payload, secret);
    framed(b'p', &payload)
}

fn md5_password(password: &str, user: &str, salt: &[u8]) -> String {
    let mut first = Vec::new();
    first.extend_from_slice(password.as_bytes());
    first.extend_from_slice(user.as_bytes());
    let inner = format!("{:x}", md5::compute(first));
    let mut second = Vec::new();
    second.extend_from_slice(inner.as_bytes());
    second.extend_from_slice(salt);
    format!("md5{:x}", md5::compute(second))
}

/// Fields of an `ErrorResponse`: `(field code, text)`.
fn error_fields(body: &[u8]) -> Vec<(u8, String)> {
    let mut fields = Vec::new();
    let mut i = 0;
    while let Some(code) = buf_get(body, i) {
        if code == 0 {
            break;
        }
        let start = i + 1;
        let mut end = start;
        while buf_get(body, end).is_some_and(|b| b != 0) {
            end += 1;
        }
        if let Some(text) = body.get(start..end) {
            fields.push((code, String::from_utf8_lossy(text).to_string()));
        }
        i = end + 1;
    }
    fields
}

fn buf_get(buf: &[u8], i: usize) -> Option<u8> {
    buf.get(i).copied()
}

fn server_error(body: &[u8]) -> Error {
    let mut code = "unknown".to_string();
    let mut message = "postgres error".to_string();
    for (tag, text) in error_fields(body) {
        if tag == b'C' {
            code = text;
        } else if tag == b'M' {
            message = text;
        }
    }
    // Syntax and access problems are a client bug; everything else is a
    // failed execution on an otherwise healthy connection.
    if code.starts_with("42") {
        Error::InvalidSql(message)
    } else {
        Error::ExecutionFailed(PgError { code, message })
    }
}

impl Session {
    pub fn connect(
        host: &str,
        port: u16,
        user: &str,
        password: &str,
        database: &str,
    ) -> Result<Self, Error> {
        let sock = crate::sock::connect(host, port)
            .map_err(|m| Error::OpenFailed(format!("connect {host}:{port}: {m}")))?;
        let mut session = Self {
            sock,
            buf: Vec::new(),
        };
        let startup = startup_message(user, database);
        session
            .sock
            .write_all(&startup)
            .map_err(|m| Error::OpenFailed(format!("startup: {m}")))?;
        session.handshake(user, password)?;

        Ok(session)
    }

    /// Read one backend message: `(tag, body)` with the length word removed.
    fn next(&mut self) -> Result<(u8, Vec<u8>), Error> {
        self.fill(5)?;
        let tag = self
            .buf
            .first()
            .copied()
            .ok_or_else(|| conn_lost("empty message from server"))?;
        let len = u32_at(&self.buf, 1)? as usize;
        if len < 4 {
            return Err(conn_lost("invalid message length from server"));
        }
        let total = 1 + len;
        self.fill(total)?;
        let body = self
            .buf
            .get(5..total)
            .ok_or_else(|| conn_lost("short message from server"))?
            .to_vec();
        self.buf.drain(..total);
        Ok((tag, body))
    }

    fn fill(&mut self, need: usize) -> Result<(), Error> {
        while self.buf.len() < need {
            // Read only what is still missing: `read_exact` blocks until
            // its whole buffer is full, so a fixed-size scratch buffer
            // would hang whenever the server sends less than that.
            let mut chunk = vec![0u8; need - self.buf.len()];
            self.sock
                .read_exact(&mut chunk)
                .map_err(Error::ConnectionLost)?;
            self.buf.extend_from_slice(&chunk);
        }
        Ok(())
    }

    fn handshake(&mut self, user: &str, password: &str) -> Result<(), Error> {
        loop {
            let (tag, body) = self.next().map_err(|e| match e {
                Error::ConnectionLost(m) => Error::OpenFailed(m),
                other => other,
            })?;
            match tag {
                b'R' => {
                    let kind = i32_at(&body, 0)
                        .map_err(|_| Error::OpenFailed("short auth message".to_string()))?;
                    match kind {
                        0 => {}
                        3 => {
                            let msg = password_message(password);
                            self.sock
                                .write_all(&msg)
                                .map_err(|m| Error::OpenFailed(format!("password send: {m}")))?;
                        }
                        5 => {
                            let salt = body
                                .get(4..8)
                                .ok_or_else(|| Error::OpenFailed("short md5 salt".to_string()))?
                                .to_vec();
                            let secret = md5_password(password, user, &salt);
                            let msg = password_message(&secret);
                            self.sock
                                .write_all(&msg)
                                .map_err(|m| Error::OpenFailed(format!("password send: {m}")))?;
                        }
                        other => {
                            return Err(Error::OpenFailed(format!(
                                "unsupported auth method {other}"
                            )));
                        }
                    }
                }
                b'Z' => return Ok(()),
                b'E' => {
                    let message = match server_error(&body) {
                        Error::InvalidSql(text) => text,
                        Error::ExecutionFailed(pg) => pg.message,
                        other => format!("{other:?}"),
                    };
                    return Err(Error::OpenFailed(message));
                }
                _ => {}
            }
        }
    }

    /// Run the simple protocol (`Q`). Returns command tags plus any text
    /// rows (used by `SHOW`); results are otherwise discarded.
    pub fn simple(&mut self, sql: &str) -> Result<SimpleOut, Error> {
        let mut payload = Vec::with_capacity(sql.len() + 1);
        push_cstring(&mut payload, sql);
        let msg = framed(b'Q', &payload);
        self.sock.write_all(&msg).map_err(conn_lost)?;
        let mut out = SimpleOut::default();
        loop {
            let (tag, body) = self.next()?;
            match tag {
                b'T' => {
                    out.columns = describe_columns(&body)?;
                }
                b'D' => {
                    out.rows.push(decode_data_row(&body)?);
                }
                b'C' => {
                    let (text, _) = cstring_at(&body, 0)?;
                    out.tags.push(text);
                }
                b'E' => {
                    if out.error.is_none() {
                        out.error = Some(server_error(&body));
                    }
                }
                b'Z' => break,
                b'I' | b'N' | b'S' | b'K' | b'A' => {}
                _ => {}
            }
        }
        if let Some(err) = out.error {
            return Err(err);
        }
        Ok(out)
    }

    /// Run the extended protocol for one parameterized statement.
    pub fn extended(&mut self, sql: &str, params: &[Value]) -> Result<SimpleOut, Error> {
        let mut encoded: Vec<(u32, Option<Vec<u8>>)> = Vec::with_capacity(params.len());
        for param in params {
            encoded.push(encode_param(param)?);
        }

        let mut wire = Vec::new();
        // Parse (unnamed statement, explicit parameter OIDs).
        let mut parse = Vec::new();
        push_cstring(&mut parse, "");
        push_cstring(&mut parse, sql);
        push_u16(&mut parse, u16::try_from(encoded.len()).unwrap_or(u16::MAX));
        for (oid, _) in &encoded {
            push_u32(&mut parse, *oid);
        }
        wire.extend_from_slice(&framed(b'P', &parse));
        // Bind (unnamed portal, all text formats).
        let mut bind = Vec::new();
        push_cstring(&mut bind, "");
        push_cstring(&mut bind, "");
        push_u16(&mut bind, u16::try_from(encoded.len()).unwrap_or(u16::MAX));
        for _ in &encoded {
            push_u16(&mut bind, 0);
        }
        push_u16(&mut bind, u16::try_from(encoded.len()).unwrap_or(u16::MAX));
        for (_, bytes) in &encoded {
            match bytes {
                Some(raw) => {
                    push_i32(&mut bind, i32::try_from(raw.len()).unwrap_or(i32::MAX));
                    bind.extend_from_slice(raw);
                }
                None => push_i32(&mut bind, -1),
            }
        }
        push_u16(&mut bind, 0);
        wire.extend_from_slice(&framed(b'B', &bind));
        // Execute + Sync.
        let mut exec = Vec::new();
        push_cstring(&mut exec, "");
        push_u32(&mut exec, 0);
        wire.extend_from_slice(&framed(b'E', &exec));
        wire.extend_from_slice(&framed(b'S', &[]));

        self.sock.write_all(&wire).map_err(conn_lost)?;

        let mut out = SimpleOut::default();
        loop {
            let (tag, body) = self.next()?;
            match tag {
                b'T' => {
                    out.columns = describe_columns(&body)?;
                }
                b'D' => {
                    out.rows.push(decode_data_row(&body)?);
                }
                b'C' => {
                    let (text, _) = cstring_at(&body, 0)?;
                    out.tags.push(text);
                }
                b'E' => {
                    if out.error.is_none() {
                        out.error = Some(server_error(&body));
                    }
                }
                b'Z' => break,
                b'1' | b'2' | b'n' | b'N' | b'S' | b'K' | b'A' | b't' => {}
                _ => {}
            }
        }
        if let Some(err) = out.error {
            return Err(err);
        }
        Ok(out)
    }
}

#[derive(Default)]
pub struct SimpleOut {
    pub columns: Vec<(String, u32)>,
    pub rows: Vec<Vec<Option<String>>>,
    pub tags: Vec<String>,
    pub error: Option<Error>,
}

/// Parse a `DataRow` into raw optional text cells (conversion to `Value`
/// happens in `decode_row`, which pairs cells with column OIDs).
fn decode_data_row(body: &[u8]) -> Result<Vec<Option<String>>, Error> {
    let count = i16_at(body, 0)? as usize;
    let mut off = 2;
    let mut row = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        let len = i32_at(body, off)?;
        off += 4;
        if len < 0 {
            row.push(None);
        } else {
            let len = usize::try_from(len).map_err(|_| conn_lost("invalid column length"))?;
            let end = off
                .checked_add(len)
                .ok_or_else(|| conn_lost("invalid column range"))?;
            let part = body
                .get(off..end)
                .ok_or_else(|| conn_lost("short data row"))?;
            row.push(Some(String::from_utf8_lossy(part).to_string()));
            off = end;
        }
    }
    Ok(row)
}

/// Parse a `RowDescription` into `(column-name, type-oid)` pairs.
fn describe_columns(body: &[u8]) -> Result<Vec<(String, u32)>, Error> {
    let count = i16_at(body, 0)? as usize;
    let mut off = 2;
    let mut cols = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        let (name, after) = cstring_at(body, off)?;
        // table-oid(4) + attr-no(2) + type-oid(4) + type-len(2) + type-mod(4) + format(2)
        let oid = u32_at(body, after + 6)?;
        cols.push((name, oid));
        off = after + 18;
    }
    Ok(cols)
}

/// Convert one raw row into typed `Value`s using the column OIDs.
fn decode_row(
    raw: Vec<Option<String>>,
    columns: &[(String, u32)],
    index: usize,
) -> Result<Vec<(String, Value)>, Error> {
    let mut out = Vec::with_capacity(raw.len());
    for (i, cell) in raw.into_iter().enumerate() {
        let (name, oid) = columns
            .get(i)
            .map(|(n, o)| (n.clone(), *o))
            .unwrap_or_else(|| (format!("column{index}_{i}"), OID_TEXT));
        out.push((name, decode_cell(oid, cell)?));
    }
    Ok(out)
}

fn decode_cell(oid: u32, cell: Option<String>) -> Result<Value, Error> {
    let Some(text) = cell else {
        return Ok(Value::Null);
    };
    match oid {
        OID_BOOL => match text.as_str() {
            "t" | "true" | "TRUE" | "1" => Ok(Value::Boolean(true)),
            "f" | "false" | "FALSE" | "0" => Ok(Value::Boolean(false)),
            _ => Err(Error::ValueConversionFailed(format!(
                "invalid boolean {text:?}"
            ))),
        },
        OID_INT2 | OID_INT4 | OID_INT8 => text
            .parse::<i64>()
            .map(Value::Integer)
            .map_err(|_| Error::ValueConversionFailed(format!("invalid integer {text:?}"))),
        OID_FLOAT4 | OID_FLOAT8 => text
            .parse::<f64>()
            .map(Value::Real)
            .map_err(|_| Error::ValueConversionFailed(format!("invalid float {text:?}"))),
        OID_BYTEA => decode_bytea(&text),
        _ => Ok(Value::Text(text)),
    }
}

fn decode_bytea(text: &str) -> Result<Value, Error> {
    let hex = text
        .strip_prefix("\\x")
        .or_else(|| text.strip_prefix("\\X"));
    let Some(hex) = hex else {
        return Err(Error::ValueConversionFailed(
            "bytea is not in hex format (expected \\x...)".to_string(),
        ));
    };
    if hex.len() % 2 != 0 {
        return Err(Error::ValueConversionFailed(
            "odd-length bytea hex string".to_string(),
        ));
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(hex.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = pair
            .first()
            .copied()
            .and_then(unhex_digit)
            .ok_or_else(|| Error::ValueConversionFailed("invalid bytea hex".to_string()))?;
        let lo = pair
            .get(1)
            .copied()
            .and_then(unhex_digit)
            .ok_or_else(|| Error::ValueConversionFailed("invalid bytea hex".to_string()))?;
        out.push((hi << 4) | lo);
    }
    Ok(Value::Blob(out))
}

fn unhex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Encode a parameter as `(type-oid, text bytes or none for NULL)`.
fn encode_param(value: &Value) -> Result<(u32, Option<Vec<u8>>), Error> {
    match value {
        Value::Null => Ok((0, None)),
        Value::Integer(i) => Ok((OID_INT8, Some(i.to_string().into_bytes()))),
        Value::Real(f) => {
            if !f.is_finite() {
                return Err(Error::InvalidParams(
                    "non-finite floats cannot be sent as parameters".to_string(),
                ));
            }
            Ok((OID_FLOAT8, Some(f.to_string().into_bytes())))
        }
        Value::Text(s) => Ok((OID_TEXT, Some(s.as_bytes().to_vec()))),
        Value::Blob(bytes) => {
            let mut hex = Vec::with_capacity(bytes.len() * 2 + 2);
            hex.extend_from_slice(b"\\x");
            for byte in bytes.iter().copied() {
                hex.push(hex_digit(byte >> 4));
                hex.push(hex_digit(byte & 0x0f));
            }
            Ok((OID_BYTEA, Some(hex)))
        }
        Value::Boolean(true) => Ok((OID_BOOL, Some(b"TRUE".to_vec()))),
        Value::Boolean(false) => Ok((OID_BOOL, Some(b"FALSE".to_vec()))),
    }
}

fn hex_digit(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        _ => b'a' + (n - 10),
    }
}

/// Rows affected from a `CommandComplete` tag (`SELECT 3`, `INSERT 0 1`,
/// `UPDATE 2`, `DELETE 1`; DDL yields 0).
pub fn affected_from_tag(tag: &str) -> u64 {
    tag.split_whitespace()
        .next_back()
        .and_then(|last| last.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Build typed rows from an extended-protocol result.
pub fn to_rows(out: SimpleOut) -> Result<Vec<Row>, Error> {
    let mut rows = Vec::with_capacity(out.rows.len());
    for (i, raw) in out.rows.into_iter().enumerate() {
        rows.push(decode_row(raw, &out.columns, i)?);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_body(code: &str, message: &str) -> Vec<u8> {
        let mut body = Vec::new();
        body.push(b'C');
        body.extend_from_slice(code.as_bytes());
        body.push(0);
        body.push(b'M');
        body.extend_from_slice(message.as_bytes());
        body.push(0);
        body.push(0);
        body
    }

    #[test]
    fn command_tag_counts() {
        assert_eq!(affected_from_tag("SELECT 3"), 3);
        assert_eq!(affected_from_tag("INSERT 0 1"), 1);
        assert_eq!(affected_from_tag("UPDATE 2"), 2);
        assert_eq!(affected_from_tag("DELETE 1"), 1);
        assert_eq!(affected_from_tag("CREATE TABLE"), 0);
        assert_eq!(affected_from_tag("BEGIN"), 0);
    }

    #[test]
    fn error_mapping_by_sqlstate() {
        assert!(matches!(
            server_error(&error_body("42601", "syntax error")),
            Error::InvalidSql(_)
        ));
        match server_error(&error_body("23505", "duplicate key")) {
            Error::ExecutionFailed(pg) => assert_eq!(pg.code, "23505"),
            other => panic!("expected execution-failed, got {other:?}"),
        }
    }

    #[test]
    fn cell_decoding_by_oid() {
        assert!(matches!(
            decode_cell(OID_BOOL, Some("t".to_string())),
            Ok(Value::Boolean(true))
        ));
        assert!(matches!(
            decode_cell(OID_INT8, Some("42".to_string())),
            Ok(Value::Integer(42))
        ));
        assert!(matches!(
            decode_cell(OID_FLOAT8, Some("1.5".to_string())),
            Ok(Value::Real(_))
        ));
        assert!(matches!(
            decode_cell(OID_TEXT, Some("x".to_string())),
            Ok(Value::Text(_))
        ));
        assert!(matches!(
            decode_cell(999999, Some("x".to_string())),
            Ok(Value::Text(_))
        ));
        assert!(matches!(decode_cell(OID_TEXT, None), Ok(Value::Null)));
        assert!(matches!(
            decode_cell(OID_BYTEA, Some("\\x0102".to_string())),
            Ok(Value::Blob(_))
        ));
        assert!(matches!(
            decode_cell(OID_BOOL, Some("maybe".to_string())),
            Err(_)
        ));
    }
}
