//! Postgres message encoding over the embedded engine’s memory transport.
//!
//! Covers what `di-framework:pglite/database` needs: the startup handshake
//! (cleartext/MD5), the simple protocol for `exec`, and the extended
//! protocol (`Parse`/`Bind`/`Execute`/`Sync`) for parameterized
//! `run`/`query`/`first`. All values travel in text format.

use crate::engine::Transport;
use crate::exports::di_framework::pglite::types::{Error, PgError, Row, Value};

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
const OID_JSON: u32 = 114;
const OID_JSONB: u32 = 3802;
const OID_TIMESTAMP_TZ: u32 = 1184;

/// One exclusive session on the embedded engine.
pub struct Session {
    sock: Transport,
    buf: Vec<u8>,
    ready: u8,
    authenticated: bool,
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
        // Pin text output formats so decoded values are unambiguous.
        ("DateStyle", "ISO"),
        ("TimeZone", "UTC"),
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

/// PostgreSQL wire-protocol MD5 challenge response (RFC 1321 via `md5` crate).
///
/// This is **not** password storage: the server sends a 4-byte salt during the
/// startup handshake and mandates `md5(password + user) + salt` as the reply
/// when it selects auth method 5. We compute it transiently and never persist
/// the digest. SCRAM is unsupported by this embedded engine build, so MD5 is
/// protocol-required, not a chosen KDF. Changing it would break the handshake.
fn md5_password(password: &str, user: &str, salt: &[u8]) -> String {
    let mut first = Vec::new();
    first.extend_from_slice(password.as_bytes());
    first.extend_from_slice(user.as_bytes());
    let inner = format!("{:x}", md5::compute(first)); // NOSONAR -- PG-wire mandated challenge response, not password storage
    let mut second = Vec::new();
    second.extend_from_slice(inner.as_bytes());
    second.extend_from_slice(salt);
    format!("md5{:x}", md5::compute(second)) // NOSONAR -- PG-wire mandated challenge response, not password storage
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
    // Only 42601 (syntax error) and 42P18 (un-inferable parameter type) are
    // invalid-sql; every other class-42 code (42501, 42P01, 42703, ...) is an
    // execution-failed carrying its SQLSTATE.
    if code == "42601" || code == "42P18" {
        // 42601: syntax_error
        // 42P18: indeterminate_datatype (parameter needs a cast)
        Error::InvalidSql(message)
    } else if code.starts_with("25") || code.starts_with("3B") {
        Error::InvalidTransactionState(message)
    } else if code == "08P01" {
        Error::InvalidParams(message)
    } else {
        Error::ExecutionFailed(PgError { code, message })
    }
}

impl Session {
    pub fn connect(path: &str, database: &str) -> Result<Self, Error> {
        let (sock, password) = Transport::open(path, database).map_err(Error::OpenFailed)?;
        let fresh = sock.fresh;
        let mut session = Self {
            sock,
            buf: Vec::new(),
            ready: b'I',
            authenticated: false,
        };
        if fresh {
            session
                .sock
                .write_all(&startup_message("postgres", database))
                .map_err(Error::OpenFailed)?;
            session.handshake("postgres", &password)?;
        }
        session.sock.mark_healthy();
        session.authenticated = true;
        // `close` runs DISCARD ALL and a reused backend never sees a startup
        // packet, so pin the text output formats on every open.
        session.simple("SET DateStyle = 'ISO, MDY'")?;
        session.simple("SET TimeZone = 'UTC'")?;
        Ok(session)
    }

    pub fn in_transaction(&self) -> bool {
        self.ready != b'I'
    }

