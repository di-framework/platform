#!/usr/bin/env python3
"""Small component-specific changes on top of the pinned engine source recipe."""
from pathlib import Path
import sys

# Only these two engine sources may be patched. Any other relative path is
# rejected so a bad CLI argument cannot escape the source tree (S2083/S8707).
ALLOWED_RELATIVE_FILES = frozenset(
    {
        "src/backend/libpq/pqcomm.c",
        "pglite-wasm/pg_main.c",
    }
)


def resolve_source_arg(argv: list[str]) -> Path:
    """Validate the engine source directory passed on the command line."""
    if len(argv) != 2 or not argv[1] or argv[1] in ("-h", "--help"):
        raise SystemExit(f"usage: {Path(argv[0]).name} <engine-source-dir>")
    candidate = Path(argv[1])
    # Resolve against cwd so relative args stay anchored; absolute args are
    # used as-is. Containment is enforced per-file by checked() below.
    resolved = candidate.resolve() if candidate.is_absolute() else (Path.cwd() / candidate).resolve()
    if not resolved.is_dir():
        raise SystemExit(f"source dir does not exist: {resolved}")
    return resolved


def checked(source: Path, relative: str) -> Path:
    """Join an allowlisted relative file and verify it stays inside source."""
    if relative not in ALLOWED_RELATIVE_FILES:
        raise SystemExit(f"refusing unexpected relative path: {relative!r}")
    resolved = (source / relative).resolve()
    try:
        inside = resolved.is_relative_to(source)
    except AttributeError:  # Python < 3.9 fallback
        inside = str(resolved).startswith(str(source) + "/")
    if not inside or resolved == source:
        raise SystemExit(f"refusing path outside source dir: {relative!r}")
    return resolved


pkg = Path(__file__).resolve().parent.parent
source = resolve_source_arg(sys.argv)
p = checked(source, "src/backend/libpq/pqcomm.c")
s = p.read_text()  # NOSONAR - p is allowlisted and containment-checked in checked().
marker = "/* di-framework: collect CMA replies"
start = s.index(marker) if marker in s else s.index("static int\ninternal_putbytes(const char *s, size_t len) {")
end = s.index("\nstatic int\nsocket_flush", start)
s = s[:start] + (pkg / "engine/reply-buffer.c").read_text() + "\n" + s[end:]
p.write_text(s)  # NOSONAR - p is allowlisted and containment-checked in checked().

# initdb and the application backend share a process. Override initdb's
# command-line defaults when starting either fresh or existing clusters.
p = checked(source, "pglite-wasm/pg_main.c")
s = p.read_text()  # NOSONAR - p is allowlisted and containment-checked in checked().
start = s.index('     void pgl_backend()')
end = s.index('  backend_started:;', start)
body = s[start:end]
old = '"-F", "-O", "-j",'
new = '''"-O", "-j",
            "-c", "search_path=\\\"$user\\\", public",
            "-c", "fsync=on",
            "-c", "synchronous_commit=on",
            "-c", "full_page_writes=on",'''
if old in body:
    assert body.count(old) == 2
    s = s[:start] + body.replace(old, new) + s[end:]
p.write_text(s)  # NOSONAR - p is allowlisted and containment-checked in checked().

# The fresh-cluster path executes initdb's SQL one final time. Its last SET
# search_path survives that call, and WASM_PGOPTS resets the baseline to
# pg_catalog. Establish application defaults after all bootstrap work.
s = p.read_text()  # NOSONAR - p is allowlisted and containment-checked in checked().
marker = '  backend_started:;'
if '/* di-framework: application session defaults */' not in s:
    s = s.replace(marker, marker + '''
    /* di-framework: application session defaults */
    SetConfigOption("search_path", "\\\"$user\\\", public", PGC_USERSET, PGC_S_OVERRIDE);
    SetConfigOption("exit_on_error", "off", PGC_USERSET, PGC_S_OVERRIDE);
    SetConfigOption("ignore_invalid_pages", "off", PGC_POSTMASTER, PGC_S_OVERRIDE);
    ResetAllOptions();
''')
p.write_text(s)  # NOSONAR - p is allowlisted and containment-checked in checked().
