add_library(noveltea_core STATIC
    src/core/compiled_package.cpp
    src/core/compiled_package_codec.cpp
    src/core/compiled_project.cpp
    src/core/compiled_project_validation.cpp
    src/core/compiled_project_codec/definitions_decoder.cpp
    src/core/compiled_project_codec/dialogue_decoder.cpp
    src/core/compiled_project_codec/interaction_decoder.cpp
    src/core/compiled_project_codec/linker.cpp
    src/core/compiled_project_codec/project_decoder.cpp
    src/core/compiled_project_codec/project_fields.cpp
    src/core/compiled_project_codec/scene_decoder.cpp
    src/core/compiled_project_codec/shared_values.cpp
    src/core/diagnostic.cpp
    src/core/editor_runtime_protocol.cpp
    src/core/flow_executor.cpp
    src/core/flow_executor_blockers.cpp
    src/core/flow_executor_dialogue.cpp
    src/core/flow_executor_interaction.cpp
    src/core/flow_executor_room.cpp
    src/core/flow_executor_scene.cpp
    src/core/gameplay_pause.cpp
    src/core/package_export.cpp
    src/core/presentation_coordinator.cpp
    src/core/presentation_operation_requests.cpp
    src/core/player_bootstrap.cpp
    src/core/rich_text.cpp
    src/core/rich_text_codec.cpp
    src/core/runtime_presentation.cpp
    src/core/room_presentation.cpp
    src/core/runtime_clock.cpp
    src/core/runtime_user_settings.cpp
    src/core/runtime_user_settings_codec.cpp
    src/core/session_state.cpp
    src/core/session_restore.cpp
    src/core/shared_evaluator.cpp
    src/core/property_resolver.cpp
    src/core/save_state.cpp
    src/core/save_state_codec.cpp
    src/core/save_state_codec/shared_values.cpp
    src/core/save_state_codec/flow_codec.cpp
    src/core/save_state_codec/presentation_codec.cpp
    src/core/save_state_codec/state_codec.cpp
    src/core/save_state_codec/validation.cpp
    src/core/typed_save_slot_store.cpp
    src/runtime/runtime_command_gateway.cpp
    src/render/material.cpp
    src/render/material_codec.cpp
    src/render/shader_compiler.cpp
    src/render/shader_manifest.cpp
)

target_compile_features(noveltea_core PUBLIC cxx_std_20)
noveltea_apply_runtime_compiler_policy(noveltea_core)

target_include_directories(noveltea_core
    PUBLIC
        include
)

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
# JSON is a boundary implementation dependency.  Keep it out of the public
# interface of the general domain target: consumers that deliberately use a
# codec declaration must declare their own direct dependency.
target_link_libraries(noveltea_core PRIVATE nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea_core PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})

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
# noveltea_core uses miniz's ZIP reader/writer API, but engine consumers also
# link bgfx/bimg, whose image decoder statically embeds TinyEXR's vendored
# miniz. Propagating a standalone miniz archive through noveltea_core causes
# duplicate mz_* symbols when linking Android shared libraries with lld. Keep
# the standalone miniz target available for core-only tests/tools that need it,
# but use it here only as a header provider; engine final links resolve these
# symbols from bimg_decode.
target_include_directories(noveltea_core PRIVATE
    $<TARGET_PROPERTY:miniz::miniz,INTERFACE_INCLUDE_DIRECTORIES>
)
target_compile_definitions(noveltea_core PRIVATE
    $<TARGET_PROPERTY:miniz::miniz,INTERFACE_COMPILE_DEFINITIONS>
)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea_core PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
noveltea_apply_policy_warnings(noveltea_core)

# --- Engine target ---

