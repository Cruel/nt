add_library(engine STATIC
    src/app.cpp
    src/engine.cpp
    src/platform_sdl.cpp
    src/renderer_bgfx.cpp
)

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

find_package(SDL3 CONFIG QUIET)
if(NOT SDL3_FOUND)
    message(FATAL_ERROR "SDL3 required. Install via vcpkg (Linux) or SDK (Android/Web).")
endif()

find_package(bgfx CONFIG QUIET)
if(bgfx_FOUND)
    message(STATUS "bgfx found — full rendering enabled")
    target_sources(engine PRIVATE src/renderer_bgfx.cpp)
    target_link_libraries(engine PUBLIC bgfx::bgfx)
    target_compile_definitions(engine PUBLIC NOVELTEA_HAS_BGFX)
else()
    message(WARNING "bgfx not found — using stub renderer")
    target_sources(engine PRIVATE src/renderer_stub.cpp)
endif()

target_link_libraries(engine PUBLIC SDL3::SDL3)

# --- Dear ImGui (dev/debug only) ---
if(NOVELTEA_USE_IMGUI)
    find_package(imgui CONFIG QUIET)
    if(imgui_FOUND)
        message(STATUS "imgui found — debug overlay enabled")
        target_sources(engine PRIVATE src/ui_debug_imgui.cpp)
        target_link_libraries(engine PUBLIC imgui::imgui)
        target_compile_definitions(engine PUBLIC NOVELTEA_HAS_IMGUI)
    else()
        message(STATUS "imgui not found — debug overlay disabled")
    endif()
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(engine PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
