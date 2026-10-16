#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVICE_SERIAL=""
MODE="release"
BUILD=1
PULL=0
APP_ARGS=()

usage() {
  echo "usage: $0 [--debug] [--device SERIAL] [--no-build] [--pull] [-- benchmark flags]"
  echo "  Optimized, debug-signed Android benchmark APK by default; --debug selects Debug."
  echo "  --pull retrieves app-private JSON reports from the installed benchmark APK."
  echo "  e.g. $0 -- --scenario raw-bgfx-geometry --smoke --no-ui"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --debug) MODE="debug"; shift ;;
    --no-build) BUILD=0; shift ;;
    --pull) PULL=1; shift ;;
    --device)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { usage >&2; exit 2; }
      DEVICE_SERIAL="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    --) shift; APP_ARGS=("$@"); break ;;
    *) echo "[benchmark] unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

AVD_NAME="${AVD_NAME:-noveltea_api35}"
source "$SCRIPT_DIR/android-device.sh"
android_select_target
ADB=(adb -s "$DEVICE_SERIAL")
APP_ID="org.noveltea.benchmark"
ACTIVITY="$APP_ID/.BenchmarkActivity"
VARIANT="Release"
[ "$MODE" = "debug" ] && VARIANT="Debug"
APK="$PROJECT_ROOT/android/benchmark/build/outputs/apk/$MODE/benchmark-$MODE.apk"

if [ "$BUILD" = 1 ]; then
  cd "$PROJECT_ROOT/android"
  ./gradlew ":benchmark:assemble$VARIANT" "-PnovelteaAbi=$ANDROID_ABI"
fi
[ -f "$APK" ] || { echo "[benchmark] missing APK: $APK" >&2; exit 1; }

"${ADB[@]}" install -r "$APK"
if [ "$PULL" = 1 ]; then
  RESULT_DIR="$PROJECT_ROOT/build/benchmark-android-results/$DEVICE_SERIAL"
  mkdir -p "$RESULT_DIR"
  "${ADB[@]}" shell run-as "$APP_ID" pwd >/dev/null || {
    echo "[benchmark] run-as unavailable; install the debug-signed benchmark APK" >&2
    exit 1
  }
  mapfile -t REPORTS < <("${ADB[@]}" shell "run-as $APP_ID find files -name '*.json' -type f" | tr -d '\r')
  for report in "${REPORTS[@]}"; do
    [ -n "$report" ] || continue
    case "$report" in files/*) ;; *) echo "[benchmark] unsafe report path: $report" >&2; exit 1 ;; esac
    filename="${report##*/}"
    "${ADB[@]}" exec-out run-as "$APP_ID" cat "$report" > "$RESULT_DIR/$filename"
    echo "[benchmark] saved $RESULT_DIR/$filename"
  done
  exit 0
fi

"${ADB[@]}" shell am force-stop "$APP_ID"
"${ADB[@]}" logcat -c
if [ "${#APP_ARGS[@]}" -gt 0 ]; then
  for flag in "${APP_ARGS[@]}"; do
    [[ "$flag" =~ ^[a-zA-Z0-9_.:/=-]+$ ]] || {
      echo "[benchmark] flags must contain only letters, digits and ._:/=-" >&2
      exit 2
    }
  done
  "${ADB[@]}" shell "am start -n $ACTIVITY --es novelteaBenchmarkArgs '${APP_ARGS[*]}'"
else
  "${ADB[@]}" shell am start -n "$ACTIVITY"
fi
echo "[benchmark] APK launched on $DEVICE_SERIAL. Log: adb -s $DEVICE_SERIAL logcat -s 'SDL/APP:V'"
echo "[benchmark] Reports: $0 --device $DEVICE_SERIAL --no-build --pull"
