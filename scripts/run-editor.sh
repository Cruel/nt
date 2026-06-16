#!/usr/bin/env bash
set -euo pipefail

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT/editor"

echo "[run] installing editor dependencies..."
pnpm install

echo "[run] building engine preview..."
pnpm engine:preview:build

echo "[run] launching editor..."
pnpm start
