#!/usr/bin/env bash
set -euo pipefail

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "[run] configuring web build..."
cmake --preset web-debug

echo "[run] building..."
cmake --build --preset web-debug

echo "[run] starting web server at http://localhost:8080"
cd build/web-debug/apps/sandbox/
python3 -m http.server 8080
