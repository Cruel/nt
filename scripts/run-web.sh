#!/usr/bin/env bash
set -euo pipefail

MODE="debug"

for arg in "$@"; do
  case "$arg" in
    --release)
      MODE="release"
      ;;
    --profile)
      MODE="profile"
      ;;
    *)
      echo "[run] unknown argument: $arg" >&2
      echo "usage: $0 [--release|--profile]" >&2
      exit 2
      ;;
  esac
done

CMAKE_CONFIGURE_ARGS=()
case "$MODE" in
  debug)
    PRESET="web-debug"
    ;;
  release)
    PRESET="web-release"
    ;;
  profile)
    PRESET="web-profile"
    ;;
  *)
    echo "[run] internal error: unknown mode $MODE" >&2
    exit 2
    ;;
esac

BUILD_DIR="build/$PRESET"
PORT="${PORT:-8080}"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# This helper serves the standalone sandbox. Keep a cache previously configured
# for the editor preview widget from selecting its different Web shell.
CMAKE_CONFIGURE_ARGS+=(
  -DNOVELTEA_WEB_SHELL_FILE="$PROJECT_ROOT/web/shell.html"
)

if [ -d "$PROJECT_ROOT/rmlui-bgfx" ]; then
  echo "[run] using local rmlui-bgfx checkout at $PROJECT_ROOT/rmlui-bgfx"
  CMAKE_CONFIGURE_ARGS+=(
    -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
    -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR="$PROJECT_ROOT/rmlui-bgfx"
  )
fi

echo "[run] configuring web build ($PRESET)..."
cmake --preset "$PRESET" "${CMAKE_CONFIGURE_ARGS[@]}"

echo "[run] building ($PRESET)..."
cmake --build --preset "$PRESET" --parallel

echo "[run] starting web server at http://localhost:$PORT"
if [ "$MODE" = "profile" ]; then
  echo "[run] perf URL: http://localhost:$PORT/?demo=none&noImgui=1&renderPerf=1&rmlui-document=project:/rmlui/readback_gallery.rml"
else
  echo "[run] URL: http://localhost:$PORT/?demo=none&noImgui=1&rmlui-document=project:/rmlui/readback_gallery.rml"
fi
cd "$BUILD_DIR/apps/sandbox/"
python3 - "$PORT" <<'PY'
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1])
server = ThreadingHTTPServer(("", port), CrossOriginIsolatedHandler)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
PY