add_library(engine STATIC
    src/active_text.cpp
    src/active_text_layout.cpp
    src/active_text_playback.cpp
    src/animation/tween_service.cpp
    src/assets/asset_manager.cpp
    src/assets/resource_aliases.cpp
    src/assets.cpp
    src/app.cpp
    src/audio/audio_system.cpp
    src/audio/miniaudio/miniaudio_backend.cpp
    src/engine.cpp
    src/host/game_host.cpp
    src/host/layout_realizer.cpp
    src/platform/sdl/sdl_platform.cpp
    src/preview/preview_bridge.cpp
    src/runtime_audio_adapter.cpp
    src/runtime_ui_contracts.cpp
    src/runtime_layout_manager.cpp
    src/runtime_system_layouts.cpp
    src/runtime_preview_controller.cpp
    src/runtime_presentation_bridge.cpp
    src/surface.cpp
    src/world_presentation.cpp
    src/world_transition.cpp
    src/text/text_asset_loader.cpp
    src/text/text_breaks.cpp
    src/text/text_engine.cpp
    src/text/text_layout.cpp
    src/ui/rmlui/rmlui_custom_components.cpp
    src/ui/rmlui/rmlui_document_binder.cpp
    src/ui/rmlui/rmlui_file_interface.cpp
    src/ui/rmlui/rmlui_host.cpp
    src/ui/rmlui/rmlui_host_frame.cpp
    src/ui/rmlui/rmlui_host_input.cpp
    src/ui/rmlui/rmlui_template_resolver.cpp
    src/ui_runtime_rmlui.cpp
)
target_include_directories(engine PRIVATE
    $<TARGET_PROPERTY:miniz::miniz,INTERFACE_INCLUDE_DIRECTORIES>
)
target_compile_definitions(engine PRIVATE
    $<TARGET_PROPERTY:miniz::miniz,INTERFACE_COMPILE_DEFINITIONS>
)

if(EMSCRIPTEN)
    # miniaudio embeds EM_ASM JavaScript using Emscripten's $0/$1 parameter
    # syntax. Clang diagnoses those tokens as an extension while parsing the
    # third-party header included by this translation unit.
    set_source_files_properties(src/audio/miniaudio/miniaudio_backend.cpp PROPERTIES
        COMPILE_OPTIONS "-Wno-dollar-in-identifier-extension")
endif()

