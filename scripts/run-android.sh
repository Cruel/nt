#!/usr/bin/env bash
set -euo pipefail

RELEASE=0
DEVTOOLS=0
PROJECT_PATH=""
PROFILE_ID=""
DEVICE_SERIAL=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release)
      RELEASE=1
      shift
      ;;
    --devtools)
      DEVTOOLS=1
      shift
      ;;
    --project)
      PROJECT_PATH="${2:-}"
      [ -n "$PROJECT_PATH" ] || { echo "[run] --project requires a path" >&2; exit 2; }
      shift 2
      ;;
    --device)
      DEVICE_SERIAL="${2:-}"
      [ -n "$DEVICE_SERIAL" ] || { echo "[run] --device requires a serial" >&2; exit 2; }
      shift 2
      ;;
    --profile)
      PROFILE_ID="${2:-}"
      [ -n "$PROFILE_ID" ] || { echo "[run] --profile requires an id" >&2; exit 2; }
      shift 2
      ;;
    *)
      echo "[run] unknown argument: $1" >&2
      echo "usage: $0 [--release] [--devtools] [--project path/to/project.yaml] [--profile profile-id] [--device SERIAL]" >&2
      exit 2
      ;;
  esac
done

AVD_NAME="${AVD_NAME:-noveltea_api35}"
ACTIVITY="${ACTIVITY:-org.noveltea.player.MainActivity}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/android-device.sh"
android_select_target

if [ "$RELEASE" = "1" ]; then
  GRADLE_TASK="assembleRelease"
  GRADLE_ARGS=("$GRADLE_TASK" "-PnovelteaUseDebugSigningForRelease=true" "-PnovelteaAbi=$ANDROID_ABI" "-PnovelteaEnableDevtools=$([ "$DEVTOOLS" = "1" ] && echo true || echo false)")
else
  GRADLE_TASK="assembleDebug"
  GRADLE_ARGS=("$GRADLE_TASK" "-PnovelteaAbi=$ANDROID_ABI")
fi
RUN_ROOT="$PROJECT_ROOT/build/run-android"
FIXTURE_ROOT="$RUN_ROOT/fixture"
mkdir -p "$RUN_ROOT"

BUNDLETOOL_VERSION="1.18.1"
BUNDLETOOL_SHA256="675786493983787ffa11550bdb7c0715679a44e1643f3ff980a529e9c822595c"
if [ -z "${NOVELTEA_BUNDLETOOL_JAR:-}" ]; then
  NOVELTEA_BUNDLETOOL_JAR="$PROJECT_ROOT/build/tools/bundletool-all-$BUNDLETOOL_VERSION.jar"
  if [ ! -f "$NOVELTEA_BUNDLETOOL_JAR" ]; then
    mkdir -p "$(dirname "$NOVELTEA_BUNDLETOOL_JAR")"
    echo "[run] downloading checksum-pinned bundletool $BUNDLETOOL_VERSION..."
    BUNDLETOOL_TEMP="$(mktemp "$NOVELTEA_BUNDLETOOL_JAR.XXXXXX")"
    trap 'rm -f "$BUNDLETOOL_TEMP"' EXIT
    curl -fL -o "$BUNDLETOOL_TEMP" \
      "https://github.com/google/bundletool/releases/download/$BUNDLETOOL_VERSION/bundletool-all-$BUNDLETOOL_VERSION.jar"
    printf '%s  %s\n' "$BUNDLETOOL_SHA256" "$BUNDLETOOL_TEMP" | sha256sum -c -
    mv "$BUNDLETOOL_TEMP" "$NOVELTEA_BUNDLETOOL_JAR"
    trap - EXIT
  fi
fi
[ -f "$NOVELTEA_BUNDLETOOL_JAR" ] || {
  echo "[run] bundletool JAR not found: $NOVELTEA_BUNDLETOOL_JAR" >&2
  exit 1
}
printf '%s  %s\n' "$BUNDLETOOL_SHA256" "$NOVELTEA_BUNDLETOOL_JAR" | sha256sum -c -
NOVELTEA_BUNDLETOOL_JAR="$(realpath "$NOVELTEA_BUNDLETOOL_JAR")"

cd "$PROJECT_ROOT"
if [ -z "${NOVELTEA_CLI:-}" ]; then
  NOVELTEA_CLI="$PROJECT_ROOT/build/cli/linux/noveltea"
  if [ ! -x "$NOVELTEA_CLI" ]; then
    echo "[run] building missing NovelTea host CLI..."
    pnpm -C editor run noveltea:build
  fi
