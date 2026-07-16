#!/usr/bin/env bash
# Builds static/query.wasm from GBZ-base's `query` binary, compiled to
# wasm32-wasip1 (arm64 WASI SDK; adjust WASI_SDK_ARCH below for other hosts).
#
# GBZ-base (https://github.com/jltsiren/gbz-base) doesn't ship a working wasm
# build itself (its build-wasm.sh targets the removed wasm32-wasi), and its
# dependency simple-sds doesn't compile for 32-bit wasm out of the box. This
# script clones a pinned simple-sds, applies scripts/simple-sds-wasm32.patch
# (drops the libc/mmap feature wasm lacks; fixes two suffix constants that
# overflow 32-bit usize), points gbz-base at it via [patch.crates-io], then
# builds and copies the wasm into static/.
#
# Usage: scripts/build-wasm.sh [path-to-gbz-base-checkout]
# Defaults to ../gbz-base (a sibling checkout of jltsiren/gbz-base).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GBZ_BASE_DIR="$(cd "${1:-"$HERE/../../gbz-base"}" && pwd)"

if [[ ! -f "$GBZ_BASE_DIR/Cargo.toml" ]] || ! grep -q '^name = "gbz-base"' "$GBZ_BASE_DIR/Cargo.toml"; then
	echo >&2 "error: $GBZ_BASE_DIR doesn't look like a gbz-base checkout"
	echo >&2 "clone it first: git clone https://github.com/jltsiren/gbz-base $GBZ_BASE_DIR"
	exit 1
fi

source "$HOME/.cargo/env"
TARGET=wasm32-wasip1
rustup target add "$TARGET"

WASI_SDK_VERSION=24
WASI_SDK_ARCH=arm64-macos # e.g. x86_64-linux on an Intel Linux host
WASI_SDK_DIR="$GBZ_BASE_DIR/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}"
if [[ ! -e "$WASI_SDK_DIR/bin/clang" ]]; then
	echo >&2 "Installing WASI C SDK ${WASI_SDK_VERSION} (${WASI_SDK_ARCH})..."
	curl -O -L "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz"
	tar -C "$GBZ_BASE_DIR" -xf "wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz"
	rm "wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz"
fi

# Vendor + patch simple-sds for wasm32, pinned to the version gbz-base depends on.
SIMPLE_SDS_DIR="$GBZ_BASE_DIR/vendor/simple-sds"
SIMPLE_SDS_REF=v0.4.1
if [[ ! -d "$SIMPLE_SDS_DIR" ]]; then
	git clone --branch "$SIMPLE_SDS_REF" https://github.com/jltsiren/simple-sds.git "$SIMPLE_SDS_DIR"
	git -C "$SIMPLE_SDS_DIR" apply "$HERE/simple-sds-wasm32.patch"
fi

if ! grep -q 'simple-sds = { path = "vendor/simple-sds" }' "$GBZ_BASE_DIR/Cargo.toml"; then
	cat >>"$GBZ_BASE_DIR/Cargo.toml" <<-'EOF'

		# Local patch: build simple-sds without the `libc`/mmap feature (unavailable on
		# wasm32) and with 32-bit-safe size constants, so `query` can compile to
		# wasm32-wasip1 for in-browser range-request querying. Native builds are
		# unaffected in practice (the .db path does not use mmap).
		[patch.crates-io]
		simple-sds = { path = "vendor/simple-sds" }
	EOF
fi

export CC_wasm32_wasip1="${WASI_SDK_DIR}/bin/clang"
export AR_wasm32_wasip1="${WASI_SDK_DIR}/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=${WASI_SDK_DIR}/share/wasi-sysroot"
# sqlite: no long double (missing intrinsics), no pthreads (no threads in wasm).
export LIBSQLITE3_FLAGS="-DLONGDOUBLE_TYPE=double -DSQLITE_THREADSAFE=0"
# Override gbz-base's .cargo/config.toml, which sets `-C target-cpu=native`
# (an aarch64 CPU flag, invalid for the wasm target).
export RUSTFLAGS=""

(cd "$GBZ_BASE_DIR" && cargo build --release --target="$TARGET" --bin query)

cp "$GBZ_BASE_DIR/target/${TARGET}/release/query.wasm" "$HERE/../static/query.wasm"
echo "wrote static/query.wasm"
