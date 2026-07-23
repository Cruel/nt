#!/usr/bin/env bash
set -euo pipefail

MODE="debug"
MODE_EXPLICIT=0
PROJECT_PATH=""
EXPORT_PROFILE_ID=""
READBACK_GALLERY=0
CROSS_ORIGIN_ISOLATED=0

usage() {
  echo "usage: $0 [--readback-gallery [--release|--profile]] [--project path/to/project.json] [--export-profile profile-id]" >&2
  echo "       --release and --profile imply --readback-gallery" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release)
      MODE="release"
      MODE_EXPLICIT=1
      shift
      ;;
    --profile)
      MODE="profile"
      MODE_EXPLICIT=1
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
    --readback-gallery)
      READBACK_GALLERY=1
      shift
      ;;
    *)
      echo "[run] unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ "$MODE_EXPLICIT" = "1" ]; then
  READBACK_GALLERY=1
fi
if [ "$READBACK_GALLERY" = "1" ] && { [ -n "$PROJECT_PATH" ] || [ -n "$EXPORT_PROFILE_ID" ]; }; then
  echo "[run] --project and --export-profile cannot be used with the readback gallery" >&2
  usage
  exit 2
fi

case "$MODE" in
  debug) PRESET="web-debug" ;;
  release) PRESET="web-release" ;;
  profile) PRESET="web-profile" ;;
  *) echo "[run] internal error: unknown mode $MODE" >&2; exit 2 ;;
esac

PORT="${PORT:-8080}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_ROOT="$PROJECT_ROOT/build/run-web"
FIXTURE_ROOT="$RUN_ROOT/fixture"
EXPORT_ROOT="$RUN_ROOT/export"
CONFIG_PATH="$RUN_ROOT/export-local-state.json"
TEMPLATE_TAG="local-run-web"

cd "$PROJECT_ROOT"

if [ "$READBACK_GALLERY" = "1" ]; then
  CMAKE_CONFIGURE_ARGS=(
    -DNOVELTEA_WEB_SHELL_FILE="$PROJECT_ROOT/web/shell.html"
  )
  if [ -d "$PROJECT_ROOT/rmlui-bgfx" ]; then
    echo "[run] using local rmlui-bgfx checkout at $PROJECT_ROOT/rmlui-bgfx"
    CMAKE_CONFIGURE_ARGS+=(
      -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
      -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR="$PROJECT_ROOT/rmlui-bgfx"
    )
  fi
  echo "[run] configuring Web sandbox ($PRESET)..."
  cmake --preset "$PRESET" "${CMAKE_CONFIGURE_ARGS[@]}"
  echo "[run] building Web sandbox ($PRESET)..."
  cmake --build --preset "$PRESET" --target noveltea-sandbox --parallel
  SERVE_ROOT="$PROJECT_ROOT/build/$PRESET/apps/sandbox"
  if [ "$MODE" = "profile" ]; then
    DEFAULT_QUERY="demo=none&noImgui=1&renderPerf=1&rmlui-document=project:/rmlui/readback_gallery.rml"
  else
    DEFAULT_QUERY="demo=none&noImgui=1&rmlui-document=project:/rmlui/readback_gallery.rml"
  fi
