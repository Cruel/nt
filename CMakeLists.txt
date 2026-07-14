cmake_minimum_required(VERSION 3.24)
project(noveltea VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(CTest)
include(NovelTeaCompilerPolicy)
include(NovelTeaSanitizers)

add_library(noveltea_compiler_policy_probe OBJECT EXCLUDE_FROM_ALL
    cmake/compiler_policy_probe.cpp)
target_include_directories(noveltea_compiler_policy_probe PRIVATE engine/include)
noveltea_apply_runtime_compiler_policy(noveltea_compiler_policy_probe)
noveltea_apply_policy_warnings(noveltea_compiler_policy_probe)

add_custom_target(cxx-runtime-policy
    COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${CMAKE_SOURCE_DIR}
        -DALLOWLIST=${CMAKE_SOURCE_DIR}/cmake/cxx-policy-allowlist.txt
        -P ${CMAKE_SOURCE_DIR}/cmake/CheckCxxRuntimePolicy.cmake
    COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${CMAKE_SOURCE_DIR}
        -P ${CMAKE_SOURCE_DIR}/cmake/VerifyCxxRuntimePolicyChecker.cmake
    COMMENT "Checking shipped C++ sources for exception, RTTI, and throwing APIs"
    VERBATIM)
add_dependencies(cxx-runtime-policy noveltea_compiler_policy_probe)

add_custom_target(cxx-dependency-policy
    COMMAND "${CMAKE_COMMAND}"
        -DBUILD_DIR=${CMAKE_BINARY_DIR}
        -DPLATFORM_NAME=${CMAKE_SYSTEM_NAME}
        -P ${CMAKE_SOURCE_DIR}/cmake/VerifyDependencyCompilerPolicy.cmake
    COMMENT "Verifying C++ dependency compiler flags and runtime link inputs"
    VERBATIM)

add_custom_target(cxx-policy
    DEPENDS cxx-runtime-policy cxx-dependency-policy
    COMMENT "Verifying the complete NovelTea C++ runtime policy")

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
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/benchmark/*.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/benchmark/*.h"
    "${CMAKE_CURRENT_SOURCE_DIR}/tools/benchmark/*.hpp"
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
option(NOVELTEA_BUILD_PLAYER "Build the release-facing player application" ON)
option(NOVELTEA_BUILD_BENCHMARKS "Build reproducible release benchmark executables" OFF)
option(NOVELTEA_ENABLE_TWINK "Enable twink-backed engine animation service (optional)" ON)
option(NOVELTEA_FETCH_BGFX "Fetch/build bgfx via FetchContent (required for Web/Android)" ON)
option(NOVELTEA_FETCH_RMLUI "Fetch/build RmlUi via FetchContent (required for Web/Android)" ON)
option(NOVELTEA_FETCH_RMLUI_BGFX "Fetch rmlui-bgfx via FetchContent when it is not installed" ON)
option(NOVELTEA_USE_LOCAL_RMLUI_BGFX "Use a local rmlui-bgfx checkout instead of an installed package or remote FetchContent" OFF)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(NOVELTEA_DEVTOOLS_DEFAULT ON)
else()
    set(NOVELTEA_DEVTOOLS_DEFAULT OFF)
endif()
option(NOVELTEA_ENABLE_DEVTOOLS "Include Dear ImGui dev/debug overlay" ${NOVELTEA_DEVTOOLS_DEFAULT})
option(NOVELTEA_ENABLE_RENDER_PERF "Compile renderer performance counters and optional perf logging" ON)
option(NOVELTEA_COMPILE_SHADERS "Compile bgfx shader binaries with shaderc" ON)
set(NOVELTEA_RMLUI_BGFX_GIT_REPOSITORY "https://github.com/Cruel/rmlui-bgfx.git" CACHE STRING "rmlui-bgfx Git repository used when NOVELTEA_FETCH_RMLUI_BGFX is enabled")
set(NOVELTEA_RMLUI_BGFX_GIT_TAG "master" CACHE STRING "rmlui-bgfx Git ref used when NOVELTEA_FETCH_RMLUI_BGFX is enabled")
set(NOVELTEA_LOCAL_RMLUI_BGFX_DIR "${CMAKE_SOURCE_DIR}/rmlui-bgfx" CACHE PATH "Local rmlui-bgfx checkout used when NOVELTEA_USE_LOCAL_RMLUI_BGFX is enabled")

# These definitions are ABI/configuration policy, not optional feature switches. They must be visible
# while header-only dependencies and the complete RmlUi family are compiled.
add_compile_definitions(
    ITLIB_FLAT_MAP_NO_THROW
    JSON_NOEXCEPTION=1
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    RMLUI_CUSTOM_RTTI
)

# --- SDL3: provide the SDL3::SDL3 target for all platforms ---

if(EMSCRIPTEN)
    add_compile_options(-pthread)
    add_link_options(-pthread "SHELL:-sPTHREAD_POOL_SIZE=1")

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
            PATCH_COMMAND ${CMAKE_COMMAND} -P ${CMAKE_SOURCE_DIR}/cmake/patch-bgfx-miniz.cmake
        )
    endif()

    FetchContent_MakeAvailable(bgfx.cmake)
    foreach(_noveltea_dependency IN ITEMS bx bimg bimg_decode bimg_encode bgfx)
        noveltea_apply_runtime_dependency_policy(${_noveltea_dependency})
    endforeach()
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
    noveltea_apply_runtime_dependency_policy(twink::twink)
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
    foreach(_noveltea_dependency IN ITEMS rmlui_core rmlui_lua rmlui_debugger)
        noveltea_apply_runtime_dependency_policy(${_noveltea_dependency})
    endforeach()
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

# --- RmlUi bgfx renderer package ---

if(NOVELTEA_USE_LOCAL_RMLUI_BGFX)
    include(FetchContent)
    if(NOT IS_ABSOLUTE "${NOVELTEA_LOCAL_RMLUI_BGFX_DIR}")
        get_filename_component(NOVELTEA_LOCAL_RMLUI_BGFX_DIR_ABS
            "${NOVELTEA_LOCAL_RMLUI_BGFX_DIR}" ABSOLUTE BASE_DIR "${CMAKE_SOURCE_DIR}")
    else()
        set(NOVELTEA_LOCAL_RMLUI_BGFX_DIR_ABS "${NOVELTEA_LOCAL_RMLUI_BGFX_DIR}")
    endif()
    if(NOT EXISTS "${NOVELTEA_LOCAL_RMLUI_BGFX_DIR_ABS}/CMakeLists.txt")
        message(FATAL_ERROR "NOVELTEA_USE_LOCAL_RMLUI_BGFX=ON but no CMakeLists.txt was found at "
            "NOVELTEA_LOCAL_RMLUI_BGFX_DIR='${NOVELTEA_LOCAL_RMLUI_BGFX_DIR_ABS}'.")
    endif()
    message(STATUS "Using local rmlui-bgfx checkout: ${NOVELTEA_LOCAL_RMLUI_BGFX_DIR_ABS}")
    set(RMLUI_BGFX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(RMLUI_BGFX_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)
    set(RMLUI_BGFX_INSTALL OFF CACHE BOOL "" FORCE)
    set(RMLUI_BGFX_ENABLE_RENDER_PERF ${NOVELTEA_ENABLE_RENDER_PERF} CACHE BOOL "" FORCE)
    FetchContent_Declare(
        rmlui_bgfx
        SOURCE_DIR "${NOVELTEA_LOCAL_RMLUI_BGFX_DIR_ABS}"
    )
    FetchContent_MakeAvailable(rmlui_bgfx)
else()
    find_package(rmlui_bgfx CONFIG QUIET)
    if(NOT TARGET rmlui_bgfx::rmlui_bgfx AND NOVELTEA_FETCH_RMLUI_BGFX)
        include(FetchContent)
        set(RMLUI_BGFX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(RMLUI_BGFX_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)
        set(RMLUI_BGFX_INSTALL OFF CACHE BOOL "" FORCE)
        set(RMLUI_BGFX_ENABLE_RENDER_PERF ${NOVELTEA_ENABLE_RENDER_PERF} CACHE BOOL "" FORCE)
        FetchContent_Declare(
            rmlui_bgfx
            GIT_REPOSITORY ${NOVELTEA_RMLUI_BGFX_GIT_REPOSITORY}
            GIT_TAG ${NOVELTEA_RMLUI_BGFX_GIT_TAG}
        )
        FetchContent_MakeAvailable(rmlui_bgfx)
    endif()
endif()
if(NOT TARGET rmlui_bgfx::rmlui_bgfx)
    message(FATAL_ERROR "rmlui_bgfx::rmlui_bgfx is required for the NovelTea engine. "
        "Install rmlui-bgfx, enable NOVELTEA_FETCH_RMLUI_BGFX, or configure with "
        "-DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON for tandem local development.")
endif()
noveltea_apply_runtime_dependency_policy(rmlui_bgfx::rmlui_bgfx)

add_subdirectory(engine)
if(NOT EMSCRIPTEN AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
    add_subdirectory(tools/editor_tool)
    if(NOVELTEA_BUILD_BENCHMARKS)
        add_subdirectory(tools/benchmark)
    endif()
endif()

if(NOVELTEA_BUILD_SANDBOX)
    add_subdirectory(apps/sandbox)
endif()
if(NOVELTEA_BUILD_PLAYER)
    add_subdirectory(apps/player)
endif()

if(BUILD_TESTING)
    find_package(Catch2 3 CONFIG REQUIRED)
    add_subdirectory(tests)
endif()
