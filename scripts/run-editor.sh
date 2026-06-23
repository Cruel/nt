#!/usr/bin/env bash
set -euo pipefail

RELEASE=0

for arg in "$@"; do
  case "$arg" in
    --release)
      RELEASE=1
      ;;
    *)
      echo "[run] unknown argument: $arg" >&2
      echo "usage: $0 [--release]" >&2
      exit 2
      ;;
  esac
done

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT/editor"

echo "[run] installing editor dependencies..."
pnpm install

echo "[run] building engine preview..."
pnpm engine:preview:build

if [ "$RELEASE" = "1" ]; then
  echo "[run] packaging editor..."
  pnpm package
else
  echo "[run] launching editor..."
  pnpm start
fi
