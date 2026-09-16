find_package(nlohmann_json CONFIG REQUIRED)

include(NovelTeaEmbeddedShaderc)
noveltea_configure_embedded_shaderc()

add_library(noveltea_shader_tooling STATIC
    shader_compiler.cpp
)
set_target_properties(noveltea_shader_tooling PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_link_libraries(noveltea_shader_tooling PUBLIC noveltea_content PRIVATE
    noveltea_bgfx_shaderc_embedded
    nlohmann_json::nlohmann_json)
target_include_directories(noveltea_shader_tooling PRIVATE
    "${NOVELTEA_EMBEDDED_SHADERC_INCLUDE_DIR}"
    "${NOVELTEA_EMBEDDED_SHADERC_GENERATED_DIR}")
target_compile_definitions(noveltea_shader_tooling PRIVATE
    NOVELTEA_HAS_EMBEDDED_SHADERC=1
    NOVELTEA_BGFX_VERSION_STRING="${NOVELTEA_BGFX_VERSION}"
    BX_CONFIG_DEBUG=$<CONFIG:Debug>
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
if(MSVC)
    # bx requires the standards-conforming C++ language-version macro under MSVC.
    target_compile_options(noveltea_shader_tooling PRIVATE /Zc:__cplusplus /Zc:preprocessor)
endif()

add_library(noveltea_text_tooling STATIC
    "${CMAKE_SOURCE_DIR}/engine/src/text/text_engine.cpp"
    "${CMAKE_SOURCE_DIR}/engine/src/text/text_breaks.cpp"
)
set_target_properties(noveltea_text_tooling PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_features(noveltea_text_tooling PUBLIC cxx_std_20)
target_include_directories(noveltea_text_tooling
    PUBLIC "${CMAKE_SOURCE_DIR}/engine/include"
    PRIVATE "${CMAKE_SOURCE_DIR}/engine/src"
)
target_link_libraries(noveltea_text_tooling PRIVATE
    noveltea_text_freetype
    noveltea_text_harfbuzz
    noveltea_text_sheenbidi
    noveltea_text_unibreak
)
noveltea_apply_runtime_compiler_policy(noveltea_text_tooling)
noveltea_apply_policy_warnings(noveltea_text_tooling)

add_library(noveltea_tooling_native STATIC
    tooling_native.cpp
    tooling_native.hpp
    tooling_native_c.h
    tooling_native_scriptc.cpp
    tooling_image.cpp
    tooling_filesystem.cpp
    tooling_runtime_cache.cpp
    font_coverage_tool.cpp
    tooling_archive.cpp
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_playback_expectations.cpp"
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp"
)
# These engine-owned sources are reused by host tooling but remain part of the shipped runtime policy
# domain. Apply the runtime compiler policy to them only; the surrounding tooling target keeps the
# normal host exception/RTTI model required by embedded shaderc.
set(_NOVELTEA_TOOLING_RUNTIME_SOURCES
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_playback_expectations.cpp"
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp")
foreach(_source IN LISTS _NOVELTEA_TOOLING_RUNTIME_SOURCES)
    if(MSVC)
        set_property(SOURCE "${_source}" APPEND PROPERTY
            COMPILE_OPTIONS /GR- /EHs-c- /Zc:__cplusplus /Zc:preprocessor
                "/FI${CMAKE_SOURCE_DIR}/engine/include/noveltea/core/compiler_policy.hpp")
        set_property(SOURCE "${_source}" APPEND PROPERTY COMPILE_DEFINITIONS _HAS_EXCEPTIONS=0)
    else()
        set_property(SOURCE "${_source}" APPEND PROPERTY
            COMPILE_OPTIONS -fno-exceptions -fno-rtti
                "-include${CMAKE_SOURCE_DIR}/engine/include/noveltea/core/compiler_policy.hpp")
    endif()
endforeach()
set_target_properties(noveltea_tooling_native PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_link_libraries(noveltea_tooling_native PUBLIC
    noveltea_content
    noveltea_runtime
    noveltea_presentation
    noveltea_script_lua
    noveltea_shader_tooling
    noveltea_text_tooling
    PRIVATE noveltea_bimg_texturec_embedded nlohmann_json::nlohmann_json miniz::miniz)
target_compile_definitions(noveltea_tooling_native PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
target_include_directories(noveltea_tooling_native PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}" PRIVATE
    "${NOVELTEA_EMBEDDED_SHADERC_INCLUDE_DIR}"
    "${CMAKE_SOURCE_DIR}/engine/src")
if(TARGET bgfx::bimg)
    target_link_libraries(noveltea_tooling_native PRIVATE bgfx::bimg)
elseif(TARGET bimg::bimg)
    target_link_libraries(noveltea_tooling_native PRIVATE bimg::bimg)
elseif(TARGET bimg)
    target_link_libraries(noveltea_tooling_native PRIVATE bimg)
endif()
if(TARGET bgfx::bimg_decode)
    target_link_libraries(noveltea_tooling_native PRIVATE bgfx::bimg_decode)
elseif(TARGET bimg_decode)
    target_link_libraries(noveltea_tooling_native PRIVATE bimg_decode)
endif()
if(TARGET bgfx::bimg_encode)
    target_link_libraries(noveltea_tooling_native PRIVATE bgfx::bimg_encode)
elseif(TARGET bimg_encode)
    target_link_libraries(noveltea_tooling_native PRIVATE bimg_encode)
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea_tooling_native PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
noveltea_apply_policy_warnings(noveltea_tooling_native)

add_executable(noveltea-ui-test-runner tooling_ui_test_runner.cpp)
target_include_directories(noveltea-ui-test-runner PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src")
target_link_libraries(noveltea-ui-test-runner PRIVATE
    noveltea_engine
    nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-ui-test-runner PRIVATE
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
    NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT="${NOVELTEA_RUNTIME_ASSET_ROOT}/system")
noveltea_apply_policy_warnings(noveltea-ui-test-runner)
add_dependencies(noveltea_tooling_native noveltea-ui-test-runner)
target_compile_definitions(noveltea_tooling_native PRIVATE
    NOVELTEA_UI_TEST_RUNNER_PATH="$<TARGET_FILE:noveltea-ui-test-runner>")

add_executable(noveltea-tooling-bridge tooling_bridge.cpp)
target_link_libraries(noveltea-tooling-bridge PRIVATE noveltea_tooling_native)
noveltea_apply_policy_warnings(noveltea-tooling-bridge)
