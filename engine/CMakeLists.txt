add_library(engine STATIC
    src/app.cpp
    src/engine.cpp
    src/platform_sdl.cpp
    src/ui_runtime_rmlui.cpp
)

set_target_properties(engine PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_include_directories(engine
    PUBLIC
        include
)

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
    target_sources(engine PRIVATE src/renderer_bgfx.cpp)
    target_link_libraries(engine PUBLIC bgfx::bgfx)
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
if(NOT EMSCRIPTEN AND NOT CMAKE_SYSTEM_NAME STREQUAL "Android")
    find_package(RmlUi CONFIG QUIET)
    if(RmlUi_FOUND)
        if(TARGET RmlUi::RmlUi)
            set(NOVELTEA_RMLUI_TARGET RmlUi::RmlUi)
        elseif(TARGET RmlUi::Core)
            set(NOVELTEA_RMLUI_TARGET RmlUi::Core)
        endif()

        if(NOVELTEA_RMLUI_TARGET)
            message(STATUS "RmlUi found - runtime UI core enabled (renderer backend TODO)")
            target_link_libraries(engine PUBLIC ${NOVELTEA_RMLUI_TARGET})
            target_compile_definitions(engine PUBLIC NOVELTEA_HAS_RMLUI)
        else()
            message(WARNING "RmlUi package found but no known CMake target was exported; runtime UI scaffold will run without RmlUi linked")
        endif()
    else()
        message(WARNING "RmlUi not found - runtime UI scaffold will run without RmlUi linked")
    endif()
else()
    message(STATUS "RmlUi not linked for this target in the current skeleton")
endif()

# --- Dear ImGui (dev/debug only) ---
if(NOVELTEA_ENABLE_DEVTOOLS)
    find_package(imgui CONFIG QUIET)
    if(imgui_FOUND)
        message(STATUS "imgui found - debug overlay enabled")
        target_sources(engine PRIVATE src/ui_debug_imgui.cpp)
        target_link_libraries(engine PUBLIC imgui::imgui)
        target_compile_definitions(engine PUBLIC NOVELTEA_HAS_IMGUI)
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