set_target_properties(engine PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_include_directories(engine
    PUBLIC
        include
    PRIVATE
        src
)

target_link_libraries(engine
    PUBLIC
        noveltea_core
    PRIVATE
        nlohmann_json::nlohmann_json
        twink::twink
)
target_compile_definitions(engine PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
include(NovelTeaAudio)
noveltea_provide_miniaudio(MINIAUDIO_INCLUDE_DIRS)
target_include_directories(engine PRIVATE ${MINIAUDIO_INCLUDE_DIRS})

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

target_sources(engine PRIVATE
    src/render/bgfx/bgfx_renderer.cpp
    src/render/bgfx/bgfx_resources.cpp
    src/render/bgfx/bgfx_material_binder.cpp
    src/render/bgfx/bgfx_quad_batch.cpp
    src/render/bgfx/bgfx_shader_loader.cpp
    src/render/bgfx/bgfx_shader_program_cache.cpp
    src/render/bgfx/text/bgfx_text_renderer.cpp
    src/render/bgfx/bgfx_typed_asset_loader.cpp
)
target_compile_definitions(engine PUBLIC NOVELTEA_HAS_BGFX)
target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RENDER2D)
target_link_libraries(engine PUBLIC bgfx::bgfx)
if(TARGET bgfx::bimg)
    target_link_libraries(engine PUBLIC bgfx::bimg)
elseif(TARGET bimg::bimg)
    target_link_libraries(engine PUBLIC bimg::bimg)
elseif(TARGET bimg)
    target_link_libraries(engine PUBLIC bimg)
endif()
if(TARGET bgfx::bimg_decode)
    target_link_libraries(engine PUBLIC bgfx::bimg_decode)
elseif(TARGET bimg_decode)
    target_link_libraries(engine PUBLIC bimg_decode)
endif()
if(TARGET bx::bx)
    target_link_libraries(engine PUBLIC bx::bx)
endif()
if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    target_link_libraries(engine PUBLIC EGL GLESv2 android log OpenSLES)
endif()

# --- Lua scripting (mandatory) ---

target_sources(engine PRIVATE
    src/script/lua/bind_noveltea.cpp
    src/script/lua/bind_runtime_capabilities.cpp
    src/script/lua/bind_typed_script_host.cpp
    src/runtime/running_game.cpp
    src/boundary/running_game_loader.cpp
    src/script/lua/script_runtime.cpp
    src/runtime/runtime_executor.cpp
    src/runtime/runtime_executor_dialogue.cpp
    src/runtime/runtime_executor_interaction.cpp
    src/runtime/runtime_executor_map.cpp
    src/runtime/runtime_executor_room.cpp
    src/script/runtime_script_api.cpp
    src/runtime/runtime_session.cpp
    src/runtime/runtime_checkpoint_service.cpp
)
target_compile_definitions(engine PUBLIC NOVELTEA_HAS_LUA)
target_compile_definitions(engine PRIVATE
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    SOL_ALL_SAFETIES_ON=1
)

set(NOVELTEA_SOL2_SOURCES
    src/script/lua/bind_noveltea.cpp
    src/script/lua/bind_runtime_capabilities.cpp
    src/script/lua/bind_typed_script_host.cpp
    src/script/lua/script_runtime.cpp
)
if(MSVC)
    set_property(SOURCE ${NOVELTEA_SOL2_SOURCES} APPEND PROPERTY COMPILE_OPTIONS /EHs-c- /GR-)
else()
    set_property(SOURCE ${NOVELTEA_SOL2_SOURCES} APPEND PROPERTY COMPILE_OPTIONS
        -fno-exceptions -fno-rtti)
endif()
target_link_libraries(engine PRIVATE Lua::Lua sol2::sol2)

# --- Platform definition ---

if(EMSCRIPTEN)
    target_compile_definitions(engine PUBLIC NOVELTEA_PLATFORM_WEB)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
    target_compile_definitions(engine PUBLIC NOVELTEA_PLATFORM_ANDROID)
else()
    target_compile_definitions(engine PUBLIC NOVELTEA_PLATFORM_DESKTOP)
endif()

target_compile_definitions(engine PUBLIC
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
    add_dependencies(engine noveltea-runtime-assets)
endif()

target_link_libraries(engine PUBLIC SDL3::SDL3)

# --- RmlUi (runtime UI scaffold, mandatory) ---

# RmlUi targets already verified by root CMakeLists.txt.
if(TARGET RmlUi::RmlUi)
    set(NOVELTEA_RMLUI_TARGET RmlUi::RmlUi)
elseif(TARGET RmlUi::Core)
    set(NOVELTEA_RMLUI_TARGET RmlUi::Core)
endif()

target_sources(engine PRIVATE
    src/ui/rmlui/rmlui_input_sdl3.cpp
    src/ui/rmlui/rmlui_bgfx_noveltea_adapter.cpp
    src/ui/rmlui/rmlui_system_interface_sdl3.cpp
)
target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RMLUI)
target_link_libraries(engine PUBLIC ${NOVELTEA_RMLUI_TARGET})
target_link_libraries(engine PRIVATE rmlui_bgfx::rmlui_bgfx RmlUi::Lua)
target_compile_definitions(engine PRIVATE NOVELTEA_HAS_RMLUI_LUA)

# --- Text subsystem (mandatory) ---

target_compile_definitions(engine PUBLIC NOVELTEA_HAS_TEXT)
target_link_libraries(engine PRIVATE
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
        target_sources(engine PRIVATE src/ui_debug_imgui.cpp)
        target_link_libraries(engine PUBLIC imgui::imgui)
        target_compile_definitions(engine PUBLIC NOVELTEA_HAS_IMGUI)
        target_sources(engine PRIVATE src/devtools/imgui_bgfx.cpp)
    else()
        message(STATUS "imgui not found - debug overlay disabled")
        target_sources(engine PRIVATE src/ui_debug_stub.cpp)
    endif()
else()
    message(STATUS "devtools disabled")
    target_sources(engine PRIVATE src/ui_debug_stub.cpp)
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(engine PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
noveltea_apply_runtime_compiler_policy(engine)
noveltea_apply_policy_warnings(engine)
