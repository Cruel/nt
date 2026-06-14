#!/usr/bin/env bash
set -euo pipefail

AVD_NAME="${AVD_NAME:-noveltea_api35}"
APK="${APK:-app/build/outputs/apk/debug/app-debug.apk}"
PKG="${PKG:-com.example.noveltea}"
ACTIVITY="${ACTIVITY:-com.example.noveltea.MainActivity}"

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT/android"

echo "[run] building android app..."
./gradlew assembleDebug

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

echo "[run] installing APK..."
adb install -r "$APK"

echo "[run] launching app..."
adb shell am start -n "$PKG/$ACTIVITY"

echo "[run] logcat:"
adb logcat | grep -iE 'noveltea|SDL|native|crash|fatal|AndroidRuntime'
