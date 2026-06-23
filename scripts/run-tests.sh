#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RELEASE=0
COMPAT=0
CTEST_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --release)
            RELEASE=1
            ;;
        --compat)
            COMPAT=1
            ;;
        *)
            CTEST_ARGS+=("$arg")
            ;;
    esac
done

if [ -n "${PRESET:-}" ]; then
    PRESET="$PRESET"
elif [ "$RELEASE" = "1" ]; then
    PRESET="linux-release"
else
    PRESET="linux-debug"
fi
BUILD_DIR="${BUILD_DIR:-build/$PRESET}"
COMPAT_MARKER="$PROJECT_ROOT/$BUILD_DIR/rmlui-base-direct-compat.enabled"

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
