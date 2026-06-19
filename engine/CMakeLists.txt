add_library(noveltea_core STATIC
    src/core/cutscene_controller.cpp
    src/core/dialogue_controller.cpp
    src/core/entity_ref.cpp
    src/core/entity_type.cpp
    src/core/game_session.cpp
    src/core/legacy/entity_schema.cpp
    src/core/legacy/project_package_reader.cpp
    src/core/legacy/project_importer.cpp
    src/core/project_document.cpp
    src/core/project_model.cpp
    src/core/project_validator.cpp
    src/core/runtime_controller.cpp
    src/core/runtime_events.cpp
    src/core/save_document.cpp
)

target_compile_features(noveltea_core PUBLIC cxx_std_20)

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
target_link_libraries(noveltea_core PUBLIC nlohmann_json::nlohmann_json)

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
target_link_libraries(noveltea_core PRIVATE miniz::miniz)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea_core PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()

add_library(engine STATIC
    src/assets/asset_manager.cpp
    src/assets.cpp
    src/app.cpp
    src/audio/miniaudio/miniaudio_backend.cpp
    src/engine.cpp
    src/platform/sdl/sdl_platform.cpp
    src/preview/preview_bridge.cpp
    src/surface.cpp
    src/text/text_engine.cpp
    src/text/text_layout.cpp
    src/ui/rmlui/rmlui_file_interface.cpp
    src/ui/rmlui/rmlui_render_planning.cpp
    src/ui/rmlui/rmlui_render_pass_scheduler.cpp
    src/ui_runtime_rmlui.cpp
)

set_target_properties(engine PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_include_directories(engine
    PUBLIC
        include
    PRIVATE
        src
)

target_link_libraries(engine PUBLIC noveltea_core)

if(NOVELTEA_ENABLE_RENDER2D)
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RENDER2D)
endif()

if(NOVELTEA_ENABLE_TEXT)
    if(NOT TARGET noveltea_text_freetype
        OR NOT TARGET noveltea_text_harfbuzz
        OR NOT TARGET noveltea_text_sheenbidi
        OR NOT TARGET noveltea_text_unibreak)
        message(FATAL_ERROR "NOVELTEA_ENABLE_TEXT=ON requires NovelTea text dependency targets")
    endif()
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_TEXT)
    set(NOVELTEA_HAS_TEXT ON CACHE INTERNAL "NovelTea text subsystem available")
    target_link_libraries(engine PRIVATE
        noveltea_text_freetype
        noveltea_text_harfbuzz
        noveltea_text_sheenbidi
        noveltea_text_unibreak
    )
else()
    set(NOVELTEA_HAS_TEXT OFF CACHE INTERNAL "NovelTea text subsystem available")
endif()

if(NOVELTEA_ENABLE_LUA)
    if(NOT TARGET Lua::Lua OR NOT TARGET sol2::sol2)
        message(FATAL_ERROR "NOVELTEA_ENABLE_LUA=ON requires Lua::Lua and sol2::sol2")
    endif()
    target_sources(engine PRIVATE
        src/script/lua/bind_noveltea.cpp
        src/script/lua/script_runtime.cpp
    )
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_LUA)
    target_link_libraries(engine PRIVATE Lua::Lua sol2::sol2)
    set(NOVELTEA_HAS_LUA ON CACHE INTERNAL "Lua scripting available")
else()
    set(NOVELTEA_HAS_LUA OFF CACHE INTERNAL "Lua scripting available")
endif()

if(EMSCRIPTEN)
    target_compile_definitions(engine PUBLIC NOVELTEA_PLATFORM_WEB)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
    target_compile_definitions(engine PUBLIC NOVELTEA_PLATFORM_ANDROID)
else()
    target_compile_definitions(engine PUBLIC NOVELTEA_PLATFORM_DESKTOP)
endif()

target_compile_definitions(engine PUBLIC
    NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT="${CMAKE_BINARY_DIR}/runtime-assets"
    NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT="${CMAKE_BINARY_DIR}/runtime-assets"
    NOVELTEA_DEFAULT_CACHE_ASSET_ROOT="${CMAKE_BINARY_DIR}/cache"
)

set(NOVELTEA_RUNTIME_ASSET_ROOT "${CMAKE_BINARY_DIR}/runtime-assets" CACHE PATH "Staged NovelTea runtime asset root")
set(NOVELTEA_PROJECT_ASSET_SOURCE "${CMAKE_SOURCE_DIR}/apps/sandbox/assets" CACHE PATH "Project/demo assets to stage")
set(NOVELTEA_GENERATED_ASSET_ROOT "${CMAKE_BINARY_DIR}/generated-assets")
set(NOVELTEA_GENERATED_SHADER_ASSET_ROOT "${NOVELTEA_GENERATED_ASSET_ROOT}")
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

include(NovelTeaShaders)
if(NOT NOVELTEA_SHADER_VARIANTS)
    noveltea_default_shader_variants(NOVELTEA_SHADER_VARIANTS)
endif()
list(JOIN NOVELTEA_SHADER_VARIANTS ";" NOVELTEA_SHADER_VARIANTS_ARG)

