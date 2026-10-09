# Sourced by build.sh / compose.sh / smoke.sh (and usable interactively:
#   `. scripts/env.sh`) to put the pinned tools on PATH and export the
# variables the Rust build needs. Prefers the hermetic .tools/ install; falls
# back to whatever is on PATH so a developer with rustup/wasm-tools/wac already
# installed can build without running install-tools.sh --rust.

# Works when sourced from bash or zsh.
if [[ -n "${BASH_SOURCE:-}" ]]; then
  _df_env_src="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION:-}" ]]; then
  eval '_df_env_src="${(%):-%x}"'
else
  _df_env_src="$0"
fi
_df_pkg_dir="$(cd "$(dirname "$_df_env_src")/.." && pwd)"
unset _df_env_src
# shellcheck source=tool-versions.env
. "$_df_pkg_dir/scripts/tool-versions.env"

DF_PGLITE_TOOLS_DIR="${DF_PGLITE_TOOLS_DIR:-$_df_pkg_dir/.tools}"
export DF_PGLITE_TOOLS_DIR

if [[ -d "$DF_PGLITE_TOOLS_DIR/bin" ]]; then
  export PATH="$DF_PGLITE_TOOLS_DIR/bin:$PATH"
fi

# Hermetic rustup (only when installed via install-tools.sh --rust and the
# caller has not pointed at their own).
if [[ -x "$DF_PGLITE_TOOLS_DIR/cargo/bin/cargo" ]] && [[ -z "${RUSTUP_HOME:-}" ]]; then
  export RUSTUP_HOME="$DF_PGLITE_TOOLS_DIR/rustup"
  export CARGO_HOME="$DF_PGLITE_TOOLS_DIR/cargo"
  export PATH="$DF_PGLITE_TOOLS_DIR/cargo/bin:$PATH"
fi

# Prefer the pinned rustup toolchain even when a standalone /usr/local/bin
# cargo/rustc precedes rustup's shims on PATH (its WASI std may be absent).
if command -v rustup >/dev/null 2>&1; then
  if _df_rust_cargo="$(rustup which --toolchain "$RUST_TOOLCHAIN" cargo 2>/dev/null)"; then
    export PATH="$(dirname "$_df_rust_cargo"):$PATH"
  fi
  unset _df_rust_cargo
fi

# Deterministic builds: strip absolute paths from panic messages / debuginfo.
# Guarded so sourcing this file twice does not stack the flags.
if [[ "${DF_PGLITE_ENV_LOADED:-}" != "$_df_pkg_dir" ]]; then
  export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$_df_pkg_dir=/di-framework-pglite-component --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
  export DF_PGLITE_ENV_LOADED="$_df_pkg_dir"
fi

unset _df_pkg_dir
