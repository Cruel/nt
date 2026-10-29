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

apk_bootstrap_info() {
  unzip -p "$1" assets/noveltea/bootstrap/player.json | python3 -c '
import json, re, sys
config = json.load(sys.stdin)
digest = config["package"]["sha256"]
if not re.fullmatch(r"[0-9a-f]{64}", digest) or config["package"]["path"] != "game.ntpkg":
    raise SystemExit("APK has an invalid packaged game identity")
if config["applicationId"] != sys.argv[1]:
    raise SystemExit("APK application ID differs from emulator smoke target")
print(digest, config["versionName"])
' "$application_id"
}

check_embedded_package() {
  local actual
  actual=$(unzip -p "$1" assets/noveltea/bootstrap/game.ntpkg | sha256sum)
  if [[ "${actual%% *}" != "$2" ]]; then
    echo "APK game package does not match its declared SHA-256: $1" >&2
    exit 1
  fi
}

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
  local missing_process_polls=0
  while (( SECONDS < deadline )); do
    if [[ "$("$adb" get-state 2>/dev/null || true)" != "device" ]]; then
      missing_process_polls=0
      sleep 1
      continue
    fi
    if "$adb" logcat -d | grep "NOVELTEA_PLAYER_READY application=$application_id" >/dev/null; then
      return 0
    fi
    if "$adb" shell pidof "$application_id" >/dev/null 2>&1; then
      missing_process_polls=0
    else
      if [[ "$("$adb" get-state 2>/dev/null || true)" != "device" ]]; then
        missing_process_polls=0
        sleep 1
        continue
      fi
      missing_process_polls=$((missing_process_polls + 1))
    fi
    if (( missing_process_polls >= 3 )); then
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

wait_for_package_manager_idle() {
  if "$adb" shell cmd package help 2>/dev/null | grep -q 'wait-for-handler'; then
    "$adb" shell cmd package wait-for-handler --timeout 60000
    "$adb" shell cmd package wait-for-background-handler --timeout 60000
  fi
}

check_materialized_package() {
  local phase=$1 expected_sha=$2
  local expected_path="files/bootstrap/$expected_sha/game.ntpkg"
  local actual_paths
  actual_paths=$("$adb" shell run-as "$application_id" find files/bootstrap -name game.ntpkg | tr -d '\r')
  if [[ "$actual_paths" != "$expected_path" ]]; then
    printf '%s game package mismatch (expected=%s, found=%s).\n' "$phase" "$expected_path" "$actual_paths" >&2
    dump_startup_diagnostics
    exit 1
  fi
  local installed_hash
  installed_hash=$("$adb" exec-out run-as "$application_id" cat "$expected_path" | sha256sum)
  if [[ "${installed_hash%% *}" != "$expected_sha" ]]; then
    printf '%s game package checksum mismatch (expected=%s, actual=%s).\n' "$phase" "$expected_sha" "${installed_hash%% *}" >&2
    dump_startup_diagnostics
    exit 1
  fi
}

apk_info_v1=$(apk_bootstrap_info "$apk_v1")
apk_info_v2=$(apk_bootstrap_info "$apk_v2")
read -r package_sha_v1 version_v1 <<< "$apk_info_v1"
read -r package_sha_v2 version_v2 <<< "$apk_info_v2"
if [[ "$version_v1" == "$version_v2" ]]; then
  echo "Expected different APK app versions, found $version_v1 in both fixtures." >&2
  exit 1
fi
check_embedded_package "$apk_v1" "$package_sha_v1"
check_embedded_package "$apk_v2" "$package_sha_v2"

"$adb" wait-for-device
until [[ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do sleep 2; done
"$adb" logcat -c
"$adb" install -r "$apk_v1"
wait_for_package_manager_idle
"$adb" shell pm path "$application_id" >/dev/null
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"
wait_for_player_ready

"$adb" shell run-as "$application_id" mkdir -p files/saves
printf ci-save | "$adb" shell run-as "$application_id" tee files/saves/ci-save-marker >/dev/null
"$adb" shell input keyevent KEYCODE_HOME
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"
"$adb" shell settings put system accelerometer_rotation 0 || true
"$adb" shell settings put system user_rotation 1 || true
"$adb" shell input keyevent KEYCODE_VOLUME_DOWN
"$adb" shell input keyevent KEYCODE_VOLUME_UP
"$adb" shell am force-stop "$application_id"
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"

check_materialized_package 'Initial APK' "$package_sha_v1"
"$adb" install -r "$apk_v2"
wait_for_package_manager_idle
"$adb" logcat -c
"$adb" shell am start -W -n "$application_id/org.noveltea.player.MainActivity"
wait_for_player_ready
if [[ "$("$adb" shell run-as "$application_id" cat files/saves/ci-save-marker | tr -d '\r')" != ci-save ]]; then
  echo 'APK update did not preserve the saved game marker.' >&2
  dump_startup_diagnostics
  exit 1
fi
check_materialized_package 'Updated APK' "$package_sha_v2"

unzip -l "$apk_v2" | grep "lib/$abi/libnoveltea-player.so" >/dev/null
if unzip -l "$apk_v2" | grep -Ei 'sandbox|lua_demo|preview|editor[-_ ]ipc|recorder' >/dev/null; then
  echo 'Forbidden development surface found in exported APK' >&2
  exit 1
fi
