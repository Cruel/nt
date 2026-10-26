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
    # A Debug shaderc build emits BX_TRACE to stdout even for successful
    # compiles, breaking the standalone CLI JSON protocol.
    BX_CONFIG_DEBUG=0
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
    tooling_daemon_broker.cpp
    tooling_daemon_broker.hpp
    tooling_native_project_validation.cpp
    tooling_native_project_commands.cpp
    tooling_native_project_asset.cpp
    tooling_native_asset_media.cpp
    tooling_native_project_create.cpp
    tooling_native_project_fmt.cpp
    tooling_native_project_localization.cpp
    tooling_native_project_sync.cpp
    tooling_native_project_entity.cpp
    tooling_native_project_bundle.cpp
    tooling_project_authority.cpp
    tooling_project_authority.hpp
    tooling_native.cpp
    tooling_native.hpp
    tooling_native_c.h
    tooling_native_scriptc.cpp
    tooling_scriptc_gc.cpp
    tooling_image.cpp
    tooling_alpha_encoder.cpp
    "${CMAKE_SOURCE_DIR}/engine/src/media/animated_webp_alpha.cpp"
    tooling_filesystem.cpp
    tooling_runtime_cache.cpp
    font_coverage_tool.cpp
    font_inspection_tool.cpp
    tooling_archive.cpp
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_playback_expectations.cpp"
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp"
)
# These engine-owned sources are reused by host tooling but remain part of the shipped runtime policy
# domain. Apply the runtime compiler policy to them only; the surrounding tooling target keeps the
# normal host exception/RTTI model required by embedded shaderc.
set(_NOVELTEA_TOOLING_RUNTIME_SOURCES
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_playback_expectations.cpp"
    "${CMAKE_SOURCE_DIR}/engine/src/core/editor_runtime_protocol.cpp"
    "${CMAKE_SOURCE_DIR}/engine/src/media/animated_webp_alpha.cpp")
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
    PRIVATE noveltea_project_authoring_session
            noveltea_bimg_texturec_embedded nlohmann_json::nlohmann_json miniz::miniz
            noveltea_text_freetype)
target_compile_definitions(noveltea_tooling_native PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
if(WIN32)
    target_link_libraries(noveltea_tooling_native PRIVATE advapi32)
endif()
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
    RmlUi::Core
    nlohmann_json::nlohmann_json)
if(MINGW)
    target_link_options(noveltea-ui-test-runner PRIVATE -static -static-libgcc -static-libstdc++)
endif()
if(MSVC)
    target_compile_options(noveltea-ui-test-runner PRIVATE /bigobj)
endif()
target_compile_definitions(noveltea-ui-test-runner PRIVATE
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
    NOVELTEA_UI_TEST_SYSTEM_ASSET_ROOT="${NOVELTEA_RUNTIME_ASSET_ROOT}/system")
noveltea_apply_policy_warnings(noveltea-ui-test-runner)
add_dependencies(noveltea_tooling_native noveltea-ui-test-runner)
target_compile_definitions(noveltea_tooling_native PRIVATE
    NOVELTEA_UI_TEST_RUNNER_PATH="$<TARGET_FILE:noveltea-ui-test-runner>")

add_executable(noveltea-tooling-bridge tooling_bridge.cpp)
target_link_libraries(noveltea-tooling-bridge PRIVATE noveltea_tooling_native nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-tooling-bridge PRIVATE
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
    NOVELTEA_TOOLING_SYSTEM_ASSET_ROOT="${NOVELTEA_RUNTIME_ASSET_ROOT}/system")
noveltea_apply_policy_warnings(noveltea-tooling-bridge)
# Unshipped direct-C++ CLI slice; the ScriptC production executable is unchanged.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/editor/src/cli/static-contracts.ts"
    "${CMAKE_SOURCE_DIR}/editor/src/shared/project-schema/authoring-collections.ts"
    "${CMAKE_SOURCE_DIR}/VERSION")
file(READ "${CMAKE_SOURCE_DIR}/editor/src/cli/static-contracts.ts" _cli_contract)
string(REGEX MATCH "export const NOVELTEA_CLI_HELP = `([^`]+)`;" _cli_help "${_cli_contract}")
if(NOT _cli_help)
    message(FATAL_ERROR "Cannot extract the canonical CLI help contract")
endif()
set(NOVELTEA_NATIVE_CLI_HELP "${CMAKE_MATCH_1}")
file(READ "${CMAKE_SOURCE_DIR}/editor/src/shared/project-schema/authoring-collections.ts" _collections)
string(REGEX MATCH "authoringCollectionKeys = \\[([^]]+)\\] as const" _collection_keys "${_collections}")
if(NOT _collection_keys)
    message(FATAL_ERROR "Cannot extract the canonical CLI collection keys")
