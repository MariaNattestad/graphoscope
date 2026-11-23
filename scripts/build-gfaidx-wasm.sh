#!/usr/bin/env bash
# Builds static/gfaidx.wasm: the query side of gfaidx (the C++ library, not the
# indexer and not gfaidx-viz) plus Graphoscope's small entry point,
# crates/gfaidx-wasm/src/main.cpp, compiled for WebAssembly (WASI).
#
# The /gfaidx page runs it in a worker with every index file backed by HTTP
# range requests (src/lib/vfs.ts), the same way query.wasm reads a GBZ-base
# database. There is no server: the index sits in a bucket.
#
# gfaidx is vendored at a pinned commit with scripts/gfaidx-wasm.patch applied.
# The patch is where gfaidx assumes a local disk and we read by range request:
#  - Three sidecars (.ndx, .lnx, .pcx) are memory-mapped upstream. WASI has no
#    mmap, and its emulation reads the whole file. Patched, they are read in
#    4 KiB pages on demand (src/fs/lazy_file.h).
#  - A region on a path is found by scanning the path from its first step
#    (unless a .cdx was built for that path). Patched, it is found from the
#    path's coordinate checkpoints (.pcx), reading only the steps around it.
#  - Loops that read one thing after another say first what they will read
#    (posix_fadvise for the graph's gzip members; a first pass over every
#    haplotype's walk), so the page can fetch it all in one round
#    (src/lib/sparseVfs.ts).
#  - One getrlimit call in the index writer (never run here) is compiled out.
# The patched query returns the same bytes as upstream's.
#
# Usage: scripts/build-gfaidx-wasm.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE="$HERE/../crates/gfaidx-wasm"
VENDOR="$CRATE/vendor"

GFAIDX_REF=a143792a01f0996079dcbdb8a79a8e5628f97e6a # v2.3.2, 2026-11-17
ZLIB_VERSION=1.3.1
# 33 is the first WASI SDK whose C++ library supports exceptions, which gfaidx
# uses throughout.
WASI_SDK_VERSION=34
WASI_SDK_ARCH=arm64-macos # e.g. x86_64-linux on an Intel Linux host
WASI_SDK_DIR="$CRATE/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}"

if [[ ! -e "$WASI_SDK_DIR/bin/clang++" ]]; then
	echo >&2 "Installing WASI SDK ${WASI_SDK_VERSION} (${WASI_SDK_ARCH})..."
	curl -sL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${WASI_SDK_ARCH}.tar.gz" |
		tar -xz -C "$CRATE"
fi

mkdir -p "$VENDOR"
if [[ ! -d "$VENDOR/gfaidx" ]]; then
	git -c advice.detachedHead=false clone --quiet https://github.com/fawaz-dabbaghieh/gfaidx.git "$VENDOR/gfaidx"
	git -C "$VENDOR/gfaidx" -c advice.detachedHead=false checkout --quiet "$GFAIDX_REF"
	patch --quiet -d "$VENDOR/gfaidx" -p1 <"$HERE/gfaidx-wasm.patch"
fi
if [[ ! -d "$VENDOR/zlib-${ZLIB_VERSION}" ]]; then
	curl -sL "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz" |
		tar -xz -C "$VENDOR"
fi

GFAIDX="$VENDOR/gfaidx"
ZLIB="$VENDOR/zlib-${ZLIB_VERSION}"
OBJ="$CRATE/obj"
rm -rf "$OBJ"
mkdir -p "$OBJ"

TARGET=wasm32-wasip1
# Standard (not legacy) WebAssembly exception handling, as the SDK's prebuilt
# C++ library uses.
EH=(-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false)

# zlib: only what inflating needs.
for name in adler32 crc32 inffast inflate inftrees zutil; do
	"$WASI_SDK_DIR/bin/clang" --target="$TARGET" -O2 -c "$ZLIB/$name.c" -o "$OBJ/z_$name.o"
done

# The query library, as listed for `gfaidx_library` in gfaidx's CMakeLists.txt.
LIBRARY=(
	api/graph.cpp api/indexed_graph.cpp
	chunk/chunk_reader.cpp chunk/text_handle_cache.cpp
	coordinates/coordinate_index.cpp coordinates/path_haplotype_query.cpp coordinates/path_coordinate_query.cpp
	indexer/node_hash_index.cpp indexer/node_length_index.cpp
	paths/p_path_coordinates.cpp paths/path_coordinate_checkpoints.cpp paths/path_index.cpp paths/walk_coords.cpp
	utils/Memory.cpp utils/cli_helpers.cpp
	fs/Reader.cpp fs/fs_helpers.cpp fs/gfa_line_parsers.cpp
)
CXXFLAGS=(--target="$TARGET" -std=c++17 -O2 "${EH[@]}" -DGFAIDX_VERSION='"2.3.2"'
	-I"$GFAIDX/include" -I"$GFAIDX/src" -I"$ZLIB")
pids=()
for source in "${LIBRARY[@]}"; do
	"$WASI_SDK_DIR/bin/clang++" "${CXXFLAGS[@]}" -c "$GFAIDX/src/$source" -o "$OBJ/$(echo "$source" | tr / _).o" &
	pids+=($!)
done
"$WASI_SDK_DIR/bin/clang++" "${CXXFLAGS[@]}" -c "$CRATE/src/main.cpp" -o "$OBJ/main.o" &
pids+=($!)
for pid in "${pids[@]}"; do wait "$pid"; done

"$WASI_SDK_DIR/bin/clang++" --target="$TARGET" -O2 -fwasm-exceptions "$OBJ"/*.o -lunwind \
	-Wl,--strip-debug -o "$HERE/../static/gfaidx.wasm"
echo "wrote static/gfaidx.wasm ($(wc -c <"$HERE/../static/gfaidx.wasm" | tr -d ' ') bytes)"
