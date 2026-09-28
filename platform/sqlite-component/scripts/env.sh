# Sourced by build.sh / compose.sh (and usable interactively:
#   `. scripts/env.sh`) to put the pinned tools on PATH and export the
# variables the Rust build needs. Prefers the hermetic .tools/ install; falls
# back to whatever is on PATH so a developer with rustup/wasm-tools/wac already
# installed can build without running install-tools.sh --rust.

# Works when sourced from bash or zsh.
if [ -n "${BASH_SOURCE:-}" ]; then
  _df_env_src="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_VERSION:-}" ]; then
  eval '_df_env_src="${(%):-%x}"'
else
  _df_env_src="$0"
fi
_df_pkg_dir="$(cd "$(dirname "$_df_env_src")/.." && pwd)"
unset _df_env_src
# shellcheck source=tool-versions.env
. "$_df_pkg_dir/scripts/tool-versions.env"

DF_SQLITE_TOOLS_DIR="${DF_SQLITE_TOOLS_DIR:-$_df_pkg_dir/.tools}"
export DF_SQLITE_TOOLS_DIR

if [ -d "$DF_SQLITE_TOOLS_DIR/bin" ]; then
  export PATH="$DF_SQLITE_TOOLS_DIR/bin:$PATH"
fi

# Hermetic rustup (only when installed via install-tools.sh --rust and the
# caller has not pointed at their own).
if [ -x "$DF_SQLITE_TOOLS_DIR/cargo/bin/cargo" ] && [ -z "${RUSTUP_HOME:-}" ]; then
  export RUSTUP_HOME="$DF_SQLITE_TOOLS_DIR/rustup"
  export CARGO_HOME="$DF_SQLITE_TOOLS_DIR/cargo"
  export PATH="$DF_SQLITE_TOOLS_DIR/cargo/bin:$PATH"
fi

# wasi-sdk: WASI_SDK_PATH wins, then the hermetic copy.
if [ -z "${WASI_SDK_PATH:-}" ] && [ -x "$DF_SQLITE_TOOLS_DIR/wasi-sdk/bin/clang" ]; then
  export WASI_SDK_PATH="$DF_SQLITE_TOOLS_DIR/wasi-sdk"
fi
if [ -n "${WASI_SDK_PATH:-}" ]; then
  export CC_wasm32_wasip2="${CC_wasm32_wasip2:-$WASI_SDK_PATH/bin/clang}"
  export AR_wasm32_wasip2="${AR_wasm32_wasip2:-$WASI_SDK_PATH/bin/llvm-ar}"
  export CFLAGS_wasm32_wasip2="${CFLAGS_wasm32_wasip2:---target=wasm32-wasip2 -Os}"
fi

# Keep in sync with .cargo/config.toml (which is the fallback for plain `cargo build`).
export LIBSQLITE3_FLAGS="${LIBSQLITE3_FLAGS:--DSQLITE_OS_OTHER=1 -DSQLITE_TEMP_STORE=3 -DSQLITE_STMTJRNL_SPILL=-1 -DSQLITE_OMIT_WAL -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DEFAULT_SYNCHRONOUS=2 -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_DEFAULT_MEMSTATUS=0}"

# Deterministic builds: strip absolute paths from panic messages / debuginfo.
# Guarded so sourcing this file twice does not stack the flags.
if [ "${DF_SQLITE_ENV_LOADED:-}" != "$_df_pkg_dir" ]; then
  export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$_df_pkg_dir=/di-framework-sqlite-component --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
  export DF_SQLITE_ENV_LOADED="$_df_pkg_dir"
fi

unset _df_pkg_dir