    fn set_ready(&mut self, body: &[u8]) -> Result<(), Error> {
        match body {
            [state @ (b'I' | b'T' | b'E')] => {
                self.ready = *state;
                Ok(())
            }
            _ => {
                self.sock.poison();
                Err(conn_lost("invalid transaction status from engine"))
            }
        }
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if !self.authenticated {
            return Ok(());
        }
        self.authenticated = false;
        let result = (|| {
            if self.in_transaction() {
                self.simple("ROLLBACK")?;
            }
            self.simple("DISCARD ALL")?;
            Ok(())
        })();
        if result.is_err() {
            self.sock.poison();
        }
        result
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
        let mut authenticated = false;
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
                        0 => authenticated = true,
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
                b'Z' if authenticated => {
                    self.set_ready(&body)?;
                    return Ok(());
                }
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
        if sql.contains('\0') {
            return Err(Error::InvalidSql("SQL contains NUL".into()));
        }
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
                b'Z' => {
                    self.set_ready(&body)?;
                    break;
                }
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
        if sql.contains('\0') {
            return Err(Error::InvalidSql("SQL contains NUL".into()));
        }
        if params.len() > u16::MAX as usize {
            return Err(Error::InvalidParams("too many parameters".into()));
        }
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
        // Describe the bound portal so SELECT/RETURNING include column types.
        wire.extend_from_slice(&framed(b'D', &[b'P', 0]));
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
                b'Z' => {
                    self.set_ready(&body)?;
                    break;
                }
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
        OID_JSON | OID_JSONB => Ok(Value::Json(text)),
        OID_TIMESTAMP_TZ => Ok(decode_timestamptz(text)),
        _ => Ok(Value::Text(text)),
    }
}

/// Decode a `timestamptz` cell.
///
/// `connect` pins `DateStyle=ISO` and `TimeZone=UTC`, but a caller can change
/// either with `SET` for the rest of the session, so the cell is parsed rather
/// than trusted. Any ISO rendering (`2024-01-15 10:30:00.5+00`, or
/// `2024-01-15 05:30:00.5-05` after `SET TimeZone`) is converted to RFC 3339
/// in UTC (`2024-01-15T10:30:00.5Z`). `infinity` and `-infinity` stay
/// `Value::Timestamp`. Anything else (a non-ISO `DateStyle`, BC dates, years
/// after 9999) cannot be normalized and is returned as `Value::Text`, exactly
/// as PostgreSQL printed it. So a `Value::Timestamp` is always RFC 3339 in UTC
/// or one of the two infinities.
fn decode_timestamptz(text: String) -> Value {
    if text == "infinity" || text == "-infinity" {
        return Value::Timestamp(text);
    }
    match iso_timestamptz_to_utc(&text) {
        Some(utc) => Value::Timestamp(utc),
        None => Value::Text(text),
    }
}

/// Parse `YYYY-MM-DD HH:MM:SS[.ffffff]±HH[:MM[:SS]]` (PostgreSQL's ISO output
/// for `timestamptz`) and render it as `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`.
/// Returns `None` for any other shape or when the UTC year is outside 1..=9999.
fn iso_timestamptz_to_utc(text: &str) -> Option<String> {
    let mut cur = Cursor(text.as_bytes());
    let year = cur.digits(4)?;
    cur.byte(b'-')?;
    let month = cur.digits(2)?;
    cur.byte(b'-')?;
    let day = cur.digits(2)?;
    cur.byte(b' ')?;
    let hour = cur.digits(2)?;
    cur.byte(b':')?;
    let minute = cur.digits(2)?;
    cur.byte(b':')?;
    let second = cur.digits(2)?;
    let fraction = cur.fraction()?;
    let sign = match cur.take()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let offset_hours = cur.digits(2)?;
    let offset_minutes = cur.optional_field()?;
    let offset_seconds = cur.optional_field()?;
    if !cur.0.is_empty()
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
        || offset_minutes > 59
        || offset_seconds > 59
    {
        return None;
    }
    let offset = sign * (offset_hours * 3600 + offset_minutes * 60 + offset_seconds);
    let local = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    let utc = local - offset;
    let (year, month, day) = civil_from_days(utc.div_euclid(86_400));
    if !(1..=9999).contains(&year) {
        return None;
    }
    let secs = utc.rem_euclid(86_400);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}{fraction}Z",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    ))
}

