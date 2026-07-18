include("${CMAKE_SOURCE_DIR}/cmake/NovelTeaModuleFileClassification.cmake")

function(noveltea_module_sources out_var target)
    set(_sources)
    foreach(_path IN LISTS NOVELTEA_MODULE_FILES_${target})
        list(APPEND _sources "${CMAKE_SOURCE_DIR}/${_path}")
    endforeach()
    set(${out_var} "${_sources}" PARENT_SCOPE)
endfunction()

function(noveltea_configure_internal_module target)
    target_compile_features(${target} PUBLIC cxx_std_20)
    set_target_properties(${target} PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_include_directories(${target}
        PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include"
        PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src"
    )
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(${target} PRIVATE
            -Wall -Wextra -Wpedantic -Wno-unused-parameter
        )
    endif()
    noveltea_apply_runtime_compiler_policy(${target})
    noveltea_apply_policy_warnings(${target})
endfunction()

noveltea_module_sources(NOVELTEA_DOMAIN_FILES noveltea_domain)
add_library(noveltea_domain STATIC ${NOVELTEA_DOMAIN_FILES})
noveltea_configure_internal_module(noveltea_domain)

find_package(nlohmann_json CONFIG QUIET)
if(NOT TARGET nlohmann_json::nlohmann_json)
    include(FetchContent)
    FetchContent_Declare(
        nlohmann_json
        URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    )
    FetchContent_MakeAvailable(nlohmann_json)
endif()
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

# Production modules compile against the standalone miniz headers, but final
# engine/player links must obtain the mz_* implementation from bimg. Keep the
# compile usage separate from the standalone archive so Android/Web cannot
# accidentally add a second implementation provider to an engine-linked binary.
add_library(noveltea_miniz_headers INTERFACE)
target_compile_definitions(noveltea_miniz_headers INTERFACE
    $<TARGET_PROPERTY:miniz::miniz,INTERFACE_COMPILE_DEFINITIONS>
)
target_include_directories(noveltea_miniz_headers SYSTEM INTERFACE
    $<TARGET_PROPERTY:miniz::miniz,INTERFACE_INCLUDE_DIRECTORIES>
)

noveltea_module_sources(NOVELTEA_CONTENT_FILES noveltea_content)
add_library(noveltea_content STATIC ${NOVELTEA_CONTENT_FILES})
noveltea_configure_internal_module(noveltea_content)
target_link_libraries(noveltea_content
    PUBLIC
        noveltea_domain
    PRIVATE
        nlohmann_json::nlohmann_json
        noveltea_miniz_headers
)
target_compile_definitions(noveltea_content PRIVATE
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
)

noveltea_module_sources(NOVELTEA_RUNTIME_FILES noveltea_runtime)
add_library(noveltea_runtime STATIC ${NOVELTEA_RUNTIME_FILES})
noveltea_configure_internal_module(noveltea_runtime)
target_link_libraries(noveltea_runtime
    PUBLIC
        noveltea_domain
        noveltea_content
)

noveltea_module_sources(NOVELTEA_PRESENTATION_FILES noveltea_presentation)
add_library(noveltea_presentation STATIC ${NOVELTEA_PRESENTATION_FILES})
noveltea_configure_internal_module(noveltea_presentation)
target_link_libraries(noveltea_presentation
    PUBLIC
        noveltea_domain
        noveltea_runtime
)

noveltea_module_sources(NOVELTEA_SCRIPT_LUA_FILES noveltea_script_lua)
add_library(noveltea_script_lua STATIC ${NOVELTEA_SCRIPT_LUA_FILES})
noveltea_configure_internal_module(noveltea_script_lua)
target_compile_definitions(noveltea_script_lua PRIVATE
    NOVELTEA_HAS_LUA
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    SOL_ALL_SAFETIES_ON=1
)
target_link_libraries(noveltea_script_lua
    PUBLIC
        noveltea_domain
        noveltea_runtime
    PRIVATE
        Lua::Lua
        sol2::sol2
)

# --- Engine target ---

noveltea_module_sources(NOVELTEA_ENGINE_FILES noveltea_engine)
list(REMOVE_ITEM NOVELTEA_ENGINE_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/src/devtools/imgui_bgfx.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/ui_debug_imgui.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/src/ui_debug_stub.cpp"
)
add_library(noveltea_engine STATIC ${NOVELTEA_ENGINE_FILES})
noveltea_configure_internal_module(noveltea_engine)

if(EMSCRIPTEN)
    # miniaudio embeds EM_ASM JavaScript using Emscripten's $0/$1 parameter
    # syntax. Clang diagnoses those tokens as an extension while parsing the
    # third-party header included by this translation unit.
    set_source_files_properties(src/audio/miniaudio/miniaudio_backend.cpp PROPERTIES
        COMPILE_OPTIONS "-Wno-dollar-in-identifier-extension")
endif()

target_link_libraries(noveltea_engine
    PUBLIC
        noveltea_presentation
        noveltea_runtime
        noveltea_content
        noveltea_domain
    PRIVATE
        noveltea_script_lua
        Lua::Lua
        sol2::sol2
        nlohmann_json::nlohmann_json
        noveltea_miniz_headers
        twink::twink
)
target_compile_definitions(noveltea_engine PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
include(NovelTeaAudio)
noveltea_provide_miniaudio(MINIAUDIO_INCLUDE_DIRS)
target_include_directories(noveltea_engine PRIVATE ${MINIAUDIO_INCLUDE_DIRS})

# --- Generated asset paths ---

set(NOVELTEA_GENERATED_ASSET_ROOT "${CMAKE_BINARY_DIR}/generated-assets")
set(NOVELTEA_GENERATED_SHADER_ASSET_ROOT "${NOVELTEA_GENERATED_ASSET_ROOT}")
set(NOVELTEA_RUNTIME_ASSET_ROOT "${CMAKE_BINARY_DIR}/runtime-assets" CACHE PATH "Staged NovelTea runtime asset root")
set(NOVELTEA_PROJECT_ASSET_SOURCE "${CMAKE_SOURCE_DIR}/apps/sandbox/assets" CACHE PATH "Project/demo assets to stage")
set(NOVELTEA_PREBUILT_SHADER_ASSET_ROOT "" CACHE PATH "Prebuilt shader asset root containing shaders/bgfx/<variant>")
set(NOVELTEA_SHADER_VARIANTS "" CACHE STRING "Semicolon-separated shader variants to build or stage")
set(NOVELTEA_SHADERC_EXECUTABLE "" CACHE FILEPATH "Host bgfx shaderc executable")
set(NOVELTEA_BGFX_SHADER_INCLUDE_DIR "" CACHE PATH "Directory containing bgfx_shader.sh")
set(NOVELTEA_RUNTIME_ASSET_STAMP "${CMAKE_BINARY_DIR}/generated-assets/runtime-assets.stamp")
if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    set(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS_DEFAULT OFF)
else()
    set(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS_DEFAULT ON)
endif()
option(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS "Stage runtime assets from CMake" ${NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS_DEFAULT})

# --- Shader helpers ---

include(NovelTeaShaders)
if(NOT NOVELTEA_SHADER_VARIANTS)
    noveltea_default_shader_variants(NOVELTEA_SHADER_VARIANTS)
endif()
list(JOIN NOVELTEA_SHADER_VARIANTS ";" NOVELTEA_SHADER_VARIANTS_ARG)

# --- bgfx rendering (mandatory) ---

message(STATUS "bgfx found - full rendering enabled")

set(SHADER_SRC_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/shaders/bgfx")
set(SHADER_ASSET_ROOT "${NOVELTEA_GENERATED_SHADER_ASSET_ROOT}")
noveltea_collect_shader_inputs("${SHADER_SRC_DIR}" NOVELTEA_SHADER_INPUTS)
noveltea_collect_shader_outputs(VARIANTS ${NOVELTEA_SHADER_VARIANTS} OUTPUT_ROOT "${SHADER_ASSET_ROOT}" OUT_VAR NOVELTEA_SHADER_OUTPUTS)
if(NOVELTEA_COMPILE_SHADERS)
    noveltea_find_shader_tools(REQUIRED OUT_SHADERC SHADERC_EXECUTABLE OUT_BGFX_INCLUDE BGFX_SHADER_INCLUDE_DIR)
    noveltea_add_shader_target(
        TARGET noveltea-shaders
        SHADERC "${SHADERC_EXECUTABLE}"
        SOURCE_DIR "${SHADER_SRC_DIR}"
        OUTPUT_ROOT "${SHADER_ASSET_ROOT}"
        VARIANTS ${NOVELTEA_SHADER_VARIANTS}
        BGFX_INCLUDE_DIR "${BGFX_SHADER_INCLUDE_DIR}"
    )
else()
    if(NOVELTEA_PREBUILT_SHADER_ASSET_ROOT)
        set(SHADER_ASSET_ROOT "${NOVELTEA_PREBUILT_SHADER_ASSET_ROOT}")
    endif()
    noveltea_collect_shader_outputs(VARIANTS ${NOVELTEA_SHADER_VARIANTS} OUTPUT_ROOT "${SHADER_ASSET_ROOT}" OUT_VAR NOVELTEA_SHADER_OUTPUTS)
    if(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS)
        execute_process(
            COMMAND "${CMAKE_COMMAND}"
                "-DNOVELTEA_VERIFY_ONLY=ON"
                "-DNOVELTEA_SHADER_OUTPUT_ROOT=${SHADER_ASSET_ROOT}"
                "-DNOVELTEA_SHADER_VARIANTS=${NOVELTEA_SHADER_VARIANTS_ARG}"
                -P "${CMAKE_SOURCE_DIR}/cmake/CompileNovelTeaShaders.cmake"
            RESULT_VARIABLE _shader_verify_result
        )
        if(NOT _shader_verify_result EQUAL 0)
            message(FATAL_ERROR "NOVELTEA_COMPILE_SHADERS=OFF requires a complete prebuilt shader tree. Set NOVELTEA_PREBUILT_SHADER_ASSET_ROOT.")
        endif()
    endif()
    add_custom_target(noveltea-shaders)
endif()
set(NOVELTEA_ACTIVE_SHADER_ASSET_ROOT "${SHADER_ASSET_ROOT}" CACHE INTERNAL "Active NovelTea shader asset root")
set(NOVELTEA_ACTIVE_SHADER_VARIANTS "${NOVELTEA_SHADER_VARIANTS_ARG}" CACHE INTERNAL "Active NovelTea shader variants")

target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_HAS_BGFX)
target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_HAS_RENDER2D)
target_link_libraries(noveltea_engine PRIVATE bgfx::bgfx)
if(TARGET bgfx::bimg)
    target_link_libraries(noveltea_engine PRIVATE bgfx::bimg)
elseif(TARGET bimg::bimg)
    target_link_libraries(noveltea_engine PRIVATE bimg::bimg)
elseif(TARGET bimg)
    target_link_libraries(noveltea_engine PRIVATE bimg)
endif()
if(TARGET bgfx::bimg_decode)
    target_link_libraries(noveltea_engine PRIVATE bgfx::bimg_decode)
elseif(TARGET bimg_decode)
    target_link_libraries(noveltea_engine PRIVATE bimg_decode)
endif()
if(TARGET bx::bx)
    target_link_libraries(noveltea_engine PRIVATE bx::bx)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    target_link_libraries(noveltea_engine PRIVATE EGL GLESv2 android log OpenSLES)
endif()

# --- Lua scripting (mandatory) ---

target_compile_definitions(noveltea_engine PRIVATE
    NOVELTEA_HAS_LUA
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    SOL_ALL_SAFETIES_ON=1
)

# --- Platform definition ---

if(EMSCRIPTEN)
    target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_PLATFORM_WEB)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
    target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_PLATFORM_ANDROID)
