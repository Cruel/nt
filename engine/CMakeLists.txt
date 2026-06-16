add_library(engine STATIC
    src/assets/asset_manager.cpp
    src/assets.cpp
    src/app.cpp
    src/audio/miniaudio/miniaudio_backend.cpp
    src/engine.cpp
    src/platform/sdl/sdl_platform.cpp
    src/preview/preview_bridge.cpp
    src/text/text_layout.cpp
    src/ui_runtime_rmlui.cpp
)

set_target_properties(engine PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_include_directories(engine
    PUBLIC
        include
    PRIVATE
        src
)

if(NOVELTEA_ENABLE_RENDER2D)
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RENDER2D)
endif()

if(NOVELTEA_ENABLE_TEXT_LAB)
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_TEXT_LAB)
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
add_custom_target(noveltea-runtime-assets
    COMMAND "${CMAKE_COMMAND}" -E make_directory "${NOVELTEA_RUNTIME_ASSET_ROOT}"
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
            "${NOVELTEA_PROJECT_ASSET_SOURCE}"
            "${NOVELTEA_RUNTIME_ASSET_ROOT}"
    COMMENT "Staging NovelTea runtime assets"
    VERBATIM
)

# --- Dependencies ---
# SDL3::SDL3 target is provided by the root CMakeLists.txt.

