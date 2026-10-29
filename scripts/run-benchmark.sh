#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRESET="linux-benchmark-release"
BUILD=1
APP_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --debug)
      PRESET="linux-benchmark-debug"
      shift
      ;;
    --no-build)
      BUILD=0
      shift
      ;;
    --)
      shift
      APP_ARGS+=("$@")
      break
      ;;
    *)
      APP_ARGS+=("$1")
      shift
      ;;
  esac
done

cd "$PROJECT_ROOT"
if [ "$BUILD" = 1 ]; then
  CMAKE_ARGS=()
  if [ -f "$PROJECT_ROOT/rmlui-bgfx/CMakeLists.txt" ]; then
    CMAKE_ARGS+=(-DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON)
  fi
  cmake --preset "$PRESET" "${CMAKE_ARGS[@]}"
  cmake --build --preset "$PRESET" --target noveltea-benchmark-app
fi

BIN="$PROJECT_ROOT/build/$PRESET/apps/benchmark/noveltea-benchmark-app"
if [ ! -x "$BIN" ]; then
  echo "[benchmark] missing executable $BIN (omit --no-build to build it)" >&2
  exit 1
fi
exec "$BIN" "${APP_ARGS[@]}"
