#!/usr/bin/env bash
set -euo pipefail

RELEASE=0
APP_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --release)
      RELEASE=1
      ;;
    *)
      APP_ARGS+=("$arg")
      ;;
  esac
done

CMAKE_CONFIGURE_ARGS=(-DNOVELTEA_ENABLE_RENDER_PERF=ON)
if [ "$RELEASE" = "1" ]; then
  PRESET="linux-release"
  CMAKE_CONFIGURE_ARGS+=(
    -DVCPKG_MANIFEST_FEATURES=shader-tools
    -DNOVELTEA_COMPILE_SHADERS=ON
    -DBUILD_TESTING=OFF
  )
else
  PRESET="linux-debug"
fi
BUILD_DIR="build/$PRESET"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

if [ -d "$PROJECT_ROOT/rmlui-bgfx" ]; then
  echo "[run] using local rmlui-bgfx checkout at $PROJECT_ROOT/rmlui-bgfx"
  CMAKE_CONFIGURE_ARGS+=(
    -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
    -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR="$PROJECT_ROOT/rmlui-bgfx"
  )
fi

echo "[run] configuring desktop build ($PRESET)..."
cmake --preset "$PRESET" "${CMAKE_CONFIGURE_ARGS[@]}"

echo "[run] building ($PRESET)..."
cmake --build --preset "$PRESET" --parallel

echo "[run] launching..."
"./$BUILD_DIR/apps/sandbox/noveltea-sandbox" "${APP_ARGS[@]}"
