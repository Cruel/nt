#!/usr/bin/env bash
set -euo pipefail

RELEASE=0
PROJECT_PATH=""
EXPORT_PROFILE_ID=""
APP_ARGS=()

usage() {
  echo "usage: $0 [--release] [--project path/to/project.json] [--export-profile profile-id] [sandbox args...]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release)
      RELEASE=1
      shift
      ;;
    --project)
      PROJECT_PATH="${2:-}"
      [ -n "$PROJECT_PATH" ] || { echo "[run] --project requires a path" >&2; exit 2; }
      shift 2
      ;;
    --export-profile)
      EXPORT_PROFILE_ID="${2:-}"
      [ -n "$EXPORT_PROFILE_ID" ] || { echo "[run] --export-profile requires an id" >&2; exit 2; }
      shift 2
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

if [ -n "$EXPORT_PROFILE_ID" ] && [ -z "$PROJECT_PATH" ]; then
  echo "[run] --export-profile requires --project" >&2
  usage
  exit 2
fi

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

if [ -n "$PROJECT_PATH" ]; then
  PROJECT_PATH="$(realpath "$PROJECT_PATH")"
  [ -f "$PROJECT_PATH" ] || { echo "[run] project not found: $PROJECT_PATH" >&2; exit 2; }
  PROJECT_FORMAT="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(p.format ?? "")' "$PROJECT_PATH")"
  if [ "$PROJECT_FORMAT" = "noveltea.compiled.project" ]; then
    echo "[run] --project must name a saved editor project, not compiled-project JSON" >&2
    exit 2
  fi
  if [ -z "$EXPORT_PROFILE_ID" ]; then
    EXPORT_PROFILE_ID="$(node -e '
      const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const profiles=p.settings?.platformExport?.profiles ?? [];
      const selected=p.settings?.platformExport?.selectedProfileId;
      const profile=profiles.find((x)=>x?.id===selected && x?.target==="linux" && x?.buildFlavor==="release") ?? profiles.find((x)=>x?.target==="linux" && x?.buildFlavor==="release");
      if (!profile?.id) process.exit(1); console.log(profile.id);
    ' "$PROJECT_PATH")" || {
      echo "[run] no release Linux export profile found; pass --export-profile" >&2
      exit 2
    }
  fi
fi

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

if [ -n "$PROJECT_PATH" ]; then
  RUN_ROOT="$PROJECT_ROOT/build/run-desktop"
  EXPORT_ROOT="$RUN_ROOT/export"
  CONFIG_PATH="$RUN_ROOT/export-local-state.json"
  TEMPLATE_TAG="local-run-desktop"
  TEMPLATE_ARCHIVE="$PROJECT_ROOT/dist/noveltea-player-template-${TEMPLATE_TAG}-linux-x64-release.tar.gz"
  SHADERC="${SHADERC:-$PROJECT_ROOT/build/linux-debug/vcpkg_installed/x64-linux/tools/bgfx/shaderc}"
  BGFX_SHADER_INCLUDE_DIR="${BGFX_SHADER_INCLUDE_DIR:-$PROJECT_ROOT/build/linux-debug/vcpkg_installed/x64-linux/include/bgfx}"
  EDITOR_TOOL="${NOVELTEA_EDITOR_TOOL:-$PROJECT_ROOT/build/linux-debug/tools/editor_tool/noveltea-editor-tool}"

  mkdir -p "$RUN_ROOT"
  rm -rf "$EXPORT_ROOT"

  echo "[run] building host editor tool..."
  cmake --preset linux-debug -DBUILD_TESTING=OFF
  cmake --build --preset linux-debug --target noveltea-editor-tool --parallel
  [ -x "$EDITOR_TOOL" ] || { echo "[run] editor tool not found: $EDITOR_TOOL" >&2; exit 1; }
  [ -x "$SHADERC" ] || { echo "[run] shaderc not found: $SHADERC" >&2; exit 1; }
  [ -f "$BGFX_SHADER_INCLUDE_DIR/bgfx_shader.sh" ] || {
    echo "[run] bgfx shader include directory is invalid: $BGFX_SHADER_INCLUDE_DIR" >&2
    exit 1
  }

  LINUX_TEMPLATE_ARGS=(-DBUILD_TESTING=OFF)
  if [ -d "$PROJECT_ROOT/rmlui-bgfx" ]; then
    LINUX_TEMPLATE_ARGS+=(
      -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
      -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR="$PROJECT_ROOT/rmlui-bgfx"
    )
  fi
  echo "[run] building canonical Linux player template..."
  cmake --preset linux-release "${LINUX_TEMPLATE_ARGS[@]}"
  cmake --build --preset linux-release --target noveltea-player --parallel
  cmake \
    -DNOVELTEA_TEMPLATE_PRESET=linux-release \
    -DNOVELTEA_TEMPLATE_PLATFORM=linux \
    -DNOVELTEA_TEMPLATE_ARCH=x64 \
    -DNOVELTEA_RELEASE_TAG="$TEMPLATE_TAG" \
    -P cmake/PackageNovelTeaPlayerTemplate.cmake

  printf '%s\n' "$(node -e 'console.log(JSON.stringify({shaderc:process.argv[1],bgfxShaderIncludeDir:process.argv[2]}))' "$SHADERC" "$BGFX_SHADER_INCLUDE_DIR")" > "$CONFIG_PATH"
  echo "[run] compiling project through the canonical Linux exporter..."
  NOVELTEA_EDITOR_TOOL="$EDITOR_TOOL" \
    pnpm -C editor run project:export -- \
      --template "$TEMPLATE_ARCHIVE" \
      --project "$PROJECT_PATH" \
      --profile "$EXPORT_PROFILE_ID" \
      --output "$EXPORT_ROOT" \
      --config "$CONFIG_PATH" \
      --json

  PLAYER_CONFIG="$EXPORT_ROOT/bin/player.json"
  [ -f "$PLAYER_CONFIG" ] || { echo "[run] exported player config not found: $PLAYER_CONFIG" >&2; exit 1; }
  PACKAGE_PATH="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!p.package?.path) process.exit(1); console.log(p.package.path)' "$PLAYER_CONFIG")"
  APP_ARGS=(
    --project-assets "$EXPORT_ROOT/bin"
    --compiled-project "project:/$PACKAGE_PATH"
    --run-runtime
    "${APP_ARGS[@]}"
  )
fi

echo "[run] launching..."
"./$BUILD_DIR/apps/sandbox/noveltea-sandbox" "${APP_ARGS[@]}"
