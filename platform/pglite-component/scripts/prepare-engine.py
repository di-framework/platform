#!/usr/bin/env python3
"""Fetch pinned inputs and wrap PGlite's core module with a private WIT ABI.

The archive is built from pinned PostgreSQL 17.5 sources with full WASI
setjmp/longjmp recovery. No native runtime or network proxy is included in the component.
"""
import hashlib
from pathlib import Path
import re
import posixpath
import subprocess
import tarfile
import urllib.request

PKG = Path(__file__).resolve().parent.parent
OUT = PKG / "target/engine"
OUT.mkdir(parents=True, exist_ok=True)
PINS = {
    key: value
    for line in (PKG / "scripts/tool-versions.env").read_text().splitlines()
    if line and not line.startswith("#") and "=" in line
    for key, value in [line.split("=", 1)]
}


def fetch(url, name, digest):
    path = OUT / name
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        with urllib.request.urlopen(url) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f"checksum mismatch: {url}")
        path.write_bytes(data)
    return path


def run(*args):
    subprocess.run(args, check=True)


run("bash", str(PKG / "scripts/build-engine.sh"))
archive = OUT / "pglite-source.tar.xz"
adapter = fetch(PINS["PGLITE_ADAPTER_URL"], "adapter.wasm", PINS["PGLITE_ADAPTER_SHA256"])
stamp = hashlib.sha256(archive.read_bytes() + adapter.read_bytes() + Path(__file__).read_bytes()
                       + (PKG / "engine/bridge.wat").read_bytes()
                       + (PKG / "wit/deps/pglite-engine/engine.wit").read_bytes()
                       + subprocess.check_output(["wasm-tools", "--version"])).hexdigest()
if (OUT / "stamp").exists() and (OUT / "stamp").read_text() == stamp:
    raise SystemExit(0)

runtime = OUT / "runtime"
runtime.mkdir(exist_ok=True)
with tarfile.open(archive, "r:xz") as tar:
    for member in tar.getmembers():
        if member.isdir():
            continue
        if member.issym() or member.islnk():
            linked = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname)
                                       if member.issym() else member.linkname)
            if not linked.startswith("tmp/pglite/"):
                raise RuntimeError(f"unsafe archive link: {member.name}")
        elif not member.isfile():
            raise RuntimeError(f"unexpected archive member: {member.name}")
        name = member.name.removeprefix("tmp/pglite/")
        if name == member.name or ".." in Path(name).parts or Path(name).is_absolute():
            raise RuntimeError(f"unsafe archive member: {member.name}")
        target = runtime / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(tar.extractfile(member).read())

run("wasm-tools", "print", str(runtime / "bin/pglite.wasi"), "-o", str(OUT / "engine.wat"))
wat = (OUT / "engine.wat").read_text()
# Use WASI entropy instead of requiring a host /dev/urandom preopen.
wat, count = re.subn(r' {2}\(func \$pg_strong_random .*?\n {2}\)', '''  (func $pg_strong_random (param i32 i32) (result i32)
    local.get 0
    local.get 1
    call $__imported_wasi_snapshot_preview1_random_get
    i32.eqz
  )''', wat, count=1, flags=re.S)
assert count == 1, "engine pg_strong_random ABI changed"
# Bootstrap scripts live beside runtime/ and data/, both of which are used
# as cwd during initdb. Equal-length replacement preserves core data offsets.
# TMP_PREFIX is a WAT text pattern for the engine's baked-in bootstrap path,
# not a filesystem write: no publicly writable directory is created here.
TMP_PREFIX = "/tmp/"  # NOSONAR python:S5443 - WAT string constant, not a directory use.
for name in ("initdb.boot.txt", "initdb.single.txt"):
    assert wat.count(TMP_PREFIX + name) == 1  # NOSONAR python:S5443 - count of WAT string pattern.
    wat = wat.replace(TMP_PREFIX + name, "./../" + name)  # NOSONAR python:S5443 - WAT text rewrite.
wat, count = re.subn(r' {2}\(export "_start" \(func \$_start\)\)\n', '', wat)
assert count == 1
wat = wat.rstrip()[:-1] + (PKG / "engine/bridge.wat").read_text() + '\n)\n'
(OUT / "bridge.wat").write_text(wat)
run("wasm-tools", "component", "embed", str(PKG / "wit/deps/pglite-engine"),
    "--world", "embedded-engine", str(OUT / "bridge.wat"), "-o", str(OUT / "engine.core.wasm"))
run("wasm-tools", "component", "new", str(OUT / "engine.core.wasm"),
    "--adapt", f"wasi_snapshot_preview1={adapter}", "-o", str(OUT / "engine.wasm"))
run("wasm-tools", "validate", str(OUT / "engine.wasm"))
(OUT / "stamp").write_text(stamp)
