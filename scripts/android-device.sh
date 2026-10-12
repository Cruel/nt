#!/usr/bin/env bash

android_require_terminal() {
  if [ ! -t 0 ]; then
    echo "[run] device selection requires a terminal; connect one device or pass --device SERIAL" >&2
    return 1
  fi
}

android_wait_for_target() {
  local deadline=$((SECONDS + 180))
  while ! adb -s "$DEVICE_SERIAL" get-state 2>/dev/null | grep -qx device; do
    if [ -n "${EMULATOR_PID:-}" ] && ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
      echo "[run] emulator exited before connecting; see ${TMPDIR:-/tmp}/noveltea-emulator.log" >&2
      return 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "[run] timed out waiting for ADB target: $DEVICE_SERIAL" >&2
      return 1
    fi
    sleep 1
  done
  echo "[run] waiting for Android boot completion: $DEVICE_SERIAL"
  deadline=$((SECONDS + 180))
  until adb -s "$DEVICE_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -qx 1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "[run] timed out waiting for Android boot: $DEVICE_SERIAL" >&2
      return 1
    fi
    sleep 1
  done
}

android_select_target() {
  local listing serial state details choice model abis abi port
  local -a online=() labels=() unavailable=() all_serials=()
  echo "[run] finding ADB devices..."
  listing="$(adb devices -l)" || return 1
  while read -r serial state details; do
    [ -n "$serial" ] || continue
    case "$state" in
      device)
        online+=("$serial")
        labels+=("$serial ${details:-}")
        all_serials+=("$serial")
        ;;
      offline|unauthorized)
        unavailable+=("$serial ($state)")
        all_serials+=("$serial")
        ;;
    esac
  done <<< "$listing"
  for details in "${unavailable[@]}"; do
    echo "[run] unavailable ADB target: $details" >&2
  done

  if [ -n "$DEVICE_SERIAL" ]; then
    for details in "${unavailable[@]}"; do
      if [[ "$details" == "$DEVICE_SERIAL ("* ]]; then
        echo "[run] authorize/reconnect the selected device before running: $DEVICE_SERIAL" >&2
        return 1
      fi
    done
    echo "[run] targeting ADB device: $DEVICE_SERIAL"
  elif [ "${#online[@]}" -eq 1 ]; then
    DEVICE_SERIAL="${online[0]}"
  elif [ "${#online[@]}" -gt 1 ]; then
    for ((choice=0; choice<${#online[@]}; choice++)); do
      printf '[run] %d) %s\n' "$((choice + 1))" "${labels[choice]}"
    done
    android_require_terminal || return 1
    while true; do
      read -r -p "[run] select device [1-${#online[@]}]: " choice || return 1
      if [[ "$choice" =~ ^[1-9][0-9]*$ ]] && [ "${#choice}" -le 4 ] &&
         [ "$choice" -le "${#online[@]}" ]; then
        DEVICE_SERIAL="${online[choice-1]}"
        break
      fi
      echo "[run] enter one of the listed device numbers" >&2
    done
  else
    if [ "${#unavailable[@]}" -gt 0 ]; then
      echo "[run] no usable ADB targets; authorize/reconnect the listed devices first" >&2
      return 1
    fi
    android_require_terminal || return 1
    read -r -p "[run] no connected devices. Launch emulator '$AVD_NAME'? [y/N]: " choice || return 1
    case "$choice" in
      y|Y|yes|YES) ;;
      *) echo "[run] cancelled; nothing built"; return 1 ;;
    esac
    # Pin the emulator we launch, rather than whichever target connects first.
    port=5554
    while printf '%s\n' "${all_serials[@]}" | grep -qx "emulator-$port" ||
          (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null ||
          (echo > "/dev/tcp/127.0.0.1/$((port + 1))") 2>/dev/null; do
      port=$((port + 2))
      if [ "$port" -gt 5682 ]; then
        echo "[run] no free emulator port pair" >&2
        return 1
      fi
    done
    DEVICE_SERIAL="emulator-$port"
    echo "[run] starting emulator: $AVD_NAME ($DEVICE_SERIAL)"
    nohup emulator @"$AVD_NAME" -port "$port" -gpu swiftshader_indirect -no-snapshot -no-audio \
      > "${TMPDIR:-/tmp}/noveltea-emulator.log" 2>&1 &
    EMULATOR_PID=$!
  fi

  android_wait_for_target || return 1
  abis="$(adb -s "$DEVICE_SERIAL" shell getprop ro.product.cpu.abilist | tr -d '\r\n')" || return 1
  if [ -z "${ANDROID_ABI:-}" ]; then
    for abi in arm64-v8a x86_64; do
      if [[ ",$abis," == *",$abi,"* ]]; then
        ANDROID_ABI="$abi"
        break
      fi
    done
  fi
  if [[ "${ANDROID_ABI:-}" != arm64-v8a && "${ANDROID_ABI:-}" != x86_64 ]] ||
     [[ ",$abis," != *",${ANDROID_ABI:-},"* ]]; then
    echo "[run] unsupported/incompatible ABI '${ANDROID_ABI:-auto}' for $DEVICE_SERIAL (supported: $abis)" >&2
    return 1
  fi
  model="$(adb -s "$DEVICE_SERIAL" shell getprop ro.product.model | tr -d '\r\n')" || return 1
  echo "[run] using ${model:-Android device} — $DEVICE_SERIAL ($ANDROID_ABI)"
}