endif()
string(REPLACE "'" "\"" NOVELTEA_NATIVE_CLI_COLLECTIONS "${CMAKE_MATCH_1}")
# Runtime-cache admission must never guess the producer's compiler identity.
# Clean Git builds can bind their identity to the commit; dirty standalone
# builds cannot safely claim another executable's compiled-runtime cache.
# Release builders can supply the exact pinned build identity explicitly.
set(NOVELTEA_NATIVE_CLI_BUILD_IDENTITY "" CACHE STRING
    "Exact build identity for native runtime cache acceptance")
if(NOT NOVELTEA_NATIVE_CLI_BUILD_IDENTITY)
    execute_process(COMMAND git -C "${CMAKE_SOURCE_DIR}" rev-parse HEAD
        OUTPUT_VARIABLE _native_cli_git_sha OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE _native_cli_git_result ERROR_QUIET)
    execute_process(COMMAND git -C "${CMAKE_SOURCE_DIR}" status --porcelain
        OUTPUT_VARIABLE _native_cli_git_dirty OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE _native_cli_git_status ERROR_QUIET)
    if(_native_cli_git_result EQUAL 0 AND _native_cli_git_status EQUAL 0 AND NOT _native_cli_git_dirty)
        set(NOVELTEA_NATIVE_CLI_BUILD_IDENTITY "git:${_native_cli_git_sha}")
    endif()
endif()
if(NOVELTEA_NATIVE_CLI_BUILD_IDENTITY)
    set(NOVELTEA_NATIVE_CLI_COMPILER_IDENTITY
        "${NOVELTEA_VERSION}:${NOVELTEA_NATIVE_CLI_BUILD_IDENTITY}")
else()
    set(NOVELTEA_NATIVE_CLI_COMPILER_IDENTITY "")
endif()
configure_file(native_cli_contract.hpp.in native_cli_contract.hpp @ONLY)
add_executable(noveltea-native-cli EXCLUDE_FROM_ALL native_cli.cpp native_cli_test_catalog.cpp
    native_compiled_project_save_contract.cpp native_compiled_project.cpp
    native_runtime_artifact.cpp native_runtime_physical.cpp native_runtime_media.cpp
    native_runtime_materials.cpp
    native_flow_prediction.cpp native_authoring_resources.cpp
    native_authoring_messages.cpp native_authoring_shared.cpp native_authoring_programs.cpp
    native_authoring_dialogue_interaction.cpp)
