#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLES_ROOT="${NOVELTEA_EXAMPLES_ROOT:-$HOME/dev/noveltea-examples}"
OUTPUT_ROOT="${NOVELTEA_EXAMPLES_OUTPUT_ROOT:-$PROJECT_ROOT/build/site-examples}"
CLI_PATH="${NOVELTEA_CLI:-$PROJECT_ROOT/build/cli/linux/noveltea}"

if [ ! -d "$EXAMPLES_ROOT/.git" ]; then
  echo "[examples] public examples checkout not found at $EXAMPLES_ROOT" >&2
  echo "[examples] set NOVELTEA_EXAMPLES_ROOT to a Cruel/noveltea-examples checkout" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

if [ -z "${VCPKG_ROOT:-}" ]; then
  for candidate in "$PROJECT_ROOT/.cache/vcpkg" "$HOME/dev/vcpkg"; do
    if [ -x "$candidate/vcpkg" ]; then
      export VCPKG_ROOT="$candidate"
      break
    fi
  done
fi
[ -n "${VCPKG_ROOT:-}" ] && [ -x "$VCPKG_ROOT/vcpkg" ] || {
  echo "[examples] VCPKG_ROOT must point to a bootstrapped vcpkg checkout" >&2
  exit 1
}

if ! command -v emcc >/dev/null 2>&1; then
  if [ -z "${EMSDK:-}" ] && [ -f "$HOME/dev/emsdk/emsdk_env.sh" ]; then
    export EMSDK="$HOME/dev/emsdk"
  fi
  if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    # shellcheck disable=SC1090
    source "$EMSDK/emsdk_env.sh" >/dev/null
  fi
fi
command -v emcc >/dev/null 2>&1 || {
  echo "[examples] Emscripten is required; activate emsdk or set EMSDK" >&2
  exit 1
}

if [ -z "${NOVELTEA_CLI:-}" ]; then
  echo "[examples] building current NovelTea host CLI..."
  pnpm -C editor run noveltea:build
fi
[ -x "$CLI_PATH" ] || { echo "[examples] NovelTea CLI not found: $CLI_PATH" >&2; exit 1; }

revision="$(git rev-parse HEAD)"
release_tag="dev-$revision"
template_archive="$PROJECT_ROOT/dist/noveltea-player-template-$release_tag-web-wasm32-threads-release.zip"
template_descriptor="$PROJECT_ROOT/dist/web-wasm32-threads-release.template.json"

echo "[examples] configuring canonical threaded Web player..."
cmake --preset web-release -DBUILD_TESTING=OFF -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=OFF

echo "[examples] building canonical threaded Web player..."
cmake --build --preset web-release --target noveltea-player

echo "[examples] packaging canonical threaded Web player..."
cmake \
  -DNOVELTEA_TEMPLATE_PRESET=web-release \
  -DNOVELTEA_RELEASE_TAG="$release_tag" \
  -P cmake/PackageNovelTeaWebPlayerTemplate.cmake

[ -f "$template_archive" ] || { echo "[examples] player template was not produced: $template_archive" >&2; exit 1; }
[ -f "$template_descriptor" ] || { echo "[examples] player descriptor was not produced: $template_descriptor" >&2; exit 1; }

echo "[examples] qualifying pinned examples from $EXAMPLES_ROOT..."
node scripts/qualify-examples.mjs \
  --examples-root "$EXAMPLES_ROOT" \
  --nt-revision "$revision" \
  --cli "$CLI_PATH" \
  --player-template "$template_archive" \
  --player-descriptor "$template_descriptor" \
  --output "$OUTPUT_ROOT"

echo "[examples] qualified catalog: $OUTPUT_ROOT/catalog.json"
