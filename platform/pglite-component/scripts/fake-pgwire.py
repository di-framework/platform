#!/usr/bin/env python3
"""Scripted pgwire server for `make smoke` (pglite-component).

Serves the startup handshake (AuthenticationOk + ReadyForQuery, no password
challenge) plus just enough of the simple (Q) and extended (P/B/E/S)
protocols for `tests/smoke-consumer`: SHOW server_version, DDL, INSERT …
RETURNING, SELECT, UPDATE, transaction verbs, and one syntax error.

Replies are sent with the header and body in separate writes so the provider's
partial-read path is exercised: the client must keep reading only what is
still missing, never assume a full frame arrives at once.

Usage: fake-pgwire.py --port-file <path>
Binds 127.0.0.1:0, writes the chosen port to <path>, then serves until killed.
"""

import argparse
import socket
import struct
import threading

VERSION = "17.5-fake"

# Well-known type OIDs (must match the provider's decoding table).
OID_BOOL = 16
OID_BYTEA = 17
OID_INT8 = 20
OID_TEXT = 25
OID_FLOAT8 = 701


def cstr(s):
    return s.encode() + b"\x00"


def frame(tag, body):
    return tag + struct.pack("!i", len(body) + 4) + body


def row_desc(cols):
    body = struct.pack("!h", len(cols))
    for name, oid in cols:
        body += (
            cstr(name)
            + struct.pack("!i", 0)  # table oid
            + struct.pack("!h", 0)  # attr number
            + struct.pack("!i", oid)
            + struct.pack("!h", -1)  # type length
            + struct.pack("!i", -1)  # type modifier
            + struct.pack("!h", 0)  # text format
        )
    return frame(b"T", body)


def data_row(cells):
    body = struct.pack("!h", len(cells))
    for cell in cells:
        if cell is None:
            body += struct.pack("!i", -1)
        else:
            raw = cell.encode()
            body += struct.pack("!i", len(raw)) + raw
    return frame(b"D", body)


def cmd(tag):
    return frame(b"C", cstr(tag))


def ready():
    return frame(b"Z", b"I")


def auth_ok():
    return frame(b"R", struct.pack("!i", 0))


def error(code, msg):
    return frame(b"E", b"S" + cstr("ERROR") + b"C" + cstr(code) + b"M" + cstr(msg) + b"\x00")


def parse_complete():
    return frame(b"1", b"")


def bind_complete():
    return frame(b"2", b"")


def read_n(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("eof")
        buf += chunk
    return buf


def read_startup(conn):
    (length,) = struct.unpack("!i", read_n(conn, 4))
    return read_n(conn, length - 4)


def read_msg(conn):
    tag = read_n(conn, 1)
    (length,) = struct.unpack("!i", read_n(conn, 4))
    return tag, read_n(conn, length - 4)


def get_cstr(buf, off):
    end = buf.index(b"\x00", off)
    return buf[off:end].decode(), end + 1


def send_split(conn, payload):
    """Send header and body separately so the client sees short reads."""
    conn.sendall(payload[:5])
    conn.sendall(payload[5:])


def answer_simple(sql):
    if "SHOW" in sql:
        chunks = [
            row_desc([("server_version", OID_TEXT)]),
            data_row([VERSION]),
            cmd("SHOW 1"),
        ]
    elif "COUNT" in sql.upper():
        chunks = [
            row_desc([("count", OID_INT8)]),
            data_row(["1"]),
            cmd("SELECT 1"),
        ]
    elif sql.lstrip().upper().startswith("SELECT"):
        chunks = [
            row_desc([("payload", OID_TEXT)]),
            data_row(["Hello World"]),
            cmd("SELECT 1"),
        ]
    else:
        first = sql.strip().split()[0].upper() if sql.strip() else ""
        tag = {
            "BEGIN": "BEGIN",
            "COMMIT": "COMMIT",
            "ROLLBACK": "ROLLBACK",
            "CREATE": "CREATE TABLE",
            "SET": "SET",
            "UPDATE": "UPDATE 1",
            "DELETE": "DELETE 1",
            "INSERT": "INSERT 0 1",
            "SAVEPOINT": "SAVEPOINT",
            "RELEASE": "RELEASE",
        }.get(first, "OK")
        chunks = [cmd(tag)]
    chunks.append(ready())
    return b"".join(chunks)


def answer_extended(sql):
    upper = sql.upper()
    if "SELEC NONSENSE" in upper:
        return error("42601", 'syntax error at or near "SELEC"') + ready()
    if "MISSING" in upper:
        return row_desc([("payload", OID_TEXT)]) + cmd("SELECT 0") + ready()
    if "RETURNING" in upper:
        return (
            parse_complete()
            + bind_complete()
            + row_desc([("id", OID_INT8)])
            + data_row(["1"])
            + cmd("INSERT 0 1")
            + ready()
        )
    if "SELECT" in upper or "COUNT" in upper:
        if "COUNT" in upper:
            table = (row_desc([("count", OID_INT8)]), data_row(["1"]), cmd("SELECT 1"))
        else:
            table = (
                row_desc([("payload", OID_TEXT)]),
                data_row(["Hello World"]),
                cmd("SELECT 1"),
            )
        return parse_complete() + bind_complete() + table[0] + table[1] + table[2] + ready()
    first = sql.strip().split()[0].upper() if sql.strip() else ""
    tag = {"UPDATE": "UPDATE 1", "DELETE": "DELETE 1", "INSERT": "INSERT 0 1"}.get(first, "OK")
    return parse_complete() + bind_complete() + cmd(tag) + ready()


def handle(conn):
    try:
        read_startup(conn)
        conn.sendall(auth_ok())
        send_split(conn, ready())
        pending_parse_sql = None
        while True:
            tag, body = read_msg(conn)
            if tag == b"X":
                break
            if tag == b"Q":
                sql, _ = get_cstr(body, 0)
                reply = answer_simple(sql)
                # Split mid-frame to force a short read on the client.
                mid = len(reply) // 2
                conn.sendall(reply[:mid])
                conn.sendall(reply[mid:])
            elif tag == b"P":
                _, off = get_cstr(body, 0)
                sql, _ = get_cstr(body, off)
                pending_parse_sql = sql
            elif tag == b"S":
                reply = answer_extended(pending_parse_sql or "")
                # Split mid-frame to force a short read on the client.
                mid = len(reply) // 2
                conn.sendall(reply[:mid])
                conn.sendall(reply[mid:])
                pending_parse_sql = None
            # Bind (B), Execute (E), Describe, Close, Flush, Sync-ack: no reply
            # needed until Sync; consumed silently here.
    except (ConnectionError, BrokenPipeError, ValueError):
        pass
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-file", required=True)
    args = parser.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(16)
    with open(args.port_file, "w") as f:
        f.write(str(server.getsockname()[1]))

    while True:
        conn, _ = server.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
