#!/usr/bin/env bash
# Builds static/query.wasm from Graphoscope's own `crates/reduce` — the locus
# query that extracts a subgraph, simplifies it, and aggregates haplotype walks
# into per-node/edge counts (see crates/reduce/src/main.rs).
#
# GBZ-base is consumed unmodified as a published crates.io dependency; no
# checkout, fork, or patch of it is needed. The one thing that does need
# patching is `simple-sds`, which doesn't build for 32-bit wasm as published
# (it defaults to a `libc`/mmap feature wasm lacks, and two size constants
# overflow a 32-bit usize). scripts/vendor-simple-sds.sh vendors a pinned copy
# with scripts/simple-sds-wasm32.patch applied, and the crate points at it via
# [patch.crates-io].
#
# Usage: scripts/build-wasm.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE="$HERE/../crates/reduce"

source "$HOME/.cargo/env"
TARGET=wasm32-wasip1
rustup target add "$TARGET"

WASI_SDK_VERSION=24
WASI_SDK_ARCH=arm64-macos # e.g. x86_64-linux on an Intel Linux host
WASI_SDK_DIR="$CRATE/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}"
if [[ ! -e "$WASI_SDK_DIR/bin/clang" ]]; then
	echo >&2 "Installing WASI C SDK ${WASI_SDK_VERSION} (${WASI_SDK_ARCH})..."
	curl -O -L "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz"
	tar -C "$CRATE" -xf "wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz"
	rm "wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz"
fi

# Vendor + patch simple-sds for wasm32, pinned to the version gbz-base needs.
"$HERE/vendor-simple-sds.sh"

export CC_wasm32_wasip1="${WASI_SDK_DIR}/bin/clang"
export AR_wasm32_wasip1="${WASI_SDK_DIR}/bin/llvm-ar"
export CFLAGS_wasm32_wasip1="--sysroot=${WASI_SDK_DIR}/share/wasi-sysroot"
# sqlite: no long double (missing intrinsics), no pthreads (no threads in wasm).
export LIBSQLITE3_FLAGS="-DLONGDOUBLE_TYPE=double -DSQLITE_THREADSAFE=0"
export RUSTFLAGS=""

(cd "$CRATE" && cargo build --release --target="$TARGET")

cp "$CRATE/target/${TARGET}/release/graphoscope-reduce.wasm" "$HERE/../static/query.wasm"
echo "wrote static/query.wasm"
