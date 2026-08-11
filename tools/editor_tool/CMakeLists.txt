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
    BX_CONFIG_DEBUG=$<CONFIG:Debug>
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})

add_library(noveltea_tooling_native STATIC
    tooling_native.cpp
    tooling_native.hpp
    tooling_native_c.h
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp"
)
# This engine-owned source is reused by host tooling but remains part of the shipped runtime policy
# domain. Apply the runtime compiler policy to this source only; the surrounding tooling target keeps
# the normal host exception/RTTI model required by embedded shaderc.
if(MSVC)
    set_property(SOURCE "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp" APPEND PROPERTY
        COMPILE_OPTIONS /GR- /EHs-c- /Zc:__cplusplus /Zc:preprocessor
            "/FI${CMAKE_SOURCE_DIR}/engine/include/noveltea/core/compiler_policy.hpp")
    set_property(SOURCE "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp" APPEND PROPERTY
        COMPILE_DEFINITIONS _HAS_EXCEPTIONS=0)
else()
    set_property(SOURCE "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp" APPEND PROPERTY
        COMPILE_OPTIONS -fno-exceptions -fno-rtti
            "-include${CMAKE_SOURCE_DIR}/engine/include/noveltea/core/compiler_policy.hpp")
endif()
set_target_properties(noveltea_tooling_native PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_link_libraries(noveltea_tooling_native PUBLIC
    noveltea_content
    noveltea_runtime
    noveltea_presentation
    noveltea_script_lua
    noveltea_shader_tooling
    PRIVATE nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea_tooling_native PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
target_include_directories(noveltea_tooling_native PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea_tooling_native PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
noveltea_apply_policy_warnings(noveltea_tooling_native)
