#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_HOME:?Android SDK root is required}"
: "${ANDROID_API_LEVEL:?Android API level is required}"
: "${ANDROID_BUILD_TOOLS_VERSION:?Android build tools version is required}"
: "${ANDROID_NDK_VERSION:?Android NDK version is required}"
: "${ANDROID_CMAKE_VERSION:?Android CMake version is required}"

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
packages=(
  "platform-tools"
  "platforms;android-${ANDROID_API_LEVEL}"
  "build-tools;${ANDROID_BUILD_TOOLS_VERSION}"
  "ndk;${ANDROID_NDK_VERSION}"
  "cmake;${ANDROID_CMAKE_VERSION}"
)

# Google CDN may return a truncated/invalid archive: sdkmanager reports
# "Error on ZipFile unknown archive" and exits nonzero. Do not accept a
# partially extracted NDK or cache that temporary failed download.
for attempt in 1 2 3; do
  if "$sdkmanager" "${packages[@]}"; then
    if [[ -f "$ANDROID_HOME/ndk/$ANDROID_NDK_VERSION/source.properties" &&
          -f "$ANDROID_HOME/cmake/$ANDROID_CMAKE_VERSION/source.properties" ]]; then
      exit 0
    fi
    echo "Android SDK reported success without complete NDK/CMake packages" >&2
  fi

  if (( attempt == 3 )); then
    echo "Android SDK package installation failed after 3 attempts" >&2
    exit 1
  fi

  # Only the runner-local sdkmanager scratch downloads are discarded.
  # Valid installed packages are preserved; an incomplete package has no
  # source.properties and must not be reused as an installed SDK.
  rm -rf "$ANDROID_HOME/.temp"
  for location in "ndk/$ANDROID_NDK_VERSION" "cmake/$ANDROID_CMAKE_VERSION"; do
    if [[ -d "$ANDROID_HOME/$location" && ! -f "$ANDROID_HOME/$location/source.properties" ]]; then
      rm -rf "$ANDROID_HOME/$location"
    fi
  done
  echo "Retrying Android SDK package install ($attempt/3) after clearing incomplete downloads" >&2
  sleep "$((attempt * 3))"
done
