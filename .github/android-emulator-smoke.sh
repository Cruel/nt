#!/usr/bin/env bash
set -euo pipefail

sdk_root=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [[ -n "$sdk_root" && -x "$sdk_root/platform-tools/adb" ]]; then
  adb="$sdk_root/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
  adb=$(command -v adb)
else
  echo 'Android platform-tools/adb was not found' >&2
  exit 127
fi

apk_v1=${1:?first APK required}
apk_v2=${2:?updated APK required}
application_id=${3:-org.noveltea.platformexportacceptance}
abi=${4:-x86_64}

dump_startup_diagnostics() {
  local pid
  pid=$("$adb" shell pidof "$application_id" 2>/dev/null | tr -d '\r' || true)
  echo '--- Android process state ---' >&2
  printf '%s\n' "${pid:-not running}" >&2
  echo '--- NovelTea process logcat ---' >&2
  if [[ -n "$pid" ]]; then
    "$adb" logcat -d --pid="$pid" >&2 || "$adb" logcat -d | grep -Ei 'noveltea|SDL|org\.noveltea\.platformexportacceptance' >&2 || true
  else
    "$adb" logcat -d | grep -Ei 'noveltea|SDL|org\.noveltea\.platformexportacceptance|FATAL EXCEPTION|DEBUG' >&2 || true
  fi
  echo '--- NovelTea player.log ---' >&2
  "$adb" shell run-as "$application_id" cat files/logs/player.log >&2 || true
  echo '--- NovelTea app files ---' >&2
  "$adb" shell run-as "$application_id" find files -maxdepth 4 -type f -print >&2 || true
}

wait_for_player_ready() {
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if "$adb" logcat -d | grep -q "NOVELTEA_PLAYER_READY application=$application_id"; then
      return 0
    fi
    if ! "$adb" shell pidof "$application_id" >/dev/null 2>&1; then
      echo "NovelTea player process exited before reporting readiness." >&2
      dump_startup_diagnostics
      return 1
    fi
    sleep 1
  done
  echo "Timed out waiting for NovelTea player readiness." >&2
  dump_startup_diagnostics
  return 124
}

"$adb" wait-for-device
until [[ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do sleep 2; done
"$adb" logcat -c
"$adb" install -r "$apk_v1"
"$adb" shell pm path "$application_id" >/dev/null
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"
wait_for_player_ready

"$adb" shell run-as "$application_id" mkdir -p files/saves
"$adb" shell run-as "$application_id" sh -c 'printf phase8-save > files/saves/ci-save-marker'
"$adb" shell input keyevent KEYCODE_HOME
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"
"$adb" shell settings put system accelerometer_rotation 0 || true
"$adb" shell settings put system user_rotation 1 || true
"$adb" shell input keyevent KEYCODE_VOLUME_DOWN
"$adb" shell input keyevent KEYCODE_VOLUME_UP
"$adb" shell am force-stop "$application_id"
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"

before=$("$adb" shell run-as "$application_id" find files/bootstrap -name game.ntpkg | tr -d '\r')
test -n "$before"
"$adb" install -r "$apk_v2"
"$adb" logcat -c
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"
wait_for_player_ready
test "$("$adb" shell run-as "$application_id" cat files/saves/ci-save-marker | tr -d '\r')" = phase8-save
after=$("$adb" shell run-as "$application_id" find files/bootstrap -name game.ntpkg | tr -d '\r')
test -n "$after"
test "$before" != "$after"

unzip -l "$apk_v2" | grep -q "lib/$abi/libnoveltea-player.so"
if unzip -l "$apk_v2" | grep -Eiq 'sandbox|lua_demo|preview|editor[-_ ]ipc|recorder'; then
  echo 'Forbidden development surface found in exported APK' >&2
  exit 1
fi