if(NOVELTEA_ENABLE_BGFX AND NOVELTEA_HAS_BGFX)
    message(STATUS "bgfx found - full rendering enabled")

    set(SHADER_SRC_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/shaders/bgfx")
    set(SHADER_ASSET_ROOT "${NOVELTEA_RUNTIME_ASSET_ROOT}")
    set(SHADER_EXTRA_INCLUDES)
    set(NOVELTEA_SHADER_MANIFEST "${SHADER_SRC_DIR}/shaders.json")
    if(EMSCRIPTEN)
        set(NOVELTEA_SHADER_VARIANTS essl-100)
    elseif(CMAKE_SYSTEM_NAME STREQUAL "Android")
        set(NOVELTEA_SHADER_VARIANTS essl-300)
    else()
        set(NOVELTEA_SHADER_VARIANTS glsl-120)
    endif()

    if(NOVELTEA_COMPILE_SHADERS)
        # Shader compilation via bgfx shaderc (host tool). shaderc is provided
        # by vcpkg via bgfx[tools].
        find_program(SHADERC_EXECUTABLE shaderc
            PATHS "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/tools/bgfx"
                  "${CMAKE_BINARY_DIR}/vcpkg_installed/${VCPKG_TARGET_TRIPLET}/tools/bgfx"
                  "${CMAKE_SOURCE_DIR}/vcpkg_installed/${CMAKE_HOST_SYSTEM_PROCESSOR}-linux/tools/bgfx"
                  "${CMAKE_SOURCE_DIR}/vcpkg_installed/x64-linux/tools/bgfx"
            NO_DEFAULT_PATH
        )
        if(NOT SHADERC_EXECUTABLE)
            find_program(SHADERC_EXECUTABLE shaderc)
        endif()

        if(NOT SHADERC_EXECUTABLE)
            message(FATAL_ERROR "shaderc not found - install bgfx[tools] via vcpkg or configure with -DNOVELTEA_COMPILE_SHADERS=OFF to use existing compiled shader assets")
        endif()

        # Find bgfx_shader.sh from bgfx include tree (vcpkg layout).
        foreach(_dir
            "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}/include/bgfx"
            "${CMAKE_BINARY_DIR}/vcpkg_installed/${VCPKG_TARGET_TRIPLET}/include/bgfx"
            "${CMAKE_SOURCE_DIR}/vcpkg_installed/${CMAKE_HOST_SYSTEM_PROCESSOR}-linux/include/bgfx"
            "${CMAKE_SOURCE_DIR}/vcpkg_installed/x64-linux/include/bgfx")
            if(EXISTS "${_dir}/bgfx_shader.sh")
                list(APPEND SHADER_EXTRA_INCLUDES --include "${_dir}")
                break()
            endif()
        endforeach()
        set(_variant_args)
        foreach(_variant IN LISTS NOVELTEA_SHADER_VARIANTS)
            list(APPEND _variant_args --variant "${_variant}")
        endforeach()
        add_custom_target(noveltea-shaders
            COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/scripts/compile_bgfx_shaders.py"
                    --manifest "${NOVELTEA_SHADER_MANIFEST}"
                    --shaderc "${SHADERC_EXECUTABLE}"
                    --source-dir "${SHADER_SRC_DIR}"
                    --output-root "${SHADER_ASSET_ROOT}"
                    ${_variant_args}
                    ${SHADER_EXTRA_INCLUDES}
            DEPENDS "${NOVELTEA_SHADER_MANIFEST}"
                    "${CMAKE_SOURCE_DIR}/scripts/compile_bgfx_shaders.py"
                    "${SHADER_SRC_DIR}/varying.def.sc"
                    "${SHADER_SRC_DIR}/vs_triangle.sc" "${SHADER_SRC_DIR}/fs_triangle.sc"
                    "${SHADER_SRC_DIR}/vs_quad.sc" "${SHADER_SRC_DIR}/fs_quad.sc"
                    "${SHADER_SRC_DIR}/vs_text.sc" "${SHADER_SRC_DIR}/fs_text.sc"
                    "${SHADER_SRC_DIR}/vs_imgui.sc" "${SHADER_SRC_DIR}/fs_imgui.sc"
                    "${SHADER_SRC_DIR}/vs_rmlui.sc" "${SHADER_SRC_DIR}/fs_rmlui.sc"
            COMMENT "Compiling NovelTea bgfx shaders"
            VERBATIM
        )
    else()
        unset(SHADERC_EXECUTABLE CACHE)
        set(_missing_assets)
        foreach(_target IN LISTS NOVELTEA_SHADER_VARIANTS)
            foreach(_shader triangle quad text imgui rmlui)
                foreach(_stage vs fs)
                    set(_asset "${SHADER_ASSET_ROOT}/shaders/bgfx/${_target}/${_shader}.${_stage}.bin")
                    if(NOT EXISTS "${_asset}")
                        list(APPEND _missing_assets "${_asset}")
                    endif()
                endforeach()
            endforeach()
        endforeach()
        if(_missing_assets)
            list(GET _missing_assets 0 _first_missing)
            message(FATAL_ERROR "NOVELTEA_COMPILE_SHADERS=OFF requires existing compiled shader assets under ${SHADER_ASSET_ROOT}; missing ${_first_missing}")
        endif()
        add_custom_target(noveltea-shaders)
    endif()
    add_dependencies(noveltea-runtime-assets noveltea-shaders)

    target_sources(engine PRIVATE
        src/render/bgfx/bgfx_renderer.cpp
        src/render/bgfx/bgfx_resources.cpp
        src/render/bgfx/bgfx_quad_batch.cpp
        src/render/bgfx/bgfx_shader_loader.cpp
        src/render/bgfx/text/bgfx_text_renderer.cpp
        src/render/bgfx/bgfx_texture.cpp
    )
    add_dependencies(engine noveltea-runtime-assets)
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_BGFX)
    target_link_libraries(engine PUBLIC bgfx::bgfx)
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

target_link_libraries(engine PUBLIC SDL3::SDL3)

# --- RmlUi (runtime UI scaffold) ---
if(NOVELTEA_ENABLE_RMLUI)
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
        target_link_libraries(engine PUBLIC ${NOVELTEA_RMLUI_TARGET})
        target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RMLUI)
    else()
        message(WARNING "RmlUi not found - runtime UI scaffold will run without RmlUi linked")
    endif()
else()
    message(STATUS "RmlUi disabled")
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
