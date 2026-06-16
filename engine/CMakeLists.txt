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
    NOVELTEA_DEFAULT_SYSTEM_ASSET_ROOT="${CMAKE_BINARY_DIR}/assets"
    NOVELTEA_DEFAULT_CACHE_ASSET_ROOT="${CMAKE_BINARY_DIR}/assets"
)

# --- Dependencies ---
# SDL3::SDL3 target is provided by the root CMakeLists.txt.

if(NOVELTEA_ENABLE_BGFX AND NOVELTEA_HAS_BGFX)
    message(STATUS "bgfx found - full rendering enabled")

    set(SHADER_SRC_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/shaders/bgfx")
    set(SHADER_ASSET_ROOT "${CMAKE_BINARY_DIR}/assets")
    set(SHADER_INCDIRS  "-i" "${SHADER_SRC_DIR}")
    set(NOVELTEA_SHADER_NAMES triangle quad text imgui
    )
    if(NOVELTEA_ENABLE_RMLUI)
        list(APPEND NOVELTEA_SHADER_NAMES rmlui)
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
                list(APPEND SHADER_INCDIRS "-i" "${_dir}")
                break()
            endif()
        endforeach()
        set(NOVELTEA_SHADER_TARGETS
            linux-glsl   linux   120
            android-essl android 300_es
            web-essl100  asm.js  100_es
        )
        set(NOVELTEA_SHADER_BINARIES)
        foreach(_target linux-glsl android-essl web-essl100)
            list(FIND NOVELTEA_SHADER_TARGETS "${_target}" _idx)
            math(EXPR _plat_idx "${_idx} + 1")
            math(EXPR _prof_idx "${_idx} + 2")
            list(GET NOVELTEA_SHADER_TARGETS ${_plat_idx} _platform)
            list(GET NOVELTEA_SHADER_TARGETS ${_prof_idx} _profile)
            set(_out_dir "${SHADER_ASSET_ROOT}/shaders/bgfx/${_target}")
            foreach(_shader IN LISTS NOVELTEA_SHADER_NAMES)
                foreach(_stage vs fs)
                    set(_type v)
                    if(_stage STREQUAL "fs")
                        set(_type f)
                    endif()
                    set(_out "${_out_dir}/${_shader}.${_stage}.bin")
                    list(APPEND NOVELTEA_SHADER_BINARIES "${_out}")
                    add_custom_command(
                        OUTPUT "${_out}"
                        COMMAND "${CMAKE_COMMAND}" -E make_directory "${_out_dir}"
                        COMMAND "${SHADERC_EXECUTABLE}"
                                -f "${SHADER_SRC_DIR}/${_stage}_${_shader}.sc"
                                -o "${_out}"
                                --type ${_type}
                                --platform ${_platform} -p ${_profile}
                                ${SHADER_INCDIRS}
                        DEPENDS "${SHADER_SRC_DIR}/${_stage}_${_shader}.sc"
                                "${SHADER_SRC_DIR}/varying.def.sc"
                        COMMENT "Compiling bgfx shader ${_target}/${_shader}.${_stage}.bin"
                        VERBATIM
                    )
                endforeach()
            endforeach()
        endforeach()
        add_custom_target(noveltea-shaders DEPENDS ${NOVELTEA_SHADER_BINARIES})
    else()
        unset(SHADERC_EXECUTABLE CACHE)
        set(_missing_assets)
        foreach(_target linux-glsl android-essl web-essl100)
            foreach(_shader IN LISTS NOVELTEA_SHADER_NAMES)
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

    target_sources(engine PRIVATE
        src/render/bgfx/bgfx_renderer.cpp
        src/render/bgfx/bgfx_resources.cpp
        src/render/bgfx/bgfx_quad_batch.cpp
        src/render/bgfx/bgfx_shader_loader.cpp
        src/render/bgfx/text/bgfx_text_renderer.cpp
        src/render/bgfx/bgfx_texture.cpp
    )
    add_dependencies(engine noveltea-shaders)
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
