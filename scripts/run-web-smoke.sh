#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="profile"
CLEAN=0
BUILD=1
RUN=1
USE_LOCAL_RMLUI_BGFX=0
GENERATOR="Ninja"
FRAMES=""
MIN_PERF_LINES=""
EXTRA_CMAKE_ARGS=()
EXTRA_SMOKE_ARGS=()

usage() {
  cat <<'EOF'
usage: scripts/run-web-smoke.sh [options]

Build and run the Web RmlUi smoke in the same shape as CI.

Options:
  --debug                    Use web-debug smoke thresholds and build dir.
  --profile                  Use web-profile smoke thresholds and build dir (default).
  --clean                    Remove the selected build directory before configuring.
  --no-build                 Do not configure/build; only run the smoke script.
  --build-only               Configure/build but do not run the smoke script.
  --local-rmlui-bgfx         Use ./rmlui-bgfx via FETCHCONTENT_SOURCE_DIR_RMLUI_BGFX.
  --frames <count>           Override smoke frame count.
  --min-perf-lines <count>   Override required captured perf line count.
  --cmake-arg <arg>          Pass an extra argument to CMake configure.
  --smoke-arg <arg>          Pass an extra argument to scripts/web-smoke.mjs.
  -h, --help                 Show this help.

Examples:
  scripts/run-web-smoke.sh --clean
  scripts/run-web-smoke.sh --clean --local-rmlui-bgfx
  scripts/run-web-smoke.sh --debug --clean --frames 6 --min-perf-lines 1
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug)
      MODE="debug"
      shift
      ;;
    --profile)
      MODE="profile"
      shift
      ;;
    --clean)
      CLEAN=1
      shift
      ;;
    --no-build)
      BUILD=0
      shift
      ;;
    --build-only)
      RUN=0
      shift
      ;;
    --local-rmlui-bgfx)
      USE_LOCAL_RMLUI_BGFX=1
      shift
      ;;
    --frames)
      if [[ $# -lt 2 ]]; then
        echo "[web-smoke] --frames requires a value" >&2
        exit 2
      fi
      FRAMES="$2"
      shift 2
      ;;
    --min-perf-lines)
      if [[ $# -lt 2 ]]; then
        echo "[web-smoke] --min-perf-lines requires a value" >&2
        exit 2
      fi
      MIN_PERF_LINES="$2"
      shift 2
      ;;
    --cmake-arg)
      if [[ $# -lt 2 ]]; then
        echo "[web-smoke] --cmake-arg requires a value" >&2
        exit 2
      fi
      EXTRA_CMAKE_ARGS+=("$2")
      shift 2
      ;;
    --smoke-arg)
      if [[ $# -lt 2 ]]; then
        echo "[web-smoke] --smoke-arg requires a value" >&2
        exit 2
      fi
      EXTRA_SMOKE_ARGS+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[web-smoke] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  debug)
    PRESET="web-debug"
    THRESHOLD="readback_gallery_debug"
    FRAMES="${FRAMES:-6}"
    MIN_PERF_LINES="${MIN_PERF_LINES:-1}"
    LABEL="web-debug"
    ;;
  profile)
    PRESET="web-profile"
    THRESHOLD="readback_gallery_profile"
    FRAMES="${FRAMES:-180}"
    MIN_PERF_LINES="${MIN_PERF_LINES:-2}"
    LABEL="web-profile"
    ;;
  *)
    echo "[web-smoke] internal error: unknown mode $MODE" >&2
    exit 2
    ;;
esac

BUILD_DIR="build/$PRESET"

cd "$PROJECT_ROOT"

if [[ "$CLEAN" = 1 ]]; then
  echo "[web-smoke] removing $BUILD_DIR..."
  rm -rf "$BUILD_DIR"
fi

if [[ "$BUILD" = 1 ]]; then
  if [[ -f "$BUILD_DIR/CMakeCache.txt" ]]; then
    if ! grep -q "CMAKE_GENERATOR:INTERNAL=$GENERATOR" "$BUILD_DIR/CMakeCache.txt"; then
      echo "[web-smoke] existing $BUILD_DIR was not generated with $GENERATOR; removing it."
      rm -rf "$BUILD_DIR"
    fi
  fi

  CONFIGURE_ARGS=(
    --preset "$PRESET"
    -G "$GENERATOR"
    -DNOVELTEA_COMPILE_SHADERS=ON
    -DBUILD_TESTING=OFF
  )

  if [[ "$USE_LOCAL_RMLUI_BGFX" = 1 ]]; then
    CONFIGURE_ARGS+=("-DFETCHCONTENT_SOURCE_DIR_RMLUI_BGFX=$PROJECT_ROOT/rmlui-bgfx")
  fi

  CONFIGURE_ARGS+=("${EXTRA_CMAKE_ARGS[@]}")

  echo "[web-smoke] configuring $PRESET with $GENERATOR..."
  echo "[web-smoke] compiling shaders during build"
  if [[ -n "${EMSDK:-}" && -f "$EMSDK/emsdk_env.sh" ]]; then
    # shellcheck source=/dev/null
    source "$EMSDK/emsdk_env.sh" >/dev/null
  fi
  emcmake cmake "${CONFIGURE_ARGS[@]}"

  echo "[web-smoke] building noveltea-sandbox ($PRESET)..."
  cmake --build --preset "$PRESET" --target noveltea-sandbox
fi

if [[ "$RUN" = 1 ]]; then
  echo "[web-smoke] running smoke ($LABEL)..."
  node scripts/web-smoke.mjs \
    --build-dir "$BUILD_DIR" \
    --threshold "$THRESHOLD" \
    --frames "$FRAMES" \
    --min-perf-lines "$MIN_PERF_LINES" \
    --label "$LABEL" \
    "${EXTRA_SMOKE_ARGS[@]}"
fi
