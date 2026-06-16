#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PRESET="${PRESET:-linux-debug}"
BUILD_DIR="${BUILD_DIR:-build/$PRESET}"

cd "$PROJECT_ROOT"

echo "[test] configuring $PRESET..."
cmake --preset "$PRESET"

echo "[test] building $PRESET..."
cmake --build --preset "$PRESET"

echo "[test] running CTest in $BUILD_DIR..."
ctest --test-dir "$BUILD_DIR" --output-on-failure "$@"
