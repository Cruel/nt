#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

if [ ! -d node_modules ] || [ ! -d site/node_modules ]; then
  echo "[run] site dependencies are not installed; run 'pnpm install' from the repository root" >&2
  exit 1
fi

echo "[run] preparing Astro/Starlight content..."
pnpm -C site exec astro sync

echo "[run] starting NovelTea site development server..."
exec pnpm -C site run dev "$@"
