#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PRESET="${PRESET:-linux-debug}"
BUILD_DIR="${BUILD_DIR:-build/$PRESET}"
COMPAT=0
CTEST_ARGS=()
COMPAT_MARKER="$PROJECT_ROOT/$BUILD_DIR/rmlui-base-direct-compat.enabled"

for arg in "$@"; do
    if [ "$arg" = "--compat" ]; then
        COMPAT=1
    else
        CTEST_ARGS+=("$arg")
    fi
done

cd "$PROJECT_ROOT"

if [ "$COMPAT" = "1" ]; then
    mkdir -p "$(dirname "$COMPAT_MARKER")"
    : > "$COMPAT_MARKER"
else
    rm -f "$COMPAT_MARKER"
fi

echo "[test] configuring $PRESET..."
cmake --preset "$PRESET"

echo "[test] building $PRESET..."
cmake --build --preset "$PRESET" --parallel

echo "[test] running CTest in $BUILD_DIR..."
ctest --test-dir "$BUILD_DIR" --output-on-failure "${CTEST_ARGS[@]}"
