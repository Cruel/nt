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

# The editor uses a separate native Node-API Project worker; building the CLI does not
# produce it. Refresh the local addon through CMake's incremental build before launch.
if [ -z "${NOVELTEA_AUTHORING_NODE_ADDON:-}" ]; then
  echo "[run] preparing native Project authoring addon"
  node editor/scripts/build-native-authoring-addon.mjs --addon-only
  export NOVELTEA_AUTHORING_NODE_ADDON="$PROJECT_ROOT/build/native-authoring-host/noveltea-authoring-node.node"
fi
if [ ! -f "$NOVELTEA_AUTHORING_NODE_ADDON" ]; then
  echo "[run] native Project authoring addon is missing: $NOVELTEA_AUTHORING_NODE_ADDON" >&2
  exit 1
fi

if [ "$SKIP_PREVIEW" = "1" ]; then
  exec pnpm -C editor run dev:skip-preview
else
  exec pnpm -C editor run dev
fi
