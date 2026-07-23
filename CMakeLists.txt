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

add_custom_target(json-boundary-policy
    COMMAND "${CMAKE_COMMAND}"
        -DSOURCE_ROOT=${CMAKE_SOURCE_DIR}
        -DALLOWLIST=${CMAKE_SOURCE_DIR}/cmake/json-boundary-allowlist.txt
        -P ${CMAKE_SOURCE_DIR}/cmake/CheckJsonBoundaryPolicy.cmake
    COMMAND "${CMAKE_COMMAND}"
        -DSOURCE_ROOT=${CMAKE_SOURCE_DIR}
        -P ${CMAKE_SOURCE_DIR}/cmake/VerifyJsonBoundaryPolicyChecker.cmake
    COMMENT "Checking JSON boundary ownership and dependency isolation"
    VERBATIM)

add_custom_target(module-boundary-policy
    COMMAND "${CMAKE_COMMAND}"
        -DSOURCE_ROOT=${CMAKE_SOURCE_DIR}
        -DCLASSIFICATION=${CMAKE_SOURCE_DIR}/cmake/NovelTeaModuleFileClassification.cmake
        -DALLOWLIST=${CMAKE_SOURCE_DIR}/cmake/module-boundary-allowlist.txt
        -P ${CMAKE_SOURCE_DIR}/cmake/CheckModuleBoundaryPolicy.cmake
    COMMAND "${CMAKE_COMMAND}"
        -DSOURCE_ROOT=${CMAKE_SOURCE_DIR}
        -P ${CMAKE_SOURCE_DIR}/cmake/VerifyModuleBoundaryPolicyChecker.cmake
    COMMENT "Checking production module include and target dependency boundaries"
    VERBATIM)

add_custom_target(cxx-policy
    DEPENDS
        cxx-runtime-policy
        cxx-dependency-policy
        json-boundary-policy
        module-boundary-policy
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
option(NOVELTEA_FETCH_BGFX "Fetch/build bgfx via FetchContent (required for Web/Android)" ON)
option(NOVELTEA_FETCH_RMLUI "Fetch/build the pinned patched RmlUi source via FetchContent" ON)
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
option(NOVELTEA_WEB_THREADS "Build Emscripten targets with pthread support" OFF)
set(NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS "JSON_NOEXCEPTION=1" CACHE STRING
    "Semicolon-separated compile definitions for direct nlohmann-json consumers")
set(NOVELTEA_RMLUI_BGFX_GIT_REPOSITORY "https://github.com/Cruel/rmlui-bgfx.git" CACHE STRING "rmlui-bgfx Git repository used when NOVELTEA_FETCH_RMLUI_BGFX is enabled")
set(NOVELTEA_RMLUI_BGFX_GIT_TAG "master" CACHE STRING "rmlui-bgfx Git ref used when NOVELTEA_FETCH_RMLUI_BGFX is enabled")
set(NOVELTEA_LOCAL_RMLUI_BGFX_DIR "${CMAKE_SOURCE_DIR}/rmlui-bgfx" CACHE PATH "Local rmlui-bgfx checkout used when NOVELTEA_USE_LOCAL_RMLUI_BGFX is enabled")

# These definitions are ABI/configuration policy, not optional feature switches. They must be visible
# while header-only dependencies and the complete RmlUi family are compiled.
add_compile_definitions(
    ITLIB_FLAT_MAP_NO_THROW
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    RMLUI_CUSTOM_RTTI
)

# --- SDL3: provide the SDL3::SDL3 target for all platforms ---

if(EMSCRIPTEN AND NOVELTEA_WEB_THREADS)
    add_compile_options(-pthread)
    add_link_options(-pthread "SHELL:-sPTHREAD_POOL_SIZE=1")

endif()

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

# --- ZIP dependency ---

# Runtime packages and bgfx/TinyEXR must use one matching miniz header and
# implementation set. Provision miniz before bgfx so fetched bgfx builds can
# consume this canonical target instead of compiling their vendored copy.
find_package(miniz CONFIG QUIET)
if(NOT TARGET miniz::miniz)
    include(FetchContent)
    set(MINIZ_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(MINIZ_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        miniz
        URL https://github.com/richgel999/miniz/archive/refs/tags/3.1.1.tar.gz
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(miniz)
    if(TARGET miniz AND NOT TARGET miniz::miniz)
        add_library(miniz::miniz ALIAS miniz)
    endif()
endif()

if(NOT TARGET miniz::miniz)
    message(FATAL_ERROR "miniz is required for NovelTea runtime packages")
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

    # bgfx.cmake omits TinyEXR's vendored miniz sources when these are supplied,
    # and links bimg/bimg_decode against the canonical standalone target.
    get_target_property(NOVELTEA_MINIZ_INCLUDE_DIRS miniz::miniz INTERFACE_INCLUDE_DIRECTORIES)
    set(MINIZ_LIBRARIES miniz::miniz)
    set(MINIZ_INCLUDE_DIR ${NOVELTEA_MINIZ_INCLUDE_DIRS})

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
include(NovelTeaRmlUi)
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

# --- Twink: mandatory backend-local interpolation dependency ---

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
if(NOT TARGET twink::twink)
    message(FATAL_ERROR "twink::twink is required for NovelTea backend-local interpolation")
endif()
noveltea_apply_runtime_dependency_policy(twink::twink)

# --- RmlUi + RmlUi Lua: mandatory for the engine ---

noveltea_provide_rmlui_dependency()

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

function(noveltea_attach_generated_shaders target)
    if(NOT TARGET "${target}")
        message(FATAL_ERROR "Cannot attach generated shaders to unknown target '${target}'")
    endif()
    if(TARGET noveltea-shaders)
        add_dependencies("${target}" noveltea-shaders)
    endif()
endfunction()

function(noveltea_attach_runtime_assets target)
    if(NOT TARGET "${target}")
        message(FATAL_ERROR "Cannot attach runtime assets to unknown target '${target}'")
    endif()
    if(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS)
        if(NOT TARGET noveltea-runtime-assets)
            message(FATAL_ERROR "Runtime asset staging is enabled but noveltea-runtime-assets is missing")
        endif()
        add_dependencies("${target}" noveltea-runtime-assets)
    endif()
endfunction()

include(NovelTeaPublicHeaderProbes)
noveltea_add_public_header_probes()
add_dependencies(cxx-policy public-header-probes)

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

foreach(_noveltea_library_target IN ITEMS
        noveltea_domain
        noveltea_content
        noveltea_runtime
        noveltea_presentation
        noveltea_script_lua
        noveltea_engine)
    get_property(_noveltea_manual_dependencies TARGET "${_noveltea_library_target}"
        PROPERTY MANUALLY_ADDED_DEPENDENCIES)
    foreach(_noveltea_staging_target IN ITEMS noveltea-shaders noveltea-runtime-assets)
        if(_noveltea_staging_target IN_LIST _noveltea_manual_dependencies)
            message(FATAL_ERROR
                "${_noveltea_library_target} must not depend on staging target "
                "${_noveltea_staging_target}; attach staging to a final app or test target")
        endif()
    endforeach()
endforeach()

include(NovelTeaModuleInventory)
noveltea_add_module_dependency_inventory(
    OUTPUT "${CMAKE_BINARY_DIR}/reports/module-dependency-inventory.txt")
