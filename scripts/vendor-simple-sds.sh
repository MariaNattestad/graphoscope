#!/usr/bin/env bash
# Vendors simple-sds into crates/reduce/vendor/simple-sds, pinned to the version
# gbz-base needs, with scripts/simple-sds-wasm32.patch applied. The crate's
# Cargo.toml points [patch.crates-io] at that copy, so every build of
# crates/reduce needs it — the wasm build (scripts/build-wasm.sh) and native
# ones like `cargo test` alike. Idempotent: does nothing if it's already there.
#
# Usage: scripts/vendor-simple-sds.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE="$HERE/../crates/reduce"

SIMPLE_SDS_DIR="$CRATE/vendor/simple-sds"
SIMPLE_SDS_REF=v0.4.1
if [[ ! -d "$SIMPLE_SDS_DIR" ]]; then
	mkdir -p "$CRATE/vendor"
	git -c advice.detachedHead=false clone --quiet --branch "$SIMPLE_SDS_REF" --depth 1 \
		https://github.com/jltsiren/simple-sds.git "$SIMPLE_SDS_DIR"
	git -C "$SIMPLE_SDS_DIR" apply "$HERE/simple-sds-wasm32.patch"
fi