else
  mkdir -p "$RUN_ROOT"
  rm -rf "$EXPORT_ROOT"

  if [ -z "$PROJECT_PATH" ]; then
    rm -rf "$FIXTURE_ROOT"
    echo "[run] materializing the canonical Web export fixture..."
    FIXTURE_JSON="$(pnpm -C editor run web:fixture -- --root "$FIXTURE_ROOT" --flavor release)"
    PROJECT_PATH="$(node -e 'const chunks=require("fs").readFileSync(0,"utf8").trim().split(/\n/); console.log(JSON.parse(chunks.at(-1)).projectPath)' <<<"$FIXTURE_JSON")"
    EXPORT_PROFILE_ID="$(node -e 'const chunks=require("fs").readFileSync(0,"utf8").trim().split(/\n/); console.log(JSON.parse(chunks.at(-1)).profileId)' <<<"$FIXTURE_JSON")"
  else
    PROJECT_PATH="$(realpath "$PROJECT_PATH")"
    if [ -z "$EXPORT_PROFILE_ID" ]; then
      EXPORT_PROFILE_ID="$(node -e '
        const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
        const profiles=p.settings?.platformExport?.profiles ?? [];
        const selected=p.settings?.platformExport?.selectedProfileId;
        const profile=profiles.find((x)=>x?.id===selected && x?.target==="web" && x?.buildFlavor==="release") ?? profiles.find((x)=>x?.target==="web" && x?.buildFlavor==="release");
        if (!profile?.id) process.exit(1); console.log(profile.id);
      ' "$PROJECT_PATH")" || {
        echo "[run] no release Web export profile found; pass --export-profile" >&2
        exit 2
      }
    fi
  fi

  WEB_THREADING="$(node -e '
    const project=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const profiles=project.settings?.platformExport?.profiles ?? [];
    const profile=profiles.find((item)=>item?.id===process.argv[2]);
    if (!profile || profile.target!=="web" || profile.buildFlavor!=="release") process.exit(1);
    console.log(profile.web?.threaded===true ? "threads" : "single");
  ' "$PROJECT_PATH" "$EXPORT_PROFILE_ID")" || {
    echo "[run] Web export profile '$EXPORT_PROFILE_ID' was not found or is not a release Web profile" >&2
    exit 2
  }
  if [ "$WEB_THREADING" = "threads" ]; then
    WEB_PRESET="web-release-threads"
    TEMPLATE_SUFFIX="-threads"
    CROSS_ORIGIN_ISOLATED=1
  else
    WEB_PRESET="web-release"
    TEMPLATE_SUFFIX=""
  fi
  TEMPLATE_ARCHIVE="$PROJECT_ROOT/dist/noveltea-player-template-${TEMPLATE_TAG}-web-wasm32${TEMPLATE_SUFFIX}-release.zip"

  SHADERC="${SHADERC:-$PROJECT_ROOT/build/linux-debug/vcpkg_installed/x64-linux/tools/bgfx/shaderc}"
  BGFX_SHADER_INCLUDE_DIR="${BGFX_SHADER_INCLUDE_DIR:-$PROJECT_ROOT/build/linux-debug/vcpkg_installed/x64-linux/include/bgfx}"
  EDITOR_TOOL="${NOVELTEA_EDITOR_TOOL:-$PROJECT_ROOT/build/linux-debug/tools/editor_tool/noveltea-editor-tool}"

  echo "[run] configuring and building the host editor tool..."
  cmake --preset linux-debug -DBUILD_TESTING=OFF
  cmake --build --preset linux-debug --target noveltea-editor-tool --parallel
  [ -x "$EDITOR_TOOL" ] || { echo "[run] editor tool not found: $EDITOR_TOOL" >&2; exit 1; }
  [ -x "$SHADERC" ] || { echo "[run] shaderc not found: $SHADERC" >&2; exit 1; }
  [ -f "$BGFX_SHADER_INCLUDE_DIR/bgfx_shader.sh" ] || {
    echo "[run] bgfx shader include directory is invalid: $BGFX_SHADER_INCLUDE_DIR" >&2
    exit 1
  }

  WEB_CMAKE_ARGS=(-DBUILD_TESTING=OFF)
  if [ -d "$PROJECT_ROOT/rmlui-bgfx" ]; then
    echo "[run] using local rmlui-bgfx checkout at $PROJECT_ROOT/rmlui-bgfx"
    WEB_CMAKE_ARGS+=(
      -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
      -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR="$PROJECT_ROOT/rmlui-bgfx"
    )
  fi
  echo "[run] configuring canonical Web player template ($WEB_PRESET, $WEB_THREADING)..."
  cmake --preset "$WEB_PRESET" "${WEB_CMAKE_ARGS[@]}"
  echo "[run] building canonical Web player template ($WEB_PRESET)..."
  cmake --build --preset "$WEB_PRESET" --target noveltea-player --parallel
  cmake \
    -DNOVELTEA_TEMPLATE_PRESET="$WEB_PRESET" \
    -DNOVELTEA_RELEASE_TAG="$TEMPLATE_TAG" \
    -P cmake/PackageNovelTeaWebPlayerTemplate.cmake

  printf '%s\n' "$(node -e 'console.log(JSON.stringify({shaderc:process.argv[1],bgfxShaderIncludeDir:process.argv[2]}))' "$SHADERC" "$BGFX_SHADER_INCLUDE_DIR")" > "$CONFIG_PATH"
  echo "[run] exporting project through the canonical Web exporter..."
  NOVELTEA_EDITOR_TOOL="$EDITOR_TOOL" \
    pnpm -C editor run project:export -- \
      --template "$TEMPLATE_ARCHIVE" \
      --project "$PROJECT_PATH" \
      --profile "$EXPORT_PROFILE_ID" \
      --output "$EXPORT_ROOT" \
      --config "$CONFIG_PATH" \
      --json

  SERVE_ROOT="$EXPORT_ROOT"
  DEFAULT_QUERY=""
fi

echo "[run] starting web server at http://localhost:$PORT"
if [ -n "$DEFAULT_QUERY" ]; then
  echo "[run] URL: http://localhost:$PORT/?$DEFAULT_QUERY"
else
  echo "[run] URL: http://localhost:$PORT/"
fi
cd "$SERVE_ROOT"
python3 - "$PORT" "$DEFAULT_QUERY" "$CROSS_ORIGIN_ISOLATED" <<'PY'
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import sys
from urllib.parse import urlsplit


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        request = urlsplit(self.path)
        if default_query and request.path in ("", "/") and not request.query:
            self.send_response(302)
            self.send_header("Location", "/?" + default_query)
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        if cross_origin_isolated:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1])
default_query = sys.argv[2]
cross_origin_isolated = sys.argv[3] == "1"
server = ThreadingHTTPServer(("", port), CrossOriginIsolatedHandler)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
PY
