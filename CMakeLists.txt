cmake_minimum_required(VERSION 3.24)
project(noveltea VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
find_package(Python3 REQUIRED COMPONENTS Interpreter)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

option(NOVELTEA_BUILD_SANDBOX "Build the sandbox application" ON)
option(NOVELTEA_ENABLE_BGFX "Use bgfx renderer when available for supported targets" ON)
option(NOVELTEA_ENABLE_RENDER2D "Enable the engine-owned 2D bgfx draw substrate" ON)
option(NOVELTEA_ENABLE_RMLUI "Enable RmlUi runtime UI integration when the package is available" ON)
option(NOVELTEA_ENABLE_TEXT_LAB "Enable the rich-text migration lab scaffold" ON)
option(NOVELTEA_FETCH_BGFX "Download bgfx via FetchContent (Emscripten, Android)" ON)
option(NOVELTEA_FETCH_RMLUI "Download RmlUi via FetchContent (Emscripten, Android)" ON)
option(NOVELTEA_ENABLE_DEVTOOLS "Include Dear ImGui dev/debug overlay" ON)
option(NOVELTEA_COMPILE_SHADERS "Compile bgfx shader headers with shaderc" ON)
option(NOVELTEA_USE_IMGUI "Deprecated alias for NOVELTEA_ENABLE_DEVTOOLS" ON)
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
    # SDL3 provided via Prefab from the AAR dependency.
    find_package(SDL3 REQUIRED CONFIG)
else()
    find_package(SDL3 CONFIG QUIET)
    if(NOT SDL3_FOUND)
        message(FATAL_ERROR "SDL3 required. Install via vcpkg (Linux) or SDK (Web).")
    endif()
endif()

# --- bgfx: provide the bgfx::bgfx target for all platforms ---

if(NOVELTEA_ENABLE_BGFX AND NOVELTEA_FETCH_BGFX AND (EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android"))
    include(FetchContent)
    set(BGFX_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
    set(BGFX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(BGFX_INSTALL OFF CACHE BOOL "" FORCE)
    set(BGFX_CONFIG_MULTITHREADED OFF CACHE BOOL "" FORCE)
    set(BGFX_LIBRARY_TYPE "STATIC" CACHE STRING "" FORCE)

    if(EMSCRIPTEN)
        # bx/bimg add -msse4.2 unconditionally; Emscripten needs -msimd128 alongside
        set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -msimd128")
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -msimd128")

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
    else()
        FetchContent_Declare(
            bgfx.cmake
            URL https://github.com/bkaradzic/bgfx.cmake/releases/download/v1.143.9262-545/bgfx.cmake.v1.143.9262-545.tar.gz
            SOURCE_SUBDIR .
        )
    endif()

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

# --- RmlUi: provide the RmlUi::RmlUi target for all platforms ---

if(NOVELTEA_ENABLE_RMLUI AND NOVELTEA_FETCH_RMLUI AND (EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android"))
    include(FetchContent)
    if(EMSCRIPTEN AND NOT TARGET Freetype::Freetype)
        add_library(Freetype::Freetype INTERFACE IMPORTED)
        target_compile_options(Freetype::Freetype INTERFACE -sUSE_FREETYPE=1)
        target_link_options(Freetype::Freetype INTERFACE -sUSE_FREETYPE=1)
    endif()
    if(CMAKE_SYSTEM_NAME STREQUAL "Android" AND NOT TARGET Freetype::Freetype)
        set(FT_DISABLE_ZLIB ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_BZIP2 ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_PNG ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_HARFBUZZ ON CACHE BOOL "" FORCE)
        set(FT_DISABLE_BROTLI ON CACHE BOOL "" FORCE)
        FetchContent_Declare(
            freetype
            URL https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_MakeAvailable(freetype)
        if(TARGET freetype AND NOT TARGET Freetype::Freetype)
            add_library(Freetype::Freetype ALIAS freetype)
        endif()
    endif()
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(RMLUI_SAMPLES OFF CACHE BOOL "" FORCE)
    set(RMLUI_LUA_BINDINGS OFF CACHE BOOL "" FORCE)
    set(RMLUI_LOTTIE_PLUGIN OFF CACHE BOOL "" FORCE)
    set(RMLUI_SVG_PLUGIN OFF CACHE BOOL "" FORCE)
    set(RMLUI_HARFBUZZ_SAMPLE OFF CACHE BOOL "" FORCE)
    set(RMLUI_PRECOMPILED_HEADERS OFF CACHE BOOL "" FORCE)
    set(RMLUI_COMPILER_OPTIONS OFF CACHE BOOL "" FORCE)
    set(RMLUI_FONT_ENGINE "freetype" CACHE STRING "" FORCE)

    FetchContent_Declare(
        RmlUi
        URL https://github.com/mikke89/RmlUi/archive/refs/tags/6.2.tar.gz
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(RmlUi)
endif()

add_subdirectory(engine)

if(NOVELTEA_BUILD_SANDBOX)
    add_subdirectory(apps/sandbox)
endif()
