#!/usr/bin/env bash
# Build pgcrypto into the WASI engine. Runs inside the engine builder container
# from wasm-build/build-ext.sh, after the PostgreSQL core is built and before
# pglite-wasm/build.sh links pglite.wasi (scripts/patch-engine-source.ts wires
# both hooks).
#
# The WASI engine has no dlopen, so pgcrypto is compiled to a static archive,
# linked into pglite.wasi next to plpgsql, and its SQL-callable symbols are
# resolved by the dlsym table generated below. pgcrypto 17 has no built-in
# crypto, so it links a static libcrypto from the pinned OpenSSL source that
# scripts/build-engine.ts verified and placed at $DF_EXT/openssl.tar.gz.
#
# Randomness: pgcrypto draws every salt, session key and padding byte from
# pg_strong_random, which prepare-engine.ts routes to WASI random_get. OpenSSL's
# own seed source on __wasi__ is getentropy, i.e. the same WASI import.
set -eo pipefail

# The SDK environment scripts are not nounset-clean; source them first.
. "${PGROOT:-/tmp/pglite}/pgopts.sh"
# shellcheck disable=SC1091
. "$SDKROOT/wasisdk/wasisdk_env.sh"
set -u

DF_EXT=${WORKSPACE:-/workspace}/df-extensions
SRC=$PGSRC/contrib/pgcrypto
OUT=$BUILD_PATH/contrib/pgcrypto
OSSL_PREFIX=$PG_BUILD/df-openssl
WASI_UPSTREAM=$SDKROOT/wasisdk/upstream

# Reproducibility (#267): OpenSSL's util/mkbuildinf.pl stamps "built on: <date>"
# into crypto/buildinf.h, which ends up in libcrypto.a and the engine wasm. It
# uses SOURCE_DATE_EPOCH when set, so require the value that
# scripts/build-engine.ts derives from the pinned engine source.
: "${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be set (scripts/build-engine.ts passes it)}"
export SOURCE_DATE_EPOCH

# --- OpenSSL libcrypto (static, wasm32-wasip1) ------------------------------
# Only what pgcrypto needs: no TLS sockets, threads, DSO/providers modules,
# engines, console UI, stdio or config autoloading. Its seed source on __wasi__
# is getentropy(), i.e. WASI random_get.
if [ ! -f "$OSSL_PREFIX/lib/libcrypto.a" ]; then
  rm -rf "$PG_BUILD/df-openssl-src"
  mkdir -p "$PG_BUILD/df-openssl-src"
  tar -xzf "$DF_EXT/openssl.tar.gz" -C "$PG_BUILD/df-openssl-src" --strip-components=1
  pushd "$PG_BUILD/df-openssl-src" >/dev/null
  CC="$WASI_UPSTREAM/bin/clang --target=wasm32-wasip1" \
  AR="$WASI_UPSTREAM/bin/llvm-ar" RANLIB="$WASI_UPSTREAM/bin/llvm-ranlib" \
  ./Configure linux-generic32 --prefix="$OSSL_PREFIX" --libdir=lib \
    --with-rand-seed=getrandom \
    no-asm no-shared no-module no-dso no-threads no-thread-pool no-async \
    no-sock no-dgram no-quic no-http no-ktls no-afalgeng no-ui-console \
    no-tests no-apps no-docs no-engine no-secure-memory no-posix-io no-stdio \
    no-autoload-config no-atexit no-egd \
    -Oz -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
    -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID >/dev/null
  # Two separate make runs. OpenSSL writes generated headers such as
  # opensslv.h and safestack.h through a shell redirect, and its object rules
  # do not depend on them until `make depend` has run. One parallel run with
  # both goals compiles crypto/*.c while those headers are still empty or
  # half written. The build then fails at random with "OPENSSL_API_COMPAT
  # expresses an impossible API compatibility level" or "STACK_OF(BIGNUM)"
  # undefined (#265). OpenSSL's own build_libs target runs these two steps
  # one after the other in the same way.
  make build_generated >/dev/null
  make -j"$(nproc)" libcrypto.a >/dev/null
  # Fail if a future OpenSSL stops honoring SOURCE_DATE_EPOCH: the build date
  # must be the pinned one, not the wall clock.
  want="built on: $(perl -e 'print scalar gmtime($ARGV[0])' "$SOURCE_DATE_EPOCH") UTC"
  grep -qF "\"$want\"" crypto/buildinf.h || {
    echo "openssl: crypto/buildinf.h does not carry '$want'" >&2
    grep -F 'built on' crypto/buildinf.h >&2 || true
    exit 1
  }
  mkdir -p "$OSSL_PREFIX/lib"
  cp libcrypto.a "$OSSL_PREFIX/lib/"
  rm -rf "$OSSL_PREFIX/include"
  cp -R include "$OSSL_PREFIX/include"
  popd >/dev/null
  rm -rf "$PG_BUILD/df-openssl-src"
