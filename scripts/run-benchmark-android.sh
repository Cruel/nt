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
  echo "  --config FILE after -- sends the canonical JSON via the Activity intent."
  echo "  e.g. $0 -- --config apps/benchmark/stage1-unattended.json"
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

# ADB Activity extras cannot directly reference the host filesystem. Transfer the
# exact JSON bytes as bounded Base64, then let the Activity write an app-private
# file before SDL_main. Reject mixed flags as the native --config parser does.
CONFIG_BASE64=""
HAS_CONFIG=0
for argument in "${APP_ARGS[@]}"; do
  [ "$argument" != "--config" ] || HAS_CONFIG=1
done
if [ "$HAS_CONFIG" = 1 ]; then
  if [ "${#APP_ARGS[@]}" -ne 2 ] || [ "${APP_ARGS[0]}" != "--config" ]; then
    echo "[benchmark] --config FILE cannot be mixed with other benchmark flags" >&2
    exit 2
  fi
  CONFIG_FILE="${APP_ARGS[1]}"
  if [ ! -f "$CONFIG_FILE" ] || [ ! -r "$CONFIG_FILE" ]; then
    echo "[benchmark] cannot read benchmark config: $CONFIG_FILE" >&2
    exit 2
  fi
  CONFIG_SIZE=$(wc -c < "$CONFIG_FILE")
  if [ "$CONFIG_SIZE" -lt 1 ] || [ "$CONFIG_SIZE" -gt 8192 ]; then
    echo "[benchmark] Android configuration must contain 1..8192 bytes" >&2
    exit 2
  fi
  CONFIG_BASE64=$(base64 < "$CONFIG_FILE" | tr -d '\n')
  APP_ARGS=()
fi

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
  mapfile -t REPORTS < <("${ADB[@]}" shell "run-as $APP_ID find files -path '*/results/*.json' -type f" | tr -d '\r')
  for report in "${REPORTS[@]}"; do
    [ -n "$report" ] || continue
    case "$report" in
      files/results/*.json|files/*/results/*.json) ;;
      *) echo "[benchmark] unsafe report path: $report" >&2; exit 1 ;;
    esac
    case "$report" in
      */../*|*/./*) echo "[benchmark] unsafe report path: $report" >&2; exit 1 ;;
    esac
    filename="${report##*/}"
    "${ADB[@]}" exec-out run-as "$APP_ID" cat "$report" > "$RESULT_DIR/$filename"
    echo "[benchmark] saved $RESULT_DIR/$filename"
  done
  exit 0
fi

"${ADB[@]}" logcat -c
if [ -n "$CONFIG_BASE64" ]; then
  "${ADB[@]}" shell "am start -S -n $ACTIVITY --es novelteaBenchmarkConfigBase64 '$CONFIG_BASE64'"
elif [ "${#APP_ARGS[@]}" -gt 0 ]; then
  for flag in "${APP_ARGS[@]}"; do
    [[ "$flag" =~ ^[a-zA-Z0-9_.:/=-]+$ ]] || {
      echo "[benchmark] flags must contain only letters, digits and ._:/=-" >&2
      exit 2
    }
  done
  "${ADB[@]}" shell "am start -S -n $ACTIVITY --es novelteaBenchmarkArgs '${APP_ARGS[*]}'"
else
  "${ADB[@]}" shell am start -S -n "$ACTIVITY"
fi
echo "[benchmark] APK launched on $DEVICE_SERIAL. Log: adb -s $DEVICE_SERIAL logcat -s 'SDL/APP:V'"
echo "[benchmark] Reports: $0 --device $DEVICE_SERIAL --no-build --pull"