/// A forward-only reader over the bytes of a timestamp literal.
struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn take(&mut self) -> Option<u8> {
        let (&first, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(first)
    }

    fn byte(&mut self, expected: u8) -> Option<()> {
        match self.0.split_first() {
            Some((&first, rest)) if first == expected => {
                self.0 = rest;
                Some(())
            }
            _ => None,
        }
    }

    /// Exactly `count` ASCII digits, as a number.
    fn digits(&mut self, count: usize) -> Option<i64> {
        let (head, rest) = self.0.split_at_checked(count)?;
        let mut value = 0;
        for &b in head {
            if !b.is_ascii_digit() {
                return None;
            }
            value = value * 10 + i64::from(b - b'0');
        }
        self.0 = rest;
        Some(value)
    }

    /// `:NN`, or 0 when the next byte is not `:` (offset minutes and seconds).
    fn optional_field(&mut self) -> Option<i64> {
        if self.byte(b':').is_some() {
            self.digits(2)
        } else {
            Some(0)
        }
    }

    /// An optional `.` and 1 to 6 digits, returned with the dot (or empty).
    fn fraction(&mut self) -> Option<&'a str> {
        let start = self.0;
        if self.byte(b'.').is_none() {
            return Some("");
        }
        let len = self.0.iter().take_while(|b| b.is_ascii_digit()).count();
        if !(1..=6).contains(&len) {
            return None;
        }
        self.0 = self.0.get(len..)?;
        std::str::from_utf8(start.get(..=len)?).ok()
    }
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 in the proleptic Gregorian calendar
/// (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Inverse of [`days_from_civil`]: `(year, month, day)`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
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
    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
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
        Value::Text(s) => {
            if s.contains('\0') {
                return Err(Error::InvalidParams(
                    "PostgreSQL text cannot contain NUL".into(),
                ));
            }
            Ok((0, Some(s.as_bytes().to_vec())))
        }
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
        Value::Json(s) => {
            if s.contains('\0') {
                return Err(Error::InvalidParams(
                    "PostgreSQL json cannot contain NUL".into(),
                ));
            }
            Ok((0, Some(s.as_bytes().to_vec())))
        }
        Value::Timestamp(s) => {
            if s.contains('\0') {
                return Err(Error::InvalidParams(
                    "PostgreSQL timestamp cannot contain NUL".into(),
                ));
            }
            Ok((0, Some(s.as_bytes().to_vec())))
        }
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

