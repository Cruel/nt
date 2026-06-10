# Android NDK toolchain reference.
#
# Usage (replace <ndk-version> and <abi> as needed):
#   cmake -B build/android-debug \
#       -DCMAKE_TOOLCHAIN_FILE="$ANDROID_HOME/ndk/<ndk-version>/build/cmake/android.toolchain.cmake" \
#       -DANDROID_ABI=arm64-v8a \
#       -DANDROID_PLATFORM=android-24 \
#       -DCMAKE_BUILD_TYPE=Debug
#
# Alternatively, build through the Gradle project in android/ which wires
# the NDK automatically via externalNativeBuild.

if(NOT DEFINED ANDROID_HOME)
    if(DEFINED ENV{ANDROID_HOME})
        set(ANDROID_HOME "$ENV{ANDROID_HOME}" CACHE PATH "Android SDK root")
    else()
        message(FATAL_ERROR "ANDROID_HOME not set. Export it or pass -DANDROID_HOME=<path>")
    endif()
endif()

message(STATUS "Using Android SDK at: ${ANDROID_HOME}")

# Users should point to the NDK's built-in toolchain file directly.
# This file exists as a reference and entry point.
