#!/usr/bin/env bash
set -euo pipefail

RELEASE=0
PROJECT_PATH=""
PROFILE_ID=""

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
    --profile)
      PROFILE_ID="${2:-}"
      [ -n "$PROFILE_ID" ] || { echo "[run] --profile requires an id" >&2; exit 2; }
      shift 2
      ;;
    *)
      echo "[run] unknown argument: $1" >&2
      echo "usage: $0 [--release] [--project path/to/project.json] [--profile profile-id]" >&2
      exit 2
      ;;
  esac
done

AVD_NAME="${AVD_NAME:-noveltea_api35}"
ANDROID_ABI="${ANDROID_ABI:-x86_64}"
ACTIVITY="${ACTIVITY:-org.noveltea.player.MainActivity}"

if [ "$RELEASE" = "1" ]; then
  GRADLE_TASK="assembleRelease"
  GRADLE_ARGS=("$GRADLE_TASK" "-PnovelteaUseDebugSigningForRelease=true" "-PnovelteaAbi=$ANDROID_ABI")
else
  GRADLE_TASK="assembleDebug"
  GRADLE_ARGS=("$GRADLE_TASK" "-PnovelteaAbi=$ANDROID_ABI")
fi
# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RUN_ROOT="$PROJECT_ROOT/build/run-android"
FIXTURE_ROOT="$RUN_ROOT/fixture"
GENERATED_ROOT="$RUN_ROOT/generated"
mkdir -p "$RUN_ROOT"

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
PREBUILT_NATIVE_ROOT="$(dirname "$NATIVE_DIRECTORY")"

cd "$PROJECT_ROOT"
if [ -z "$PROJECT_PATH" ]; then
  rm -rf "$FIXTURE_ROOT"
  echo "[run] materializing the Android platform-export acceptance project..."
  FIXTURE_JSON="$(pnpm android:fixture -- --root "$FIXTURE_ROOT" --abi "$ANDROID_ABI" --flavor "$FLAVOR")"
  PROJECT_PATH="$(node -e 'const chunks=require("fs").readFileSync(0,"utf8").trim().split(/\n/); console.log(JSON.parse(chunks.at(-1)).projectPath)' <<<"$FIXTURE_JSON")"
  PROFILE_ID="$(node -e 'const chunks=require("fs").readFileSync(0,"utf8").trim().split(/\n/); console.log(JSON.parse(chunks.at(-1)).profileId)' <<<"$FIXTURE_JSON")"
else
  PROJECT_PATH="$(realpath "$PROJECT_PATH")"
  PROJECT_FORMAT="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(p.format ?? "")' "$PROJECT_PATH")"
  if [ "$PROJECT_FORMAT" = "noveltea.compiled.project" ]; then
    echo "[run] --project must name a saved editor project, not compiled-project JSON" >&2
    echo "[run] compiled-project JSON lacks source assets, application identity, and platform export profiles" >&2
    exit 2
  fi
  if [ -z "$PROFILE_ID" ]; then
    PROFILE_ID="$(node -e '
      const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const profiles=p.settings?.platformExport?.profiles ?? [];
      const profile=profiles.find((x)=>x?.target==="android" && x?.buildFlavor===process.argv[2] && x?.android?.abi===process.argv[3]);
      if (!profile?.id) process.exit(1); console.log(profile.id);
    ' "$PROJECT_PATH" "$FLAVOR" "$ANDROID_ABI")" || {
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
SHADERC="${SHADERC:-$PROJECT_ROOT/build/linux-debug/vcpkg_installed/x64-linux/tools/bgfx/shaderc}"
BGFX_SHADER_INCLUDE_DIR="${BGFX_SHADER_INCLUDE_DIR:-$PROJECT_ROOT/build/linux-debug/vcpkg_installed/x64-linux/include/bgfx}"
[ -x "$SHADERC" ] || { echo "[run] shaderc not found: $SHADERC" >&2; exit 1; }
[ -f "$BGFX_SHADER_INCLUDE_DIR/bgfx_shader.sh" ] || {
  echo "[run] bgfx shader include directory is invalid: $BGFX_SHADER_INCLUDE_DIR" >&2
  exit 1
}

echo "[run] compiling the project and staging Android inputs..."
STAGE_JSON="$(pnpm android:stage-project -- \
  --project "$PROJECT_PATH" \
  --profile "$PROFILE_ID" \
  --output "$GENERATED_ROOT" \
  --shaderc "$SHADERC" \
  --bgfx-shader-include "$BGFX_SHADER_INCLUDE_DIR")"
STAGE_RESULT="$(printf '%s\n' "$STAGE_JSON" | tail -n 1)"
PROPERTIES_PATH="$(node -e 'console.log(JSON.parse(process.argv[1]).propertiesPath)' "$STAGE_RESULT")"
PKG="${PKG:-$(node -e 'console.log(JSON.parse(process.argv[1]).applicationId)' "$STAGE_RESULT")}"

echo "[run] packaging the staged project with the checked-in Android Gradle project..."
cd "$PROJECT_ROOT/android"
./gradlew \
  "${GRADLE_ARGS[@]}" \
  -PnovelteaCompileShaders=OFF \
  -PnovelteaPrebuiltShaderAssetRoot="$SHADER_ASSET_SOURCE" \
  -PnovelteaPrebuiltNativeRoot="$PREBUILT_NATIVE_ROOT" \
  -PnovelteaGeneratedRoot="$GENERATED_ROOT" \
  -PnovelteaGeneratedProperties="$PROPERTIES_PATH"

if [ "$RELEASE" = "1" ]; then
  DEFAULT_APK="$PROJECT_ROOT/android/app/build/outputs/apk/release/app-release.apk"
else
  DEFAULT_APK="$PROJECT_ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
fi
APK="${APK:-$DEFAULT_APK}"

if [ ! -f "$APK" ]; then
  echo "[run] APK not found: $APK" >&2
  exit 1
fi

if [[ "$APK" == *-unsigned.apk ]]; then
  echo "[run] unsigned APKs cannot be installed by adb; Android requires an APK signing certificate" >&2
  echo "[run] configure release signing, or use a signed APK path through APK=/path/to/app-release.apk" >&2
  exit 1
fi

if ! adb devices | grep -qE 'emulator-[0-9]+[[:space:]]+device'; then
  echo "[run] starting emulator: $AVD_NAME"
  nohup emulator @"$AVD_NAME" \
    -gpu swiftshader_indirect \
    -no-snapshot \
    -no-audio \
    > /tmp/noveltea-emulator.log 2>&1 &
fi

echo "[run] waiting for emulator..."
adb wait-for-device

echo "[run] waiting for Android boot completion..."
until adb shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; do
  sleep 1
done

echo "[run] unlocking screen..."
adb shell input keyevent 82 || true

echo "[run] installing APK: $APK"
adb install -r "$APK"

echo "[run] launching app..."
adb shell am start -n "$PKG/$ACTIVITY"

echo "[run] logcat:"
adb logcat | grep -iE 'noveltea|SDL|native|crash|fatal|AndroidRuntime'