impl Drop for Session {
    fn drop(&mut self) {
        // Keep the engine alive, but never leak an open transaction or session
        // settings into the next WIT resource. No Terminate message: it would
        // shut down the sole embedded backend.
        let _ = self.close();
    }
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
        // 42601 (syntax_error) and 42P18 (indeterminate_datatype) map to invalid-sql
        assert!(matches!(
            server_error(&error_body("42601", "syntax error")),
            Error::InvalidSql(_)
        ));
        assert!(matches!(
            server_error(&error_body("42P18", "could not determine data type")),
            Error::InvalidSql(_)
        ));
        // Other 42xxx codes map to execution-failed with the code preserved
        match server_error(&error_body("42P01", "relation does not exist")) {
            Error::ExecutionFailed(pg) => assert_eq!(pg.code, "42P01"),
            other => panic!("expected execution-failed for 42P01, got {other:?}"),
        }
        match server_error(&error_body("42703", "column does not exist")) {
            Error::ExecutionFailed(pg) => assert_eq!(pg.code, "42703"),
            other => panic!("expected execution-failed for 42703, got {other:?}"),
        }
        match server_error(&error_body("42501", "permission denied")) {
            Error::ExecutionFailed(pg) => assert_eq!(pg.code, "42501"),
            other => panic!("expected execution-failed for 42501, got {other:?}"),
        }
        match server_error(&error_body("23505", "duplicate key")) {
            Error::ExecutionFailed(pg) => assert_eq!(pg.code, "23505"),
            other => panic!("expected execution-failed for 23505, got {other:?}"),
        }
    }

    #[test]
    fn param_encoding_text_uses_oid_zero() {
        let (oid, bytes) = encode_param(&Value::Text("hello".to_string())).expect("encode text");
        assert_eq!(oid, 0, "text parameters should use OID 0 (unknown)");
        assert_eq!(bytes, Some(b"hello".to_vec()));
    }

    #[test]
    fn param_encoding_json_and_timestamp() {
        let (oid, bytes) =
            encode_param(&Value::Json(r#"{"key":"value"}"#.to_string())).expect("encode json");
        assert_eq!(oid, 0);
        assert_eq!(bytes, Some(r#"{"key":"value"}"#.as_bytes().to_vec()));

        let (oid, bytes) = encode_param(&Value::Timestamp("2024-01-01T12:00:00Z".to_string()))
            .expect("encode timestamp");
        assert_eq!(oid, 0);
        assert_eq!(bytes, Some("2024-01-01T12:00:00Z".as_bytes().to_vec()));
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
            decode_cell(OID_JSON, Some(r#"{"key":"value"}"#.to_string())),
            Ok(Value::Json(_))
        ));
        assert!(matches!(
            decode_cell(OID_JSONB, Some(r#"{"key": "value"}"#.to_string())),
            Ok(Value::Json(_))
        ));
        assert!(matches!(
            decode_cell(OID_TIMESTAMP_TZ, Some("2024-01-01 12:00:00+00".to_string())),
            Ok(Value::Timestamp(t)) if t == "2024-01-01T12:00:00Z"
        ));
        assert!(matches!(
            decode_cell(OID_TIMESTAMP_TZ, Some("2024-01-01 12:00:00.25+00".to_string())),
            Ok(Value::Timestamp(t)) if t == "2024-01-01T12:00:00.25Z"
        ));
        for lit in ["infinity", "-infinity"] {
            assert!(matches!(
                decode_cell(OID_TIMESTAMP_TZ, Some(lit.to_string())),
                Ok(Value::Timestamp(t)) if t == lit
            ));
        }
        assert!(matches!(
            decode_cell(OID_TIMESTAMP_TZ, Some("0044-03-15 00:00:00+00 BC".to_string())),
            Ok(Value::Text(t)) if t == "0044-03-15 00:00:00+00 BC"
        ));
        assert!(matches!(
            decode_cell(1114, Some("2024-01-01 12:00:00".to_string())),
            Ok(Value::Text(_))
        ));
        assert!(decode_cell(OID_BOOL, Some("maybe".to_string())).is_err());
    }

    fn timestamptz(text: &str) -> Value {
        decode_cell(OID_TIMESTAMP_TZ, Some(text.to_string())).expect("timestamptz decodes")
    }

    fn assert_timestamp(input: &str, expected: &str) {
        match timestamptz(input) {
            Value::Timestamp(t) => assert_eq!(t, expected, "{input}"),
            other => panic!("{input}: expected Timestamp({expected}), got {other:?}"),
        }
    }

    fn assert_text(input: &str) {
        match timestamptz(input) {
            Value::Text(t) => assert_eq!(t, input),
            other => panic!("{input}: expected Text, got {other:?}"),
        }
    }

    #[test]
    fn timestamptz_after_set_timezone_is_converted_to_utc() {
        // `SET TimeZone` with DateStyle ISO prints the session offset.
        assert_timestamp("2024-01-15 05:30:00.5-05", "2024-01-15T10:30:00.5Z");
        assert_timestamp(
            "2024-01-15 16:00:00.123456+05:30",
            "2024-01-15T10:30:00.123456Z",
        );
        // A negative half-hour offset (America/St_Johns) subtracts its minutes too.
        assert_timestamp("2024-01-15 07:00:00-03:30", "2024-01-15T10:30:00Z");
        // LMT offsets carry seconds (Europe/Amsterdam before 1937).
        assert_timestamp("1900-01-01 00:19:32+00:19:32", "1900-01-01T00:00:00Z");
        // Offsets that cross day, month, year and leap-day boundaries.
        assert_timestamp("2024-01-01 01:00:00+02", "2023-12-31T23:00:00Z");
        assert_timestamp("2023-12-31 20:00:00-05", "2024-01-01T01:00:00Z");
        assert_timestamp("2024-02-28 22:00:00-03", "2024-02-29T01:00:00Z");
        assert_timestamp("2024-03-01 01:00:00+02", "2024-02-29T23:00:00Z");
        assert_timestamp("2023-03-01 01:00:00+02", "2023-02-28T23:00:00Z");
        assert_timestamp("2000-02-29 12:00:00+00", "2000-02-29T12:00:00Z");
        assert_timestamp("9999-12-31 18:00:00-05", "9999-12-31T23:00:00Z");
        assert_timestamp("0001-01-01 00:00:00+00", "0001-01-01T00:00:00Z");
    }

    #[test]
    fn timestamptz_that_cannot_be_normalized_is_text() {
        for input in [
            // `SET DateStyle` to SQL, Postgres and German.
            "15/01/2024 05:30:00.5 EST",
            "01/15/2024 10:30:00.5 UTC",
            "Mon Jan 15 10:30:00.5 2024 UTC",
            "15.01.2024 10:30:00.5 UTC",
            // BC dates and years RFC 3339 cannot hold, before or after the offset.
            "0044-03-15 00:00:00+00 BC",
            "10000-01-01 00:00:00+00",
            "0001-01-01 00:00:00+01",
            "9999-12-31 23:00:00-02",
            // Not a valid ISO timestamptz.
            "2024-01-15 10:30:00",
            "2024-01-15T10:30:00+00",
            "2024-13-01 00:00:00+00",
            "2023-02-29 00:00:00+00",
            "2024-01-15 24:00:00+00",
            "2024-01-15 10:30:00.+00",
            "2024-01-15 10:30:00.1234567+00",
            "2024-01-15 10:30:00+0",
            "2024-01-15 10:30:00+00:60",
            "2024-01-15 10:30:00+00:00:00 ",
            "",
        ] {
            assert_text(input);
        }
    }
}