fi

# --- pgcrypto objects -> libpgcrypto.a --------------------------------------
# The build tree's Makefile compiles with the same flags as the core
# (sjlj/exnref, WASI emulation); only the OpenSSL headers are added.
OBJS=$(sed -n '/^OBJS = /,/^$/p' "$SRC/Makefile" | grep -o '[a-z0-9-]*\.o' | grep -v WIN32RES)
[ -n "$OBJS" ] || { echo "pgcrypto: no objects found in $SRC/Makefile" >&2; exit 1; }
# shellcheck disable=SC2086
WASI_CFLAGS="$CC_PGLITE" make -C "$OUT" PORTNAME=wasi wasi=1 \
  PG_CPPFLAGS="-I$OSSL_PREFIX/include" $OBJS >/dev/null

# --- dlsym table ------------------------------------------------------------
# Every C symbol pgcrypto's install script binds with 'MODULE_PATHNAME', plus
# its fmgr info record. Declarations match the definitions exactly so wasm-ld
# never substitutes a signature-mismatch trap stub.
SYMS=$(sed -n "s/.*'MODULE_PATHNAME', *'\([a-z0-9_]*\)'.*/\1/p" "$SRC"/pgcrypto--*.sql | sort -u)
[ -n "$SYMS" ] || { echo "pgcrypto: no MODULE_PATHNAME symbols found" >&2; exit 1; }
{
  echo '/* Generated by build-pgcrypto.sh: static dlsym table for pgcrypto. */'
  echo '#include "postgres.h"'
  echo '#include "fmgr.h"'
  echo '#include <string.h>'
  for s in $SYMS; do
    echo "extern Datum $s(PG_FUNCTION_ARGS);"
    echo "extern const Pg_finfo_record *pg_finfo_$s(void);"
  done
  echo 'static const struct { const char *name; void *addr; } df_pgcrypto_syms[] = {'
  for s in $SYMS; do
    echo "  {\"$s\", (void *) $s},"
    echo "  {\"pg_finfo_$s\", (void *) pg_finfo_$s},"
  done
  echo '};'
  echo 'static const char df_pgcrypto_handle = 0;'
  cat <<'C'
static int
df_ends_with(const char *s, const char *suffix)
{
	size_t		ls = strlen(s);
	size_t		lx = strlen(suffix);

	return ls >= lx && strcmp(s + ls - lx, suffix) == 0;
}

/* dlopen hook: a non-NULL handle for the statically linked pgcrypto. */
void *
df_ext_dlopen(const char *filename)
{
	return filename && df_ends_with(filename, "/pgcrypto.so") ?
		(void *) &df_pgcrypto_handle : NULL;
}

/* dlsym hook: pgcrypto's SQL-callable functions and fmgr info records. */
void *
df_ext_dlsym(const char *symbol)
{
	for (size_t i = 0; i < sizeof(df_pgcrypto_syms) / sizeof(df_pgcrypto_syms[0]); i++)
		if (strcmp(df_pgcrypto_syms[i].name, symbol) == 0)
			return df_pgcrypto_syms[i].addr;
	return NULL;
}
C
} > "$OUT/df_ext_dlfcn.c"
WASI_CFLAGS="$CC_PGLITE" make -C "$OUT" PORTNAME=wasi wasi=1 df_ext_dlfcn.o >/dev/null

rm -f "$OUT/libpgcrypto.a"
# shellcheck disable=SC2086
(cd "$OUT" && "$WASI_UPSTREAM/bin/llvm-ar" rcs libpgcrypto.a $OBJS df_ext_dlfcn.o)

# --- runtime files ----------------------------------------------------------
# internal_load_library() stat()s $libdir/pgcrypto.so before dlopen, so ship an
# empty placeholder; the code itself is inside pglite.wasi.
EXT_DIR=$PGROOT/share/postgresql/extension
mkdir -p "$EXT_DIR" "$PGROOT/lib/postgresql"
cp "$SRC/pgcrypto.control" "$SRC"/pgcrypto--*.sql "$EXT_DIR/"
: > "$PGROOT/lib/postgresql/pgcrypto.so"
echo "pgcrypto: $(echo "$SYMS" | wc -l) functions, libpgcrypto.a + libcrypto.a ready"