set_target_properties(noveltea-native-cli PROPERTIES
    OUTPUT_NAME noveltea
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/native-cli")
target_include_directories(noveltea-native-cli PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_include_directories(noveltea-native-cli PRIVATE "${CMAKE_SOURCE_DIR}/tools/project_authoring")
target_include_directories(noveltea-native-cli PRIVATE "${CMAKE_BINARY_DIR}/tools/project_authoring")
target_link_libraries(noveltea-native-cli PRIVATE noveltea_tooling_native nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-native-cli PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
noveltea_apply_policy_warnings(noveltea-native-cli)
# Native font coverage resolves the same trusted system fonts as the installed
# production CLI. Stage them alongside the unshipped candidate, without a
# launcher, runtime ScriptC island or source-tree absolute path dependency.
add_custom_command(TARGET noveltea-native-cli POST_BUILD
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
        "${CMAKE_SOURCE_DIR}/engine/assets/system"
        "$<TARGET_FILE_DIR:noveltea-native-cli>/assets/system"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different
        "$<TARGET_FILE:noveltea-ui-test-runner>"
        "$<TARGET_FILE_DIR:noveltea-native-cli>/$<TARGET_FILE_NAME:noveltea-ui-test-runner>"
    COMMENT "Staging native CLI system font assets")
if(BUILD_TESTING)
    set_target_properties(noveltea-native-cli PROPERTIES EXCLUDE_FROM_ALL FALSE)
    find_package(Python3 COMPONENTS Interpreter REQUIRED)
    add_test(NAME native_cli_public_contract
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_cli_contract.py"
            "$<TARGET_FILE:noveltea-native-cli>" "${CMAKE_SOURCE_DIR}")
    add_test(NAME native_cli_runtime_cache
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_cli_runtime_cache.py"
            "$<TARGET_FILE:noveltea-native-cli>" "${CMAKE_SOURCE_DIR}"
            "--compiler-identity=${NOVELTEA_NATIVE_CLI_COMPILER_IDENTITY}")
    set_tests_properties(native_cli_runtime_cache PROPERTIES SKIP_RETURN_CODE 77)
    add_test(NAME native_cli_cold_runtime
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_cli_cold_runtime.py"
            "$<TARGET_FILE:noveltea-native-cli>"
            "$<TARGET_FILE:noveltea-runtime-cache-publish-certify>"
            "${NOVELTEA_NATIVE_CLI_COMPILER_IDENTITY}")
    set_tests_properties(native_cli_cold_runtime PROPERTIES SKIP_RETURN_CODE 77)
    set(NOVELTEA_NATIVE_CLI_CERTIFY_FFMPEG "" CACHE FILEPATH
        "Pinned NovelTea ffmpeg-r3 executable used to certify cold Feature Lab media")
    if(NOT NOVELTEA_NATIVE_CLI_CERTIFY_FFMPEG)
        if(WIN32)
            set(_native_ffmpeg_name ffmpeg.exe)
        else()
            set(_native_ffmpeg_name ffmpeg)
        endif()
        set(_native_ffmpeg_candidate
            "${CMAKE_SOURCE_DIR}/build/cli/linux/tools/ffmpeg/bin/${_native_ffmpeg_name}")
        if(EXISTS "${_native_ffmpeg_candidate}")
            set(NOVELTEA_NATIVE_CLI_CERTIFY_FFMPEG "${_native_ffmpeg_candidate}")
        endif()
    endif()
    set(_native_cli_cold_player "")
    if(NOVELTEA_BUILD_PLAYER)
        set(_native_cli_cold_player "$<TARGET_FILE:noveltea-player>")
    endif()
    add_test(NAME native_cli_feature_lab_cold
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_cli_feature_lab_cold.py"
            "$<TARGET_FILE:noveltea-native-cli>" "${CMAKE_SOURCE_DIR}"
            "${NOVELTEA_NATIVE_CLI_COMPILER_IDENTITY}"
            "${NOVELTEA_NATIVE_CLI_CERTIFY_FFMPEG}"
            "${_native_cli_cold_player}")
    set_tests_properties(native_cli_feature_lab_cold PROPERTIES
        SKIP_RETURN_CODE 77 TIMEOUT 900)
    add_executable(noveltea-runtime-cache-publish-certify
        tooling_runtime_cache_publish_certify.cpp native_compiled_project_save_contract.cpp
        native_compiled_project.cpp native_runtime_artifact.cpp native_runtime_physical.cpp native_runtime_media.cpp native_runtime_materials.cpp
        native_flow_prediction.cpp
        native_authoring_resources.cpp native_authoring_messages.cpp native_authoring_shared.cpp
        native_authoring_programs.cpp native_authoring_dialogue_interaction.cpp)
    target_link_libraries(noveltea-runtime-cache-publish-certify PRIVATE
        noveltea_tooling_native noveltea_script_lua noveltea_presentation nlohmann_json::nlohmann_json)
    target_include_directories(noveltea-runtime-cache-publish-certify PRIVATE
        "${CMAKE_SOURCE_DIR}/tools/project_authoring"
        "${CMAKE_SOURCE_DIR}/tests"
        "${CMAKE_BINARY_DIR}/tools/project_authoring")
    add_test(NAME native_runtime_cache_publish
        COMMAND "$<TARGET_FILE:noveltea-runtime-cache-publish-certify>"
            "${CMAKE_SOURCE_DIR}/tests/projects/feature-lab")
    set_tests_properties(native_runtime_cache_publish PROPERTIES SKIP_RETURN_CODE 77)
    add_test(NAME native_compiled_project_parity
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_compiled_project_parity.py"
            "$<TARGET_FILE:noveltea-runtime-cache-publish-certify>" "${CMAKE_SOURCE_DIR}")
    add_test(NAME native_runtime_artifact_parity
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_runtime_artifact_parity.py"
            "$<TARGET_FILE:noveltea-runtime-cache-publish-certify>" "${CMAKE_SOURCE_DIR}")
    add_test(NAME native_runtime_physical
        COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tests/native_runtime_physical.py"
            "$<TARGET_FILE:noveltea-runtime-cache-publish-certify>"
            "${CMAKE_SOURCE_DIR}/tests/projects/feature-lab")
    set_tests_properties(native_runtime_physical PROPERTIES SKIP_RETURN_CODE 77)
endif()

add_executable(noveltea-cli-native-certify EXCLUDE_FROM_ALL tooling_native_project_commands_certify.cpp)
target_link_libraries(noveltea-cli-native-certify PRIVATE noveltea_tooling_native nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-cli-native-certify PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
if(BUILD_TESTING)
    add_test(NAME native_authoring_cli_commands
        COMMAND noveltea-cli-native-certify "${CMAKE_SOURCE_DIR}/tests/projects/feature-lab")
endif()