# --- Dependencies ---
# SDL3::SDL3 target is provided by the root CMakeLists.txt.

if(NOVELTEA_ENABLE_BGFX AND NOVELTEA_HAS_BGFX)
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
        src/render/bgfx/bgfx_quad_batch.cpp
        src/render/bgfx/bgfx_shader_loader.cpp
        src/render/bgfx/text/bgfx_text_renderer.cpp
        src/render/bgfx/bgfx_texture.cpp
    )
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_BGFX)
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
        target_link_libraries(engine PUBLIC EGL GLESv2 android)
    endif()
else()
    message(STATUS "bgfx not available; using stub renderer")
    target_sources(engine PRIVATE src/render/renderer_stub.cpp)
endif()

set(NOVELTEA_HAS_RMLUI OFF CACHE INTERNAL "RmlUi available")
set(NOVELTEA_HAS_RMLUI_LUA OFF CACHE INTERNAL "RmlUi Lua plugin available")

if(NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS)
    file(GLOB_RECURSE NOVELTEA_PROJECT_ASSET_INPUTS CONFIGURE_DEPENDS "${NOVELTEA_PROJECT_ASSET_SOURCE}/*")
    add_custom_command(
        OUTPUT "${NOVELTEA_RUNTIME_ASSET_STAMP}"
        COMMAND "${CMAKE_COMMAND}"
            "-DNOVELTEA_PROJECT_ASSET_SOURCE=${NOVELTEA_PROJECT_ASSET_SOURCE}"
            "-DNOVELTEA_SHADER_ASSET_SOURCE=${SHADER_ASSET_ROOT}"
            "-DNOVELTEA_RUNTIME_ASSET_ROOT=${NOVELTEA_RUNTIME_ASSET_ROOT}"
            "-DNOVELTEA_STAGE_STAMP=${NOVELTEA_RUNTIME_ASSET_STAMP}"
            -P "${CMAKE_SOURCE_DIR}/cmake/StageNovelTeaAssets.cmake"
        DEPENDS ${NOVELTEA_PROJECT_ASSET_INPUTS} ${NOVELTEA_SHADER_OUTPUTS}
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

# --- RmlUi (runtime UI scaffold) ---
if(NOVELTEA_ENABLE_RMLUI)
    if(NOT NOVELTEA_HAS_BGFX)
        message(FATAL_ERROR "NOVELTEA_ENABLE_RMLUI=ON requires NOVELTEA_ENABLE_BGFX=ON and a bgfx target for the current backend.")
    endif()
    if(NOT TARGET RmlUi::RmlUi AND NOT TARGET RmlUi::Core)
        find_package(RmlUi CONFIG QUIET)
    endif()
    if(RmlUi_FOUND)
        if(TARGET RmlUi::RmlUi)
            set(NOVELTEA_RMLUI_TARGET RmlUi::RmlUi)
        elseif(TARGET RmlUi::Core)
            set(NOVELTEA_RMLUI_TARGET RmlUi::Core)
        endif()
    elseif(TARGET RmlUi::RmlUi)
        set(NOVELTEA_RMLUI_TARGET RmlUi::RmlUi)
    elseif(TARGET RmlUi::Core)
        set(NOVELTEA_RMLUI_TARGET RmlUi::Core)
    endif()

    if(NOVELTEA_RMLUI_TARGET)
        message(STATUS "RmlUi found - runtime UI core enabled (bgfx render backend)")
        target_sources(engine PRIVATE
            src/ui/rmlui/rmlui_input_sdl3.cpp
            src/ui/rmlui/rmlui_render_interface_bgfx.cpp
            src/ui/rmlui/rmlui_system_interface_sdl3.cpp
        )
        target_link_libraries(engine PUBLIC ${NOVELTEA_RMLUI_TARGET})
        target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RMLUI)
        set(NOVELTEA_HAS_RMLUI ON CACHE INTERNAL "RmlUi available")
        if(NOVELTEA_ENABLE_LUA AND NOVELTEA_ENABLE_RMLUI_LUA)
            if(NOT TARGET RmlUi::Lua)
                message(FATAL_ERROR "NOVELTEA_ENABLE_RMLUI_LUA=ON requires RmlUi::Lua. Ensure the rmlui lua feature is enabled.")
            endif()
            target_link_libraries(engine PRIVATE RmlUi::Lua)
            target_compile_definitions(engine PRIVATE NOVELTEA_HAS_RMLUI_LUA)
            set(NOVELTEA_HAS_RMLUI_LUA ON CACHE INTERNAL "RmlUi Lua plugin available")
        endif()
    else()
        message(WARNING "RmlUi not found - runtime UI scaffold will run without RmlUi linked")
        set(NOVELTEA_HAS_RMLUI OFF CACHE INTERNAL "RmlUi available")
    endif()
else()
    message(STATUS "RmlUi disabled")
    set(NOVELTEA_HAS_RMLUI OFF CACHE INTERNAL "RmlUi available")
endif()

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

        if(NOVELTEA_HAS_BGFX)
            message(STATUS "bgfx + imgui: adding bgfx-backed ImGui renderer")
            target_sources(engine PRIVATE src/devtools/imgui_bgfx.cpp)
        endif()
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
