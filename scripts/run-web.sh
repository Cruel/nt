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

CMAKE_CONFIGURE_ARGS=(-DNOVELTEA_ENABLE_RENDER_PERF=ON)
if [ "$RELEASE" = "1" ]; then
  PRESET="web-release"
else
  PRESET="web-debug"
fi
BUILD_DIR="build/$PRESET"
PORT="${PORT:-8080}"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "[run] configuring web build ($PRESET)..."
cmake --preset "$PRESET" "${CMAKE_CONFIGURE_ARGS[@]}"

echo "[run] building ($PRESET)..."
cmake --build --preset "$PRESET" --parallel

echo "[run] starting web server at http://localhost:$PORT"
echo "[run] perf URL: http://localhost:$PORT/?demo=none&noImgui=1&renderPerf=1&rmlui-document=project:/rmlui/readback_gallery.rml"
cd "$BUILD_DIR/apps/sandbox/"
python3 -m http.server "$PORT"