else()
    target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_PLATFORM_DESKTOP)
endif()

target_compile_definitions(noveltea_engine PRIVATE
    NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT="${CMAKE_BINARY_DIR}/runtime-assets/system"
    NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT="${CMAKE_BINARY_DIR}/runtime-assets/project"
    NOVELTEA_DEFAULT_CACHE_ASSET_ROOT="${CMAKE_BINARY_DIR}/cache"
)

# --- Dependencies ---
# SDL3::SDL3 target is provided by the root CMakeLists.txt.

if(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS)
    file(GLOB_RECURSE NOVELTEA_PROJECT_ASSET_INPUTS CONFIGURE_DEPENDS "${NOVELTEA_PROJECT_ASSET_SOURCE}/*")
    file(GLOB_RECURSE NOVELTEA_ENGINE_ASSET_INPUTS CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/engine/assets/system/*")
    add_custom_command(
        OUTPUT "${NOVELTEA_RUNTIME_ASSET_STAMP}"
        COMMAND "${CMAKE_COMMAND}"
            "-DNOVELTEA_PROJECT_ASSET_SOURCE=${NOVELTEA_PROJECT_ASSET_SOURCE}"
            "-DNOVELTEA_SHADER_ASSET_SOURCE=${SHADER_ASSET_ROOT}"
            "-DNOVELTEA_RUNTIME_ASSET_ROOT=${NOVELTEA_RUNTIME_ASSET_ROOT}"
            "-DNOVELTEA_STAGE_STAMP=${NOVELTEA_RUNTIME_ASSET_STAMP}"
            -P "${CMAKE_SOURCE_DIR}/cmake/StageNovelTeaAssets.cmake"
        DEPENDS
            "${CMAKE_SOURCE_DIR}/cmake/StageNovelTeaAssets.cmake"
            ${NOVELTEA_PROJECT_ASSET_INPUTS}
            ${NOVELTEA_ENGINE_ASSET_INPUTS}
            ${NOVELTEA_SHADER_OUTPUTS}
        COMMENT "Staging NovelTea runtime assets"
        VERBATIM
    )
    add_custom_target(noveltea-runtime-assets DEPENDS "${NOVELTEA_RUNTIME_ASSET_STAMP}")
    if(TARGET noveltea-shaders)
        add_dependencies(noveltea-runtime-assets noveltea-shaders)
    endif()
    add_dependencies(noveltea_engine noveltea-runtime-assets)
endif()

target_link_libraries(noveltea_engine PRIVATE SDL3::SDL3)

# --- RmlUi (runtime UI scaffold, mandatory) ---

# RmlUi targets already verified by root CMakeLists.txt.
if(TARGET RmlUi::RmlUi)
    set(NOVELTEA_RMLUI_TARGET RmlUi::RmlUi)
elseif(TARGET RmlUi::Core)
    set(NOVELTEA_RMLUI_TARGET RmlUi::Core)
endif()

target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_HAS_RMLUI)
target_link_libraries(noveltea_engine PRIVATE ${NOVELTEA_RMLUI_TARGET})
target_link_libraries(noveltea_engine PRIVATE rmlui_bgfx::rmlui_bgfx RmlUi::Lua)
target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_HAS_RMLUI_LUA)

# --- Text subsystem (mandatory) ---

target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_HAS_TEXT)
target_link_libraries(noveltea_engine PRIVATE
    noveltea_text_freetype
    noveltea_text_harfbuzz
    noveltea_text_sheenbidi
    noveltea_text_unibreak
)

# --- Dear ImGui (dev/debug only) ---

if(NOVELTEA_ENABLE_DEVTOOLS)
    # Fetch imgui for Emscripten/Android (vcpkg handles desktop).
    if(NOT TARGET imgui::imgui AND (EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android"))
        include(FetchContent)
        FetchContent_Declare(
            imgui
            URL https://github.com/ocornut/imgui/archive/refs/tags/v1.92.8-docking.tar.gz
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        )
        FetchContent_MakeAvailable(imgui)

        add_library(imgui STATIC
            "${imgui_SOURCE_DIR}/imgui.cpp"
            "${imgui_SOURCE_DIR}/imgui_draw.cpp"
            "${imgui_SOURCE_DIR}/imgui_tables.cpp"
            "${imgui_SOURCE_DIR}/imgui_widgets.cpp"
            "${imgui_SOURCE_DIR}/backends/imgui_impl_sdl3.cpp"
        )
        target_include_directories(imgui PUBLIC "${imgui_SOURCE_DIR}" "${imgui_SOURCE_DIR}/backends")
        target_compile_features(imgui PUBLIC cxx_std_11)
        target_link_libraries(imgui PUBLIC SDL3::SDL3)
        noveltea_apply_runtime_dependency_policy(imgui)
        add_library(imgui::imgui ALIAS imgui)
    endif()

    if(NOT TARGET imgui::imgui)
        find_package(imgui CONFIG QUIET)
    endif()
    if(TARGET imgui::imgui)
        message(STATUS "imgui found - debug overlay enabled")
        target_sources(noveltea_engine PRIVATE src/ui_debug_imgui.cpp)
        target_link_libraries(noveltea_engine PRIVATE imgui::imgui)
        target_compile_definitions(noveltea_engine PRIVATE NOVELTEA_HAS_IMGUI)
        target_sources(noveltea_engine PRIVATE src/devtools/imgui_bgfx.cpp)
    else()
        message(STATUS "imgui not found - debug overlay disabled")
        target_sources(noveltea_engine PRIVATE src/ui_debug_stub.cpp)
    endif()
else()
    message(STATUS "devtools disabled")
    target_sources(noveltea_engine PRIVATE src/ui_debug_stub.cpp)
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea_engine PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