fi
[ -x "$NOVELTEA_CLI" ] || { echo "[run] NovelTea host CLI not found: $NOVELTEA_CLI" >&2; exit 1; }
export NOVELTEA_CLI
if [ -z "${BGFX_SHADER_INCLUDE_DIR:-}" ]; then
  if [ -n "${NOVELTEA_PREBUILT_SHADERC_ROOT:-}" ]; then
    BGFX_SHADER_INCLUDE_DIR="$NOVELTEA_PREBUILT_SHADERC_ROOT/resources"
  else
    BGFX_SHADER_INCLUDE_DIR="$PROJECT_ROOT/build/linux-authoring-release/_deps/bgfx.cmake-src/bgfx/src"
  fi
fi
[ -f "$BGFX_SHADER_INCLUDE_DIR/bgfx_shader.sh" ] || {
  echo "[run] bgfx shader include directory is invalid: $BGFX_SHADER_INCLUDE_DIR" >&2
  echo "[run] set BGFX_SHADER_INCLUDE_DIR to a directory containing bgfx_shader.sh" >&2
  exit 1
}
GRADLE_ARGS+=("-PnovelteaCli=$NOVELTEA_CLI" "-PbgfxShaderInclude=$BGFX_SHADER_INCLUDE_DIR")

cd "$PROJECT_ROOT/android"

echo "[run] building android app ($GRADLE_TASK)..."
./gradlew "${GRADLE_ARGS[@]}"

FLAVOR="debug"
[ "$RELEASE" = "1" ] && FLAVOR="release"
NATIVE_DIRECTORY="$PROJECT_ROOT/android/app/build/noveltea-native/$FLAVOR/$ANDROID_ABI"
[ -f "$NATIVE_DIRECTORY/libnoveltea-player.so" ] || {
  echo "[run] published native player not found: $NATIVE_DIRECTORY/libnoveltea-player.so" >&2
  exit 1
}
[ -f "$NATIVE_DIRECTORY/libSDL3.so" ] || {
  echo "[run] native build output is missing libSDL3.so: $NATIVE_DIRECTORY" >&2
  exit 1
}
SHADER_ASSET_SOURCE="$PROJECT_ROOT/android/app/build/generated/noveltea/shaders"
[ -d "$SHADER_ASSET_SOURCE" ] || { echo "[run] shader assets not found: $SHADER_ASSET_SOURCE" >&2; exit 1; }

cd "$PROJECT_ROOT"
if [ -z "$PROJECT_PATH" ]; then
  rm -rf "$FIXTURE_ROOT"
  echo "[run] materializing the Android platform-export acceptance project..."
  FIXTURE_JSON="$(pnpm -C editor run android:fixture -- --root "$FIXTURE_ROOT" --abi "$ANDROID_ABI" --flavor "$FLAVOR")"
  PROJECT_PATH="$(node -e 'const chunks=require("fs").readFileSync(0,"utf8").trim().split(/\n/); console.log(JSON.parse(chunks.at(-1)).projectPath)' <<<"$FIXTURE_JSON")"
  PROFILE_ID="$(node -e 'const chunks=require("fs").readFileSync(0,"utf8").trim().split(/\n/); console.log(JSON.parse(chunks.at(-1)).profileId)' <<<"$FIXTURE_JSON")"
else
  if [ -d "$PROJECT_PATH" ]; then
    PROJECT_PATH="$PROJECT_PATH/project.yaml"
  fi
  PROJECT_PATH="$(realpath "$PROJECT_PATH")"
  PROJECT_FORMAT="$(node -e 'const {parse}=require(process.argv[2]); const p=parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(p.format ?? "")' "$PROJECT_PATH" "$PROJECT_ROOT/editor/node_modules/yaml")"
  if [ "$PROJECT_FORMAT" = "noveltea.compiled.project" ]; then
    echo "[run] --project must name a saved editor project, not compiled-project JSON" >&2
    echo "[run] compiled-project JSON lacks source assets, application identity, and platform export profiles" >&2
    exit 2
  fi
  if [ -z "$PROFILE_ID" ]; then
    PROFILE_ID="$(node -e '
      const p=require(process.argv[4]).parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const profiles=p.export?.profiles ?? [];
      const profile=profiles.find((x)=>x?.target==="android" && x?.buildFlavor===process.argv[2] && x?.android?.abi===process.argv[3]);
      if (!profile?.id) process.exit(1); console.log(profile.id);
    ' "$PROJECT_PATH" "$FLAVOR" "$ANDROID_ABI" "$PROJECT_ROOT/editor/node_modules/yaml")" || {
      echo "[run] no matching Android $FLAVOR/$ANDROID_ABI platform-export profile; pass --profile" >&2
      exit 2
    }
  fi
fi

