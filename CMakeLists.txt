cmake_minimum_required(VERSION 3.24)
project(noveltea VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

option(NOVELTEA_BUILD_SANDBOX "Build the sandbox application" ON)
option(NOVELTEA_ENABLE_BGFX "Use bgfx renderer when available for supported targets" ON)
option(NOVELTEA_FETCH_BGFX "Download bgfx via FetchContent (Emscripten)" ON)
option(NOVELTEA_ENABLE_DEVTOOLS "Include Dear ImGui dev/debug overlay" ON)
option(NOVELTEA_USE_IMGUI "Deprecated alias for NOVELTEA_ENABLE_DEVTOOLS" ON)
option(NOVELTEA_FETCH_SDL3 "Download SDL3 via FetchContent (Android)" ON)

if(DEFINED NOVELTEA_USE_IMGUI AND NOT NOVELTEA_USE_IMGUI)
    set(NOVELTEA_ENABLE_DEVTOOLS OFF CACHE BOOL "Include Dear ImGui dev/debug overlay" FORCE)
endif()

# --- SDL3: provide the SDL3::SDL3 target for all platforms ---

if(EMSCRIPTEN)
    # Emscripten provides SDL3 via -sUSE_SDL=3; create a dummy interface target.
    add_library(SDL3::SDL3 INTERFACE IMPORTED)
    target_compile_options(SDL3::SDL3 INTERFACE -sUSE_SDL=3)
    target_link_options(SDL3::SDL3 INTERFACE -sUSE_SDL=3)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
    if(NOVELTEA_FETCH_SDL3)
        include(FetchContent)
        FetchContent_Declare(
            SDL3
            GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
            GIT_TAG release-3.2.30
            GIT_SHALLOW TRUE
        )
        set(SDL_STATIC ON CACHE BOOL "Build SDL as a static library" FORCE)
        set(SDL_SHARED OFF CACHE BOOL "Do not build SDL shared library" FORCE)
        set(SDL_TEST OFF CACHE BOOL "Disable SDL test" FORCE)
        FetchContent_MakeAvailable(SDL3)
    else()
        find_package(SDL3 CONFIG QUIET)
        if(NOT SDL3_FOUND)
            message(FATAL_ERROR "SDL3 required for Android. Set NOVELTEA_FETCH_SDL3=ON or provide SDL3 CMake config.")
        endif()
    endif()
else()
    find_package(SDL3 CONFIG QUIET)
    if(NOT SDL3_FOUND)
        message(FATAL_ERROR "SDL3 required. Install via vcpkg (Linux) or SDK (Web).")
    endif()
endif()

# --- bgfx: provide the bgfx::bgfx target for all platforms ---

if(EMSCRIPTEN AND NOVELTEA_ENABLE_BGFX AND NOVELTEA_FETCH_BGFX)
    include(FetchContent)
    set(BGFX_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(BGFX_INSTALL OFF CACHE BOOL "" FORCE)
    set(BGFX_CONFIG_MULTITHREADED OFF CACHE BOOL "" FORCE)
    set(BGFX_LIBRARY_TYPE "STATIC" CACHE STRING "" FORCE)
    # bx/bimg add -msse4.2 unconditionally; Emscripten needs -msimd128 alongside
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -msimd128")
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -msimd128")

    # Trim unused bimg decoders/parsers for Web — only keep PNG + JPEG
    add_compile_definitions(
        BIMG_CONFIG_DECODE_BC1=0  BIMG_CONFIG_DECODE_BC2=0
        BIMG_CONFIG_DECODE_BC3=0  BIMG_CONFIG_DECODE_BC4=0
        BIMG_CONFIG_DECODE_BC5=0  BIMG_CONFIG_DECODE_BC6=0
        BIMG_CONFIG_DECODE_BC7=0  BIMG_CONFIG_DECODE_ATC=0
        BIMG_CONFIG_DECODE_ASTC=0 BIMG_CONFIG_DECODE_ETC1=0
        BIMG_CONFIG_DECODE_ETC2=0
        BIMG_CONFIG_PARSE_BMP=0   BIMG_CONFIG_PARSE_EXR=0
        BIMG_CONFIG_PARSE_GIF=0   BIMG_CONFIG_PARSE_HDR=0
        BIMG_CONFIG_PARSE_PIC=0   BIMG_CONFIG_PARSE_PNM=0
        BIMG_CONFIG_PARSE_PSD=0   BIMG_CONFIG_PARSE_TGA=0
        BIMG_CONFIG_PARSE_WEBP=0
    )

    FetchContent_Declare(
        bgfx.cmake
        URL https://github.com/bkaradzic/bgfx.cmake/releases/download/v1.143.9262-545/bgfx.cmake.v1.143.9262-545.tar.gz
        SOURCE_SUBDIR .
        PATCH_COMMAND ${CMAKE_COMMAND} -P ${CMAKE_SOURCE_DIR}/cmake/patch-bgfx-emscripten.cmake
    )
    FetchContent_MakeAvailable(bgfx.cmake)
    if(NOT TARGET bgfx::bgfx)
        add_library(bgfx::bgfx ALIAS bgfx)
    endif()
    if(NOT TARGET bx::bx)
        add_library(bx::bx ALIAS bx)
    endif()
    set(NOVELTEA_HAS_BGFX ON CACHE INTERNAL "bgfx available for this target")
elseif(NOT EMSCRIPTEN AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
    find_package(bgfx CONFIG QUIET)
    if(bgfx_FOUND)
        set(NOVELTEA_HAS_BGFX ON CACHE INTERNAL "bgfx available for this target")
    endif()
endif()

add_subdirectory(engine)

if(NOVELTEA_BUILD_SANDBOX)
    add_subdirectory(apps/sandbox)
endif()
