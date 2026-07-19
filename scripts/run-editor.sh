#!/usr/bin/env bash
set -euo pipefail

SKIP_PREVIEW=0

for arg in "$@"; do
  case "$arg" in
    --skip-preview)
      SKIP_PREVIEW=1
      ;;
    *)
      echo "[run] unknown argument: $arg" >&2
      echo "usage: $0 [--skip-preview]" >&2
      exit 2
      ;;
  esac
done

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

if [ "$SKIP_PREVIEW" = "1" ]; then
  exec pnpm editor:dev:skip-preview
else
  exec pnpm editor:dev
fi
