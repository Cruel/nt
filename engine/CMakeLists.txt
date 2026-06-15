add_library(engine STATIC
    src/assets.cpp
    src/app.cpp
    src/engine.cpp
    src/platform_sdl.cpp
    src/render_resources_bgfx.cpp
    src/ui_runtime_rmlui.cpp
)

set_target_properties(engine PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_include_directories(engine
    PUBLIC
        include
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

# --- Dependencies ---
# SDL3::SDL3 target is provided by the root CMakeLists.txt.

    if(NOVELTEA_ENABLE_BGFX AND NOVELTEA_HAS_BGFX)
        message(STATUS "bgfx found - full rendering enabled")

        # Generated shader headers are written to a subdirectory under the
        # source tree for convenient #include by the renderer.  The directory
        # and its *.h / *.h.d files are gitignored (see .gitignore).
        # If you prefer build-dir output, override SHADER_OUT_DIR.

        # ------------------------------------------------------------------ #
        # Shader compilation via bgfx shaderc (host tool).
        # shaderc is provided by vcpkg via bgfx[tools].  The compiled
        # shader headers are generated at build time.
        # ------------------------------------------------------------------ #
        set(SHADER_SRC_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/shaders/bgfx")
    set(SHADER_OUT_DIR  "${CMAKE_CURRENT_SOURCE_DIR}/src/shaders")
    set(SHADER_INCDIRS  "-i" "${SHADER_SRC_DIR}")

    # Find shaderc from vcpkg (host triplet when cross-compiling).
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
        message(FATAL_ERROR "shaderc not found — install bgfx[tools] via vcpkg")
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

    set(SHADER_PROFILES
        glsl   "linux"    "120"
        essl   "android"  "300_es"
    )

    foreach(prof glsl essl)
        list(FIND SHADER_PROFILES "${prof}" _idx)
        math(EXPR _plat_idx "${_idx} + 1")
        math(EXPR _prof_idx "${_idx} + 2")
        list(GET SHADER_PROFILES ${_plat_idx} _plat)
        list(GET SHADER_PROFILES ${_prof_idx} _prof)

        set(_RMLUI_OUTPUTS)
        if(NOVELTEA_ENABLE_RMLUI)
            set(_RMLUI_OUTPUTS
                "${SHADER_OUT_DIR}/vs_rmlui_${prof}.h"
                "${SHADER_OUT_DIR}/fs_rmlui_${prof}.h"
            )
        endif()

        add_custom_command(
            OUTPUT  "${SHADER_OUT_DIR}/vs_triangle_${prof}.h"
                    "${SHADER_OUT_DIR}/fs_triangle_${prof}.h"
                    "${SHADER_OUT_DIR}/vs_quad_${prof}.h"
                    "${SHADER_OUT_DIR}/fs_quad_${prof}.h"
                    ${_RMLUI_OUTPUTS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/vs_triangle.sc"
                    -o "${SHADER_OUT_DIR}/vs_triangle_${prof}.h"
                    --type v
                    --platform ${_plat} -p ${_prof}
                    --bin2c vs_triangle_${prof}
                    ${SHADER_INCDIRS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/fs_triangle.sc"
                    -o "${SHADER_OUT_DIR}/fs_triangle_${prof}.h"
                    --type f
                    --platform ${_plat} -p ${_prof}
                    --bin2c fs_triangle_${prof}
                    ${SHADER_INCDIRS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/vs_quad.sc"
                    -o "${SHADER_OUT_DIR}/vs_quad_${prof}.h"
                    --type v
                    --platform ${_plat} -p ${_prof}
                    --bin2c vs_quad_${prof}
                    ${SHADER_INCDIRS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/fs_quad.sc"
                    -o "${SHADER_OUT_DIR}/fs_quad_${prof}.h"
                    --type f
                    --platform ${_plat} -p ${_prof}
                    --bin2c fs_quad_${prof}
                    ${SHADER_INCDIRS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/vs_rmlui.sc"
                    -o "${SHADER_OUT_DIR}/vs_rmlui_${prof}.h"
                    --type v
                    --platform ${_plat} -p ${_prof}
                    --bin2c vs_rmlui_${prof}
                    ${SHADER_INCDIRS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/fs_rmlui.sc"
                    -o "${SHADER_OUT_DIR}/fs_rmlui_${prof}.h"
                    --type f
                    --platform ${_plat} -p ${_prof}
                    --bin2c fs_rmlui_${prof}
                    ${SHADER_INCDIRS}
            DEPENDS "${SHADER_SRC_DIR}/vs_triangle.sc"
                    "${SHADER_SRC_DIR}/fs_triangle.sc"
                    "${SHADER_SRC_DIR}/vs_quad.sc"
                    "${SHADER_SRC_DIR}/fs_quad.sc"
                    "${SHADER_SRC_DIR}/vs_rmlui.sc"
                    "${SHADER_SRC_DIR}/fs_rmlui.sc"
                    "${SHADER_SRC_DIR}/varying.def.sc"
            COMMENT "Compiling bgfx shaders (${prof})"
            VERBATIM
        )
    endforeach()

    # Also compile a WebGL (ESSL 1.0) variant for web builds
    set(_RMLUI_WEB_OUTPUTS)
    if(NOVELTEA_ENABLE_RMLUI)
        set(_RMLUI_WEB_OUTPUTS
            "${SHADER_OUT_DIR}/vs_rmlui_web.h"
            "${SHADER_OUT_DIR}/fs_rmlui_web.h"
        )
    endif()

    add_custom_command(
        OUTPUT  "${SHADER_OUT_DIR}/vs_triangle_web.h"
                "${SHADER_OUT_DIR}/fs_triangle_web.h"
                "${SHADER_OUT_DIR}/vs_quad_web.h"
                "${SHADER_OUT_DIR}/fs_quad_web.h"
                ${_RMLUI_WEB_OUTPUTS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/vs_triangle.sc"
                -o "${SHADER_OUT_DIR}/vs_triangle_web.h"
                --type v
                --platform asm.js -p 100_es
                --bin2c vs_triangle_web
                ${SHADER_INCDIRS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/fs_triangle.sc"
                -o "${SHADER_OUT_DIR}/fs_triangle_web.h"
                --type f
                --platform asm.js -p 100_es
                --bin2c fs_triangle_web
                ${SHADER_INCDIRS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/vs_quad.sc"
                -o "${SHADER_OUT_DIR}/vs_quad_web.h"
                --type v
                --platform asm.js -p 100_es
                --bin2c vs_quad_web
                ${SHADER_INCDIRS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/fs_quad.sc"
                -o "${SHADER_OUT_DIR}/fs_quad_web.h"
                --type f
                --platform asm.js -p 100_es
                --bin2c fs_quad_web
                ${SHADER_INCDIRS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/vs_rmlui.sc"
                -o "${SHADER_OUT_DIR}/vs_rmlui_web.h"
                --type v
                --platform asm.js -p 100_es
                --bin2c vs_rmlui_web
                ${SHADER_INCDIRS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/fs_rmlui.sc"
                -o "${SHADER_OUT_DIR}/fs_rmlui_web.h"
                --type f
                --platform asm.js -p 100_es
                --bin2c fs_rmlui_web
                ${SHADER_INCDIRS}
        DEPENDS "${SHADER_SRC_DIR}/vs_triangle.sc"
                "${SHADER_SRC_DIR}/fs_triangle.sc"
                "${SHADER_SRC_DIR}/vs_quad.sc"
                "${SHADER_SRC_DIR}/fs_quad.sc"
                "${SHADER_SRC_DIR}/vs_rmlui.sc"
                "${SHADER_SRC_DIR}/fs_rmlui.sc"
                "${SHADER_SRC_DIR}/varying.def.sc"
        COMMENT "Compiling bgfx shaders (web)"
        VERBATIM
    )

    # --- ImGui shaders (compiled alongside triangle shaders) ---
    foreach(prof glsl essl)
        list(FIND SHADER_PROFILES "${prof}" _idx)
        math(EXPR _plat_idx "${_idx} + 1")
        math(EXPR _prof_idx "${_idx} + 2")
        list(GET SHADER_PROFILES ${_plat_idx} _plat)
        list(GET SHADER_PROFILES ${_prof_idx} _prof)

        add_custom_command(
            OUTPUT  "${SHADER_OUT_DIR}/vs_imgui_${prof}.h"
                    "${SHADER_OUT_DIR}/fs_imgui_${prof}.h"
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/vs_imgui.sc"
                    -o "${SHADER_OUT_DIR}/vs_imgui_${prof}.h"
                    --type v
                    --platform ${_plat} -p ${_prof}
                    --bin2c vs_imgui_${prof}
                    ${SHADER_INCDIRS}
            COMMAND "${SHADERC_EXECUTABLE}"
                    -f "${SHADER_SRC_DIR}/fs_imgui.sc"
                    -o "${SHADER_OUT_DIR}/fs_imgui_${prof}.h"
                    --type f
                    --platform ${_plat} -p ${_prof}
                    --bin2c fs_imgui_${prof}
                    ${SHADER_INCDIRS}
            DEPENDS "${SHADER_SRC_DIR}/vs_imgui.sc"
                    "${SHADER_SRC_DIR}/fs_imgui.sc"
                    "${SHADER_SRC_DIR}/varying.def.sc"
            COMMENT "Compiling bgfx shaders (${prof})"
            VERBATIM
        )
    endforeach()

    # Web variant for imgui
    add_custom_command(
        OUTPUT  "${SHADER_OUT_DIR}/vs_imgui_web.h"
                "${SHADER_OUT_DIR}/fs_imgui_web.h"
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/vs_imgui.sc"
                -o "${SHADER_OUT_DIR}/vs_imgui_web.h"
                --type v
                --platform asm.js -p 100_es
                --bin2c vs_imgui_web
                ${SHADER_INCDIRS}
        COMMAND "${SHADERC_EXECUTABLE}"
                -f "${SHADER_SRC_DIR}/fs_imgui.sc"
                -o "${SHADER_OUT_DIR}/fs_imgui_web.h"
                --type f
                --platform asm.js -p 100_es
                --bin2c fs_imgui_web
                ${SHADER_INCDIRS}
        DEPENDS "${SHADER_SRC_DIR}/vs_imgui.sc"
                "${SHADER_SRC_DIR}/fs_imgui.sc"
                "${SHADER_SRC_DIR}/varying.def.sc"
        COMMENT "Compiling bgfx shaders (web)"
        VERBATIM
    )

    target_sources(engine PRIVATE
        src/renderer_bgfx.cpp
        src/shaders/vs_triangle_glsl.h
        src/shaders/fs_triangle_glsl.h
        src/shaders/vs_triangle_essl.h
        src/shaders/fs_triangle_essl.h
        src/shaders/vs_triangle_web.h
        src/shaders/fs_triangle_web.h
        src/shaders/vs_imgui_glsl.h
        src/shaders/fs_imgui_glsl.h
        src/shaders/vs_imgui_essl.h
        src/shaders/fs_imgui_essl.h
        src/shaders/vs_imgui_web.h
        src/shaders/fs_imgui_web.h
        src/shaders/vs_quad_glsl.h
        src/shaders/fs_quad_glsl.h
        src/shaders/vs_quad_essl.h
        src/shaders/fs_quad_essl.h
        src/shaders/vs_quad_web.h
        src/shaders/fs_quad_web.h
        $<$<BOOL:${NOVELTEA_ENABLE_RMLUI}>:src/shaders/vs_rmlui_glsl.h>
        $<$<BOOL:${NOVELTEA_ENABLE_RMLUI}>:src/shaders/fs_rmlui_glsl.h>
        $<$<BOOL:${NOVELTEA_ENABLE_RMLUI}>:src/shaders/vs_rmlui_essl.h>
        $<$<BOOL:${NOVELTEA_ENABLE_RMLUI}>:src/shaders/fs_rmlui_essl.h>
        $<$<BOOL:${NOVELTEA_ENABLE_RMLUI}>:src/shaders/vs_rmlui_web.h>
        $<$<BOOL:${NOVELTEA_ENABLE_RMLUI}>:src/shaders/fs_rmlui_web.h>
    )
    target_include_directories(engine PRIVATE src)

    target_link_libraries(engine PUBLIC bgfx::bgfx)
    if(TARGET bx::bx)
        target_link_libraries(engine PUBLIC bx::bx)
    endif()
    if(CMAKE_SYSTEM_NAME STREQUAL "Android")
        target_link_libraries(engine PUBLIC EGL GLESv2 android)
    endif()
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_BGFX)
else()
    message(STATUS "bgfx not available; using stub renderer")
    target_sources(engine PRIVATE src/renderer_stub.cpp)
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
