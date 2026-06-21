cmake_minimum_required(VERSION 3.24)
project(noveltea VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(CTest)

find_program(CLANG_FORMAT_EXE NAMES clang-format)
file(GLOB_RECURSE NOVELTEA_FORMAT_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/apps/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/apps/*.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/apps/*.hpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/engine/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/engine/*.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/engine/*.hpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/*.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/*.hpp"
)
if(CLANG_FORMAT_EXE)
    add_custom_target(format-check
        COMMAND "${CLANG_FORMAT_EXE}" --dry-run --Werror ${NOVELTEA_FORMAT_SOURCES}
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        COMMENT "Checking C/C++ formatting with clang-format"
        VERBATIM
    )
    add_custom_target(format
        COMMAND "${CLANG_FORMAT_EXE}" -i ${NOVELTEA_FORMAT_SOURCES}
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        COMMENT "Formatting C/C++ sources with clang-format"
        VERBATIM
    )
else()
    add_custom_target(format-check
        COMMAND "${CMAKE_COMMAND}" -E false
        COMMENT "clang-format not found"
    )
    add_custom_target(format
        COMMAND "${CMAKE_COMMAND}" -E false
        COMMENT "clang-format not found"
    )
endif()

# --- User-facing options ---

option(NOVELTEA_BUILD_SANDBOX "Build the sandbox application" ON)
option(NOVELTEA_ENABLE_TWINK "Enable twink-backed engine animation service (optional)" ON)
option(NOVELTEA_FETCH_BGFX "Fetch/build bgfx via FetchContent (required for Web/Android)" ON)
option(NOVELTEA_FETCH_RMLUI "Fetch/build RmlUi via FetchContent (required for Web/Android)" ON)
option(NOVELTEA_ENABLE_DEVTOOLS "Include Dear ImGui dev/debug overlay" ON)
option(NOVELTEA_ENABLE_RENDER_PERF "Compile renderer performance counters and optional perf logging" ON)
option(NOVELTEA_COMPILE_SHADERS "Compile bgfx shader binaries with shaderc" ON)

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
    find_package(SDL3 CONFIG REQUIRED)
endif()

# --- bgfx: mandatory for the engine ---

if(NOVELTEA_FETCH_BGFX AND (EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android"))
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
elseif(NOT EMSCRIPTEN AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
    find_package(bgfx CONFIG REQUIRED)
endif()

if(NOT TARGET bgfx::bgfx)
    message(FATAL_ERROR "bgfx is required for the NovelTea engine. "
        "Install via vcpkg (desktop) or enable NOVELTEA_FETCH_BGFX (Web/Android).")
endif()

# --- Dependency helpers ---

include(NovelTeaLua)
include(NovelTeaText)

# --- Lua dependencies: mandatory for the engine ---

noveltea_provide_lua_dependencies()
if(NOT TARGET Lua::Lua OR NOT TARGET sol2::sol2)
    message(FATAL_ERROR "Lua::Lua and sol2::sol2 are required for the NovelTea engine. "
        "Install via vcpkg (desktop) or enable the corresponding fetch mechanism.")
endif()

# --- Text dependencies: mandatory for the engine ---

noveltea_provide_text_dependencies()
if(NOT TARGET noveltea_text_freetype
    OR NOT TARGET noveltea_text_harfbuzz
    OR NOT TARGET noveltea_text_sheenbidi
    OR NOT TARGET noveltea_text_unibreak)
    message(FATAL_ERROR "Text dependency targets (FreeType, HarfBuzz, SheenBidi, libunibreak) "
        "are required for the NovelTea engine.")
endif()

# --- Twink (optional animation backend) ---

if(NOVELTEA_ENABLE_TWINK)
    find_package(twink CONFIG QUIET)
    if(NOT TARGET twink::twink)
        include(FetchContent)
        set(TWINK_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(TWINK_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(TWINK_INSTALL OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(
            twink
            GIT_REPOSITORY https://github.com/Cruel/twink.git
            GIT_TAG ea488b2d6a0c032ffefdeb0e5e064749706e29fd
        )
        FetchContent_MakeAvailable(twink)
    endif()
    if(NOT TARGET twink::twink)
        message(FATAL_ERROR "NOVELTEA_ENABLE_TWINK=ON requires twink::twink")
    endif()
endif()

# --- RmlUi + RmlUi Lua: mandatory for the engine ---

if(NOVELTEA_FETCH_RMLUI AND (EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android"))
    include(FetchContent)
    if(NOT TARGET Freetype::Freetype)
        noveltea_provide_freetype_dependency()
    endif()
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(RMLUI_SAMPLES OFF CACHE BOOL "" FORCE)
    set(RMLUI_LUA_BINDINGS ON CACHE BOOL "" FORCE)
    set(RMLUI_LUA_BINDINGS_LIBRARY lua CACHE STRING "" FORCE)
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

# Desktop: RmlUi comes from vcpkg
if(NOT TARGET RmlUi::RmlUi AND NOT TARGET RmlUi::Core)
    find_package(RmlUi CONFIG REQUIRED)
endif()

if(NOT TARGET RmlUi::Lua)
    message(FATAL_ERROR "RmlUi::Lua is required for the NovelTea engine. "
        "Ensure the 'lua' feature is enabled for rmlui in your package manager "
        "(vcpkg: \"rmlui\": {\"features\": [\"freetype\", \"lua\"]}).")
endif()

add_subdirectory(engine)
if(NOT EMSCRIPTEN)
    add_subdirectory(tools/editor_tool)
endif()

if(NOVELTEA_BUILD_SANDBOX)
    add_subdirectory(apps/sandbox)
endif()

if(BUILD_TESTING)
    find_package(Catch2 3 CONFIG REQUIRED)
    add_subdirectory(tests)
endif()
