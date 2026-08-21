# Emscripten toolchain file.
#
# This file detects the Emscripten SDK and delegates to the official
# Emscripten CMake toolchain.
#
# Usage:
#   emcmake cmake --preset web-debug
#   # or manually:
#   cmake -B build/web-debug \
#       -DCMAKE_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
#       -DCMAKE_BUILD_TYPE=Debug

if(NOT DEFINED EMSDK)
    if(DEFINED ENV{EMSDK})
        set(EMSDK "$ENV{EMSDK}")
    else()
        message(FATAL_ERROR
            "EMSDK not set.\n"
            "Install Emscripten and set EMSDK, or use: emcmake cmake --preset web-debug"
        )
    endif()
endif()

# emcmake may provide EMSDK as a normal CMake variable rather than a cache entry.
# Persist the resolved SDK root so later packaging can inventory Emscripten ports.
set(EMSDK "${EMSDK}" CACHE PATH "Emscripten SDK root" FORCE)

message(STATUS "Using Emscripten SDK at: ${EMSDK}")
include("${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake")
