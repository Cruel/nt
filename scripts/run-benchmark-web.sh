#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET=web-benchmark-release
BUILD=1
PORT=8000
OPEN_BROWSER=1
APP_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --debug) PRESET=web-benchmark-debug; shift ;;
    --no-build) BUILD=0; shift ;;
    --no-browser) OPEN_BROWSER=0; shift ;;
    --port)
      if [ "$#" -lt 2 ] || ! [[ "$2" =~ ^[0-9]+$ ]] || [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
        echo "[benchmark] --port requires a port in 1..65535" >&2
        exit 2
      fi
      PORT="$2"; shift 2 ;;
    --) shift; APP_ARGS+=("$@"); break ;;
    *) APP_ARGS+=("$1"); shift ;;
  esac
done

cd "$ROOT"
if [ "$BUILD" = 1 ]; then
  # Use the pinned Emscripten toolchain without touching the caller's global CMake job limit.
  if [ -z "${EMSDK:-}" ]; then
    if [ -f "$ROOT/../emsdk/emsdk_env.sh" ]; then
      # shellcheck source=/dev/null
      source "$ROOT/../emsdk/emsdk_env.sh" >/dev/null
    else
      echo "[benchmark] EMSDK is required; source emsdk_env.sh first" >&2
      exit 2
    fi
  fi
  CMAKE_ARGS=()
  if [ -f "$ROOT/rmlui-bgfx/CMakeLists.txt" ]; then
    CMAKE_ARGS+=(-DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON)
  fi
  cmake --preset "$PRESET" "${CMAKE_ARGS[@]}"
  cmake --build --preset "$PRESET" --target noveltea-benchmark-app
fi

BUILD_DIR="$ROOT/build/$PRESET/apps/benchmark"
if [ ! -f "$BUILD_DIR/benchmark.html" ] || [ ! -f "$BUILD_DIR/benchmark.wasm" ]; then
  echo "[benchmark] missing built Web benchmark in $BUILD_DIR" >&2
  exit 1
fi

QUERY="$(node -e '
const fs = require("node:fs");
const params = new URLSearchParams();
let hasConfig = false;
let hasRunFlags = false;
const keys = {
  "--scenario":"scenario", "--frames":"frames", "--seconds":"seconds",
  "--warmup-seconds":"warmup", "--repeats":"repeats", "--profile":"profile",
  "--width":"width", "--height":"height", "--rect-count":"rectCount",
  "--rect-scale":"rectScale", "--ready-timeout-seconds":"readyTimeout",
  "--output":"output"
};
const switches = {"--smoke":"smoke", "--no-ui":"noUi", "--ui":"ui",
  "--vsync":"vsync", "--raw-samples":"rawSamples",
  "--dashboard-smoke":"dashboardSmoke", "--quick-suite":"quickSuite"};
const args = process.argv.slice(1);
for (let i=0; i<args.length; ++i) {
  const key = args[i];
  if (key === "--config" && i+1<args.length) {
    if (hasConfig) { console.error("[benchmark] repeated --config"); process.exit(2); }
    const file = args[++i];
    let bytes;
    try { bytes = fs.readFileSync(file); }
    catch (error) { console.error("[benchmark] cannot read config " + file + ": " + error.message); process.exit(2); }
    if (!bytes.length || bytes.length > 8192) {
      console.error("[benchmark] Web configuration must contain 1..8192 bytes"); process.exit(2);
    }
    params.set("configB64", bytes.toString("base64"));
    hasConfig = true;
  } else if (switches[key]) {
    params.set(switches[key], "1");
    hasRunFlags = true;
  } else if (keys[key] && i+1<args.length) {
    params.set(keys[key], args[++i]);
    if (key !== "--output") hasRunFlags = true;
  } else { console.error("[benchmark] unsupported Web launcher argument: " + key); process.exit(2); }
}
if (hasConfig && hasRunFlags) {
  console.error("[benchmark] --config cannot be combined with run settings; --output is allowed");
  process.exit(2);
}
process.stdout.write(params.toString());
' -- "${APP_ARGS[@]}")"
URL="http://127.0.0.1:$PORT/benchmark.html"
if [ -n "$QUERY" ]; then URL="$URL?$QUERY"; fi
echo "[benchmark] serving $PRESET at $URL"
if [ "$OPEN_BROWSER" = 1 ] && command -v xdg-open >/dev/null 2>&1; then
  (sleep 0.5; xdg-open "$URL" >/dev/null 2>&1 || true) &
fi
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$BUILD_DIR"