if [ -z "${JAVA_HOME:-}" ]; then
  if [ -d /usr/lib/jvm/java-17-openjdk-amd64 ]; then
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
  elif [ "$(uname -s)" = "Darwin" ] && /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
    JAVA_HOME="$(/usr/libexec/java_home -v 17)"
  else
    JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
  fi
fi
export JAVA_HOME
TEMPLATE_TAG="local-run-android"
echo "[run] packaging and installing the immutable Android player template..."
cmake \
  -DNOVELTEA_RELEASE_TAG="$TEMPLATE_TAG" \
  -DNOVELTEA_ANDROID_ABI="$ANDROID_ABI" \
  -DNOVELTEA_ANDROID_FLAVOR="$FLAVOR" \
  -DNOVELTEA_BUNDLETOOL_JAR="$NOVELTEA_BUNDLETOOL_JAR" \
  -P cmake/PackageNovelTeaAndroidPlayerTemplate.cmake
TEMPLATE_ARCHIVE="$(find "$PROJECT_ROOT/dist" -maxdepth 1 -name "noveltea-player-template-${TEMPLATE_TAG}-android-${ANDROID_ABI}-${FLAVOR}.*" -print -quit)"
[ -n "$TEMPLATE_ARCHIVE" ] || { echo "[run] packaged Android template was not found" >&2; exit 1; }
export NOVELTEA_TEMPLATE_REGISTRY_ROOT="$RUN_ROOT/templates"
"$NOVELTEA_CLI" --json platform template install "$TEMPLATE_ARCHIVE" --force
CONFIG_PATH="$RUN_ROOT/export-local-state.json"
CONFIG_ARGS=(--output "$CONFIG_PATH")
SIGN_ARGS=()
if [ "$RELEASE" = "1" ]; then
  # Local release playback uses the Android debug certificate, never a distribution key.
  DEBUG_KEYSTORE="${ANDROID_USER_HOME:-$HOME/.android}/debug.keystore"
  [ -f "$DEBUG_KEYSTORE" ] || {
    echo "[run] Android debug keystore not found: $DEBUG_KEYSTORE" >&2
    exit 1
  }
  CONFIG_ARGS+=(--debug-signing-keystore "$DEBUG_KEYSTORE")
  SIGN_ARGS+=(--sign)
  export NOVELTEA_ANDROID_RUN_DEBUG_STORE_PASSWORD=android
  export NOVELTEA_ANDROID_RUN_DEBUG_KEY_PASSWORD=android
fi
pnpm android:export-config -- "${CONFIG_ARGS[@]}"
EXPORT_ROOT="$RUN_ROOT/export"
rm -rf "$EXPORT_ROOT"
echo "[run] exporting the project through noveltea platform export..."
"$NOVELTEA_CLI" --project "$(dirname "$PROJECT_PATH")" --json platform export \
  --profile "$PROFILE_ID" \
  --output "$EXPORT_ROOT" \
  --config "$CONFIG_PATH" \
  "${SIGN_ARGS[@]}" \
  --allow-untrusted-template \
  --allow-localization-warnings
DEFAULT_APK="$(find "$EXPORT_ROOT" -name '*.apk' -print -quit)"
APK="${APK:-$DEFAULT_APK}"

if [ ! -f "$APK" ]; then
  echo "[run] APK not found: $APK" >&2
  exit 1
fi

if [ -z "${PKG:-}" ]; then
  AAPT2="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/build-tools/35.0.0/aapt2"
  [ -x "$AAPT2" ] || { echo "[run] aapt2 is required to inspect the exported APK" >&2; exit 1; }
  PKG="$($AAPT2 dump packagename "$APK")"
fi

if [[ "$APK" == *-unsigned.apk ]]; then
  echo "[run] unsigned APKs cannot be installed by adb; Android requires an APK signing certificate" >&2
  exit 1
fi
APKSIGNER="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}/build-tools/35.0.0/apksigner"
[ -x "$APKSIGNER" ] || { echo "[run] apksigner is required to verify the exported APK" >&2; exit 1; }
if ! "$APKSIGNER" verify "$APK"; then
  echo "[run] exported APK has no valid Android signature: $APK" >&2
  exit 1
fi

echo "[run] unlocking screen..."
adb -s "$DEVICE_SERIAL" shell input keyevent 82 || true

echo "[run] installing APK: $APK"
adb -s "$DEVICE_SERIAL" install -r "$APK"

echo "[run] launching app..."
adb -s "$DEVICE_SERIAL" shell am start -n "$PKG/$ACTIVITY"

echo "[run] logcat:"
adb -s "$DEVICE_SERIAL" logcat | grep --line-buffered -iE 'noveltea|SDL|\[perf\]|\[frame-perf\]|native|crash|fatal|AndroidRuntime'
