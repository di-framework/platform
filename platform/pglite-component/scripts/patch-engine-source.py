#!/usr/bin/env python3
"""Small component-specific changes on top of the pinned engine source recipe."""
from pathlib import Path
import sys

pkg = Path(__file__).resolve().parent.parent
source = Path(sys.argv[1])
p = source / "src/backend/libpq/pqcomm.c"
s = p.read_text()
marker = "/* di-framework: collect CMA replies"
start = s.index(marker) if marker in s else s.index("static int\ninternal_putbytes(const char *s, size_t len) {")
end = s.index("\nstatic int\nsocket_flush", start)
s = s[:start] + (pkg / "engine/reply-buffer.c").read_text() + "\n" + s[end:]
p.write_text(s)

# initdb and the application backend share a process. Override initdb's
# command-line defaults when starting either fresh or existing clusters.
p = source / "pglite-wasm/pg_main.c"
s = p.read_text()
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
p.write_text(s)

# The fresh-cluster path executes initdb's SQL one final time. Its last SET
# search_path survives that call, and WASM_PGOPTS resets the baseline to
# pg_catalog. Establish application defaults after all bootstrap work.
s = p.read_text()
marker = '  backend_started:;'
if '/* di-framework: application session defaults */' not in s:
    s = s.replace(marker, marker + '''
    /* di-framework: application session defaults */
    SetConfigOption("search_path", "\\\"$user\\\", public", PGC_USERSET, PGC_S_OVERRIDE);
    SetConfigOption("exit_on_error", "off", PGC_USERSET, PGC_S_OVERRIDE);
    SetConfigOption("ignore_invalid_pages", "off", PGC_POSTMASTER, PGC_S_OVERRIDE);
    ResetAllOptions();
''')
p.write_text(s)
