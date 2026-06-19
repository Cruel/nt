#!/usr/bin/env bash
set -euo pipefail

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "[run] configuring desktop build..."
cmake --preset linux-debug

echo "[run] building..."
cmake --build --preset linux-debug --parallel

echo "[run] launching..."
./build/linux-debug/apps/sandbox/noveltea-sandbox "$@"
