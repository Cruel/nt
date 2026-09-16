#!/usr/bin/env bash
set -euo pipefail

APP_ARGS=()

usage() {
  echo "usage: $0 [-- sandbox args...]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      APP_ARGS+=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FEATURE_LAB_ROOT="$PROJECT_ROOT/tests/projects/feature-lab"
RUN_ROOT="$PROJECT_ROOT/build/run-labs"
PACKAGE_PATH="$RUN_ROOT/feature-lab.ntpkg"
PRESET="linux-debug"

cd "$PROJECT_ROOT"

if [ -z "${NOVELTEA_CLI:-}" ]; then
  NOVELTEA_CLI="$PROJECT_ROOT/build/cli/linux/noveltea"
fi
if [ ! -x "$NOVELTEA_CLI" ]; then
  echo "[run] NovelTea host CLI not found; building it..."
  pnpm -C editor run noveltea:build
fi
[ -x "$NOVELTEA_CLI" ] || { echo "[run] NovelTea host CLI not found: $NOVELTEA_CLI" >&2; exit 1; }
export NOVELTEA_CLI

CMAKE_CONFIGURE_ARGS=(-DNOVELTEA_ENABLE_RENDER_PERF=ON)
if [ -d "$PROJECT_ROOT/rmlui-bgfx" ]; then
  echo "[run] using local rmlui-bgfx checkout at $PROJECT_ROOT/rmlui-bgfx"
  CMAKE_CONFIGURE_ARGS+=(
    -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
    -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR="$PROJECT_ROOT/rmlui-bgfx"
  )
fi

echo "[run] validating Feature Lab..."
"$NOVELTEA_CLI" --project "$FEATURE_LAB_ROOT" validate
node tools/feature-lab/validate.mjs --project "$FEATURE_LAB_ROOT"

echo "[run] running Feature Lab authored test suite..."
"$NOVELTEA_CLI" --project "$FEATURE_LAB_ROOT" test run

mkdir -p "$RUN_ROOT"
echo "[run] exporting Feature Lab runtime package..."
"$NOVELTEA_CLI" --project "$FEATURE_LAB_ROOT" package export \
  --output "$PACKAGE_PATH" \
  --include-unused-assets

echo "[run] configuring desktop build ($PRESET)..."
cmake --preset "$PRESET" "${CMAKE_CONFIGURE_ARGS[@]}"

echo "[run] building sandbox ($PRESET)..."
cmake --build --preset "$PRESET" --target noveltea-sandbox

echo "[run] launching Feature Lab..."
exec "$PROJECT_ROOT/build/$PRESET/apps/sandbox/noveltea-sandbox" \
  --project-assets "$RUN_ROOT" \
  --compiled-project "project:/feature-lab.ntpkg" \
  --run-runtime \
  "${APP_ARGS[@]}"
