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

AVD_NAME="${AVD_NAME:-noveltea_api35}"
PKG="${PKG:-com.example.noveltea}"
ACTIVITY="${ACTIVITY:-com.example.noveltea.MainActivity}"

if [ "$RELEASE" = "1" ]; then
  GRADLE_TASK="assembleRelease"
  DEFAULT_APK="app/build/outputs/apk/release/app-release.apk"
  FALLBACK_APK="app/build/outputs/apk/release/app-release-unsigned.apk"
else
  GRADLE_TASK="assembleDebug"
  DEFAULT_APK="app/build/outputs/apk/debug/app-debug.apk"
  FALLBACK_APK=""
fi
APK="${APK:-$DEFAULT_APK}"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT/android"

echo "[run] building android app ($GRADLE_TASK)..."
./gradlew "$GRADLE_TASK"

if [ ! -f "$APK" ] && [ -n "$FALLBACK_APK" ] && [ -f "$FALLBACK_APK" ]; then
  APK="$FALLBACK_APK"
fi

if [ ! -f "$APK" ]; then
  echo "[run] APK not found: $APK" >&2
  exit 1
fi

if [[ "$APK" == *-unsigned.apk ]]; then
  echo "[run] warning: release APK is unsigned; adb install may fail without release signing configured" >&2
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
