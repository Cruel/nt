include(Catch)

# Tests that construct JSON wire fixtures are explicit boundary consumers.
find_package(nlohmann_json CONFIG REQUIRED)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_executable(noveltea_rmlui_patch_framework_test
        cmake/rmlui_patch_framework_test.cpp)
    target_compile_definitions(noveltea_rmlui_patch_framework_test PRIVATE
        NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION="${NOVELTEA_RMLUI_PATCH_REVISION}")
    target_link_libraries(noveltea_rmlui_patch_framework_test PRIVATE RmlUi::Core)
    add_test(
        NAME noveltea_rmlui_patch_framework
        COMMAND noveltea_rmlui_patch_framework_test)
    set_tests_properties(noveltea_rmlui_patch_framework PROPERTIES
        LABELS "rmlui;dependency;patch")
    add_custom_target(rmlui-patch-test
        COMMAND "$<TARGET_FILE:noveltea_rmlui_patch_framework_test>"
        DEPENDS noveltea_rmlui_patch_framework_test
        COMMENT "Verifying the repository-owned RmlUi patch framework"
        VERBATIM)
endif()

# --- Module-owned tests (always built) ---

add_executable(noveltea_domain_tests
    core/compiled_project_model_tests.cpp
    core/result_tests.cpp
    core/runtime_value_tests.cpp
    render/reference_resolution_contract_tests.cpp
)
target_link_libraries(noveltea_domain_tests PRIVATE
    noveltea_domain
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_domain_tests)

add_executable(noveltea_content_tests
    core/compiled_package_tests.cpp
    core/compiled_project_wire_tests.cpp
    core/json_access_tests.cpp
    core/player_bootstrap_tests.cpp
    core/rich_text_tests.cpp
    core/runtime_user_settings_tests.cpp
    render/material_asset_tests.cpp
    render/shader_compiler_tests.cpp
    render/shader_manifest_tests.cpp
    render/shader_package_export_tests.cpp
)
target_include_directories(noveltea_content_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_compile_definitions(noveltea_content_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
)
target_link_libraries(noveltea_content_tests PRIVATE
    noveltea_content
    noveltea_domain
    nlohmann_json::nlohmann_json
    # This lower-layer test binary has no bimg provider, so it intentionally links
    # the standalone miniz implementation used by the content codecs under test.
    miniz::miniz
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_content_tests)

add_executable(noveltea_runtime_tests
    core/gameplay_pause_tests.cpp
    core/runtime_clock_tests.cpp
    core/session_state_tests.cpp
    core/shared_evaluator_tests.cpp
    core/typed_save_slot_store_tests.cpp
    runtime/runtime_contracts_tests.cpp
    script/runtime_checkpoint_service_tests.cpp
)
target_include_directories(noveltea_runtime_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(noveltea_runtime_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
)
target_link_libraries(noveltea_runtime_tests PRIVATE
    noveltea_runtime
    noveltea_content
    noveltea_domain
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_runtime_tests)

add_executable(noveltea_presentation_tests
    core/flow_executor_tests.cpp
    core/presentation_checkpoint_contracts_tests.cpp
    core/presentation_coordinator_tests.cpp
    core/runtime_presentation_tests.cpp
    core/save_state_tests.cpp
    ui/runtime_layout_manager_tests.cpp
    ui/runtime_system_layouts_tests.cpp
)
target_include_directories(noveltea_presentation_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_definitions(noveltea_presentation_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
)
target_link_libraries(noveltea_presentation_tests PRIVATE
    noveltea_presentation
    noveltea_runtime
    noveltea_content
    noveltea_domain
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_presentation_tests)

add_executable(noveltea_script_lua_tests
    core/runtime_domain_types_tests.cpp
    script/script_runtime_tests.cpp
    script/typed_dialogue_execution_tests.cpp
    script/typed_execution_kernel_tests.cpp
    script/typed_interaction_execution_tests.cpp
    script/typed_map_execution_tests.cpp
    script/typed_room_execution_tests.cpp
    script/typed_runtime_session_tests.cpp
)
target_include_directories(noveltea_script_lua_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_compile_definitions(noveltea_script_lua_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    SOL_ALL_SAFETIES_ON=1
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
)
target_link_libraries(noveltea_script_lua_tests PRIVATE
    noveltea_script_lua
    noveltea_presentation
    noveltea_runtime
    noveltea_content
    noveltea_domain
    Lua::Lua
    sol2::sol2
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_script_lua_tests)

# --- Host characterization tests (Engine-linked, no platform initialization required) ---

add_executable(noveltea_host_tests
    core/editor_runtime_protocol_tests.cpp
    host/audio_preview_adapter_tests.cpp
    host/debug_ui_isolation_tests.cpp
    host/game_host_tests.cpp
    host/host_characterization_tests.cpp
    host/host_contracts_tests.cpp
    host/host_input_router_tests.cpp
    host/layout_realizer_tests.cpp
    host/screenshot_capture_tests.cpp
    script/compiled_runtime_tests.cpp
    script/runtime_audio_adapter_tests.cpp
)
target_include_directories(noveltea_host_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_compile_definitions(noveltea_host_tests PRIVATE NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_host_tests PRIVATE
    noveltea_engine
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
target_compile_definitions(noveltea_host_tests PRIVATE
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
catch_discover_tests(noveltea_host_tests)

add_test(
    NAME noveltea_editor_tool_malformed_json
    COMMAND /bin/sh -c "printf '{' | '$<TARGET_FILE:noveltea-editor-tool>' run-test || true"
)
set_tests_properties(noveltea_editor_tool_malformed_json PROPERTIES
    PASS_REGULAR_EXPRESSION "Malformed request JSON"
)

# --- Text tests (text stack is mandatory) ---

add_executable(noveltea_text_tests
    text/text_engine_tests.cpp
)
target_include_directories(noveltea_text_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_text_tests PRIVATE NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_text_tests PRIVATE
    noveltea_engine
    noveltea_text_unibreak
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_text_tests)

# --- Asset tests (always built) ---

add_executable(noveltea_asset_tests
    surface_tests.cpp
    assets/asset_path_tests.cpp
    assets/asset_manager_tests.cpp
    assets/asset_reader_tests.cpp
    assets/memory_asset_source_tests.cpp
    assets/directory_asset_source_tests.cpp
)
target_link_libraries(noveltea_asset_tests PRIVATE noveltea_engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_asset_tests)

# --- Animation tests (Twink-backed service is mandatory) ---

add_executable(noveltea_tween_tests
    animation/tween_service_tests.cpp
)
target_link_libraries(noveltea_tween_tests PRIVATE noveltea_engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_tween_tests)

# --- Render backend integration tests (bgfx is mandatory) ---

add_executable(noveltea_render_backend_tests
    render/material_binder_tests.cpp
    render/shader_variant_tests.cpp
    render/world_presentation_tests.cpp
    render/world_transition_tests.cpp
)
target_include_directories(noveltea_render_backend_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_render_backend_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_render_backend_tests PRIVATE
    noveltea_engine
    bgfx::bgfx
    Catch2::Catch2WithMain
)
noveltea_attach_generated_shaders(noveltea_render_backend_tests)
catch_discover_tests(noveltea_render_backend_tests)

add_test(
    NAME noveltea_shader_verify
    COMMAND "${CMAKE_COMMAND}"
        "-DNOVELTEA_VERIFY_ONLY=ON"
        "-DNOVELTEA_SHADER_OUTPUT_ROOT=${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}"
        "-DNOVELTEA_SHADER_VARIANTS=${NOVELTEA_ACTIVE_SHADER_VARIANTS}"
        -P "${CMAKE_SOURCE_DIR}/cmake/CompileNovelTeaShaders.cmake"
)

# --- Engine UI tests without direct RmlUi backend API use ---

add_executable(noveltea_ui_tests
    ui/active_text_presenter_tests.cpp
    ui/active_text_layout_tests.cpp
    ui/active_text_playback_tests.cpp
    ui/active_text_tests.cpp
    ui/rmlui_advanced_gallery_asset_tests.cpp
    ui/rmlui_document_binder_tests.cpp
    ui/rmlui_event_disposition_tests.cpp
    ui/runtime_ui_binder_tests.cpp
    ui/rmlui_template_resolver_tests.cpp
    ui/title_layout_asset_tests.cpp
)
target_include_directories(noveltea_ui_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_compile_definitions(noveltea_ui_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
)
target_link_libraries(noveltea_ui_tests PRIVATE
    noveltea_engine
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_ui_tests)

# --- UI backend integration tests (direct RmlUi API use) ---

add_executable(noveltea_ui_backend_tests
    ui/rmlui_custom_components_tests.cpp
    ui/rmlui_file_interface_tests.cpp
    ui/rmlui_lifecycle_tests.cpp
    ui/runtime_ui_lifecycle_integration_tests.cpp
)
target_include_directories(noveltea_ui_backend_tests PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_compile_definitions(noveltea_ui_backend_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
)
target_link_libraries(noveltea_ui_backend_tests PRIVATE
    noveltea_engine
    RmlUi::RmlUi
    rmlui_bgfx::rmlui_bgfx
    Catch2::Catch2WithMain
)
catch_discover_tests(noveltea_ui_backend_tests)

# --- RmlUi readback capture/verify (requires sandbox target) ---

if(TARGET noveltea-sandbox)
    set(NOVELTEA_RMLUI_READBACK_PPM "${CMAKE_BINARY_DIR}/rmlui-readback-gallery.ppm")
    set(NOVELTEA_RMLUI_RESIZE_READBACK_PPM "${CMAKE_BINARY_DIR}/rmlui-readback-gallery-after-resize.ppm")
    set(NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM "${CMAKE_BINARY_DIR}/rmlui-feature-fixtures.ppm")
    set(NOVELTEA_PRESENTATION_READBACK_PPM "${CMAKE_BINARY_DIR}/presentation-readback.ppm")
    set(NOVELTEA_WORLD_PRESENTATION_READBACK_PPM
        "${CMAKE_BINARY_DIR}/world-presentation-readback.ppm")
    set(NOVELTEA_WORLD_TRANSITION_CUT_PPM
        "${CMAKE_BINARY_DIR}/world-transition-cut.ppm")
    set(NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM
        "${CMAKE_BINARY_DIR}/world-transition-fade-source.ppm")
    set(NOVELTEA_WORLD_TRANSITION_FADE_MIDPOINT_PPM
        "${CMAKE_BINARY_DIR}/world-transition-fade-midpoint.ppm")
    set(NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM
        "${CMAKE_BINARY_DIR}/world-transition-fade-target.ppm")
    set(NOVELTEA_WORLD_TRANSITION_DISSOLVE_PPM
        "${CMAKE_BINARY_DIR}/world-transition-dissolve.ppm")
    set(NOVELTEA_RMLUI_COMPAT_MARKER "${CMAKE_BINARY_DIR}/rmlui-base-direct-compat.enabled")
    add_executable(noveltea_rmlui_readback_verifier
        ui/rmlui_readback_verifier.cpp
    )
    target_compile_definitions(noveltea_rmlui_readback_verifier PRIVATE
        NOVELTEA_RMLUI_READBACK_PPM="${NOVELTEA_RMLUI_READBACK_PPM}"
    )
    target_link_libraries(noveltea_rmlui_readback_verifier PRIVATE Catch2::Catch2WithMain)
    add_executable(noveltea_rmlui_resize_readback_verifier
        ui/rmlui_readback_verifier.cpp
    )
    target_compile_definitions(noveltea_rmlui_resize_readback_verifier PRIVATE
        NOVELTEA_RMLUI_READBACK_PPM="${NOVELTEA_RMLUI_RESIZE_READBACK_PPM}"
    )
    target_link_libraries(noveltea_rmlui_resize_readback_verifier PRIVATE Catch2::Catch2WithMain)
    add_executable(noveltea_rmlui_feature_fixtures_verifier
        ui/rmlui_feature_fixtures_verifier.cpp
    )
    target_compile_definitions(noveltea_rmlui_feature_fixtures_verifier PRIVATE
        NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM="${NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM}"
    )
    target_link_libraries(noveltea_rmlui_feature_fixtures_verifier PRIVATE Catch2::Catch2WithMain)
    add_executable(noveltea_presentation_readback_verifier
        ui/presentation_readback_verifier.cpp
    )
    target_compile_definitions(noveltea_presentation_readback_verifier PRIVATE
        NOVELTEA_PRESENTATION_READBACK_PPM="${NOVELTEA_PRESENTATION_READBACK_PPM}"
    )
    target_link_libraries(noveltea_presentation_readback_verifier PRIVATE Catch2::Catch2WithMain)
    add_executable(noveltea_world_presentation_readback_verifier
        ui/world_presentation_readback_verifier.cpp
    )
    target_compile_definitions(noveltea_world_presentation_readback_verifier PRIVATE
        NOVELTEA_WORLD_PRESENTATION_READBACK_PPM="${NOVELTEA_WORLD_PRESENTATION_READBACK_PPM}"
    )
    target_link_libraries(noveltea_world_presentation_readback_verifier PRIVATE
        Catch2::Catch2WithMain)
    add_executable(noveltea_world_transition_readback_verifier
        ui/world_transition_readback_verifier.cpp
    )
    target_compile_definitions(noveltea_world_transition_readback_verifier PRIVATE
        NOVELTEA_WORLD_TRANSITION_CUT_PPM="${NOVELTEA_WORLD_TRANSITION_CUT_PPM}"
        NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM="${NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM}"
        NOVELTEA_WORLD_TRANSITION_FADE_MIDPOINT_PPM="${NOVELTEA_WORLD_TRANSITION_FADE_MIDPOINT_PPM}"
        NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM="${NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM}"
        NOVELTEA_WORLD_TRANSITION_DISSOLVE_PPM="${NOVELTEA_WORLD_TRANSITION_DISSOLVE_PPM}"
    )
    target_link_libraries(noveltea_world_transition_readback_verifier PRIVATE
        Catch2::Catch2WithMain)
    add_test(
        NAME noveltea_rmlui_readback_capture
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --rmlui-document project:/rmlui/readback_gallery.rml --frames 40 --screenshot '${NOVELTEA_RMLUI_READBACK_PPM}' --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --rmlui-document project:/rmlui/readback_gallery.rml --frames 40 --screenshot '${NOVELTEA_RMLUI_READBACK_PPM}' --no-imgui; fi"
    )
    set_tests_properties(noveltea_rmlui_readback_capture PROPERTIES
        LABELS "rmlui;gpu"
    )
    add_test(
        NAME noveltea_rmlui_readback_verify
        COMMAND noveltea_rmlui_readback_verifier
    )
    set_tests_properties(noveltea_rmlui_readback_verify PROPERTIES
        DEPENDS noveltea_rmlui_readback_capture
        LABELS "rmlui;gpu"
    )
    add_test(
        NAME noveltea_rmlui_feature_fixtures_capture
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --rmlui-document project:/rmlui/feature_fixtures.rml --frames 40 --screenshot '${NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM}' --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --rmlui-document project:/rmlui/feature_fixtures.rml --frames 40 --screenshot '${NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM}' --no-imgui; fi"
    )
    set_tests_properties(noveltea_rmlui_feature_fixtures_capture PROPERTIES
        LABELS "rmlui;gpu"
    )
    add_test(
        NAME noveltea_rmlui_feature_fixtures_verify
        COMMAND noveltea_rmlui_feature_fixtures_verifier
    )
    set_tests_properties(noveltea_rmlui_feature_fixtures_verify PROPERTIES
        DEPENDS noveltea_rmlui_feature_fixtures_capture
        LABELS "rmlui;gpu"
    )
    add_test(
        NAME noveltea_rmlui_resize_readback_capture
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --rmlui-document project:/rmlui/readback_gallery.rml --resize-sequence 1280x720,1423x1869,1280x720 --resize-interval-frames 2 --readback-after-resize-frames 3 --screenshot '${NOVELTEA_RMLUI_RESIZE_READBACK_PPM}' --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --rmlui-document project:/rmlui/readback_gallery.rml --resize-sequence 1280x720,1423x1869,1280x720 --resize-interval-frames 2 --readback-after-resize-frames 3 --screenshot '${NOVELTEA_RMLUI_RESIZE_READBACK_PPM}' --no-imgui; fi"
    )
    set_tests_properties(noveltea_rmlui_resize_readback_capture PROPERTIES
        LABELS "rmlui;gpu"
    )
    add_test(
        NAME noveltea_rmlui_resize_readback_verify
        COMMAND noveltea_rmlui_resize_readback_verifier
    )
    set_tests_properties(noveltea_rmlui_resize_readback_verify PROPERTIES
        DEPENDS noveltea_rmlui_resize_readback_capture
        LABELS "rmlui;gpu"
    )
    add_test(
        NAME noveltea_presentation_readback_capture
        COMMAND /bin/sh -c
            "exec '$<TARGET_FILE:noveltea-sandbox>' --window-size 1000x800 --demo none --rmlui-document project:/rmlui/readback_gallery.rml --frames 40 --screenshot '${NOVELTEA_PRESENTATION_READBACK_PPM}' --no-imgui"
    )
    set_tests_properties(noveltea_presentation_readback_capture PROPERTIES
        LABELS "rmlui;gpu;presentation"
    )
    add_test(
        NAME noveltea_presentation_readback_verify
        COMMAND noveltea_presentation_readback_verifier
    )
    set_tests_properties(noveltea_presentation_readback_verify PROPERTIES
        DEPENDS noveltea_presentation_readback_capture
        LABELS "rmlui;gpu;presentation"
    )
    add_test(
        NAME noveltea_world_presentation_readback_capture
        COMMAND /bin/sh -c
            "exec '$<TARGET_FILE:noveltea-sandbox>' --window-size 1280x720 --demo none --compiled-project project:/projects/runtime_phase9_package.ntpkg --skip-title-screen --frames 30 --screenshot '${NOVELTEA_WORLD_PRESENTATION_READBACK_PPM}' --no-imgui"
    )
    set_tests_properties(noveltea_world_presentation_readback_capture PROPERTIES
        LABELS "gpu;presentation;world"
    )
    add_test(
        NAME noveltea_world_presentation_readback_verify
        COMMAND noveltea_world_presentation_readback_verifier
    )
    set_tests_properties(noveltea_world_presentation_readback_verify PROPERTIES
        DEPENDS noveltea_world_presentation_readback_capture
        LABELS "gpu;presentation;world"
    )
    add_test(
        NAME noveltea_world_transition_readback_capture
        COMMAND /bin/sh -c
            "set -e; rm -f '${NOVELTEA_WORLD_TRANSITION_CUT_PPM}' '${NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM}' '${NOVELTEA_WORLD_TRANSITION_FADE_MIDPOINT_PPM}' '${NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM}' '${NOVELTEA_WORLD_TRANSITION_DISSOLVE_PPM}'; '$<TARGET_FILE:noveltea-sandbox>' --window-size 1280x720 --demo none --compiled-project project:/projects/runtime_transition_cut_readback.json --skip-title-screen --run-runtime --fixed-delta-ms 100 --frames 3 --screenshot '${NOVELTEA_WORLD_TRANSITION_CUT_PPM}' --no-imgui --no-audio; '$<TARGET_FILE:noveltea-sandbox>' --window-size 1280x720 --demo none --compiled-project project:/projects/runtime_transition_fade_readback.json --skip-title-screen --run-runtime --fixed-delta-ms 100 --frames 3 --screenshot '${NOVELTEA_WORLD_TRANSITION_FADE_SOURCE_PPM}' --no-imgui --no-audio; '$<TARGET_FILE:noveltea-sandbox>' --window-size 1280x720 --demo none --compiled-project project:/projects/runtime_transition_fade_readback.json --skip-title-screen --run-runtime --fixed-delta-ms 100 --frames 6 --screenshot '${NOVELTEA_WORLD_TRANSITION_FADE_MIDPOINT_PPM}' --no-imgui --no-audio; '$<TARGET_FILE:noveltea-sandbox>' --window-size 1280x720 --demo none --compiled-project project:/projects/runtime_transition_fade_readback.json --skip-title-screen --run-runtime --fixed-delta-ms 100 --frames 8 --screenshot '${NOVELTEA_WORLD_TRANSITION_FADE_TARGET_PPM}' --no-imgui --no-audio; '$<TARGET_FILE:noveltea-sandbox>' --window-size 1280x720 --demo none --compiled-project project:/projects/runtime_transition_dissolve_readback.json --skip-title-screen --run-runtime --fixed-delta-ms 100 --frames 6 --screenshot '${NOVELTEA_WORLD_TRANSITION_DISSOLVE_PPM}' --no-imgui --no-audio"
    )
    set_tests_properties(noveltea_world_transition_readback_capture PROPERTIES
        LABELS "gpu;presentation;world;transition;rmlui"
    )
    add_test(
        NAME noveltea_world_transition_readback_verify
        COMMAND noveltea_world_transition_readback_verifier
    )
    set_tests_properties(noveltea_world_transition_readback_verify PROPERTIES
        DEPENDS noveltea_world_transition_readback_capture
        LABELS "gpu;presentation;world;transition;rmlui"
    )
endif()

if(TARGET noveltea-player AND CMAKE_BUILD_TYPE STREQUAL "Debug" AND UNIX AND NOT APPLE)
    find_program(NOVELTEA_XVFB_RUN xvfb-run)
    set(NOVELTEA_PLAYER_SMOKE_PACKAGE
        "${CMAKE_BINARY_DIR}/runtime-assets/project/projects/runtime_phase9_package.ntpkg")
    add_test(
        NAME noveltea_player_runtime_compiled_package_smoke
        COMMAND "${CMAKE_COMMAND}"
            "-DPLAYER=$<TARGET_FILE:noveltea-player>"
            "-DPACKAGE=${NOVELTEA_PLAYER_SMOKE_PACKAGE}"
            "-DWORK_DIR=${CMAKE_BINARY_DIR}/player-runtime-smoke"
            "-DXVFB_RUN=${NOVELTEA_XVFB_RUN}"
            -P "${CMAKE_SOURCE_DIR}/tests/cmake/player_runtime_package_smoke.cmake"
    )
    set_tests_properties(noveltea_player_runtime_compiled_package_smoke PROPERTIES
        LABELS "runtime;assets;player"
        PASS_REGULAR_EXPRESSION "NOVELTEA_PLAYER_READY"
        REQUIRED_FILES "${NOVELTEA_PLAYER_SMOKE_PACKAGE}"
        TIMEOUT 45
    )
endif()

# Catch2 is rebuilt under the NovelTea dependency triplet. Its consumers must use the same compiler
# ABI policy or they will emit RTTI/exception references that the library intentionally does not
# provide.
foreach(_noveltea_test_target IN ITEMS
        noveltea_domain_tests
        noveltea_content_tests
        noveltea_runtime_tests
        noveltea_presentation_tests
        noveltea_script_lua_tests
        noveltea_host_tests
        noveltea_text_tests
        noveltea_asset_tests
        noveltea_tween_tests
        noveltea_render_backend_tests
        noveltea_ui_tests
        noveltea_ui_backend_tests
        noveltea_rmlui_patch_framework_test
        noveltea_rmlui_readback_verifier
        noveltea_rmlui_resize_readback_verifier
        noveltea_rmlui_feature_fixtures_verifier
        noveltea_presentation_readback_verifier
        noveltea_world_presentation_readback_verifier
        noveltea_world_transition_readback_verifier)
    if(TARGET "${_noveltea_test_target}")
        noveltea_apply_runtime_compiler_policy("${_noveltea_test_target}")
    endif()
endforeach()

if(EMSCRIPTEN)
    add_test(
        NAME noveltea_web_rmlui_smoke
        COMMAND node "${CMAKE_SOURCE_DIR}/scripts/web-smoke.mjs"
    )
    set_tests_properties(noveltea_web_rmlui_smoke PROPERTIES
        LABELS "rmlui;web;smoke"
    )
endif()

if(NOVELTEA_BUILD_FUZZERS)
    foreach(_noveltea_fuzz_kind IN ITEMS 1 2)
        if(_noveltea_fuzz_kind EQUAL 1)
            set(_noveltea_fuzz_name rich_text)
        else()
            set(_noveltea_fuzz_name runtime_user_settings)
        endif()
        set(_noveltea_fuzz_target "noveltea_fuzz_${_noveltea_fuzz_name}")
        add_executable("${_noveltea_fuzz_target}" fuzz/parser_fuzz.cpp)
        target_compile_definitions("${_noveltea_fuzz_target}" PRIVATE
            NOVELTEA_FUZZ_KIND=${_noveltea_fuzz_kind})
        target_link_libraries("${_noveltea_fuzz_target}" PRIVATE
            noveltea_domain
            noveltea_content
            nlohmann_json::nlohmann_json
        )
        target_compile_definitions("${_noveltea_fuzz_target}" PRIVATE
            ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
        noveltea_configure_fuzz_target("${_noveltea_fuzz_target}")
        if(NOT NOVELTEA_USE_LIBFUZZER)
            add_test(NAME "${_noveltea_fuzz_target}_smoke" COMMAND "${_noveltea_fuzz_target}")
            set_tests_properties("${_noveltea_fuzz_target}_smoke" PROPERTIES
                LABELS "robustness;fuzz-smoke")
        endif()
    endforeach()

    add_executable(noveltea_fuzz_compiled_project_decoder
        fuzz/compiled_project_decoder_fuzz.cpp)
    target_compile_definitions(noveltea_fuzz_compiled_project_decoder PRIVATE
        NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
    target_link_libraries(noveltea_fuzz_compiled_project_decoder PRIVATE
        noveltea_domain
        noveltea_content
        nlohmann_json::nlohmann_json
    )
    target_compile_definitions(noveltea_fuzz_compiled_project_decoder PRIVATE
        ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
    noveltea_configure_fuzz_target(noveltea_fuzz_compiled_project_decoder)
    if(NOT NOVELTEA_USE_LIBFUZZER)
        add_test(
            NAME noveltea_fuzz_compiled_project_decoder_smoke
            COMMAND noveltea_fuzz_compiled_project_decoder)
        set_tests_properties(noveltea_fuzz_compiled_project_decoder_smoke PROPERTIES
            LABELS "robustness;fuzz-smoke;compiled-project")
    endif()
endif()

# --- No committed shader headers check ---

add_test(
    NAME noveltea_no_committed_shader_headers
    COMMAND "${CMAKE_COMMAND}"
        "-DROOT=${CMAKE_SOURCE_DIR}"
        -P "${CMAKE_SOURCE_DIR}/tests/cmake/no_committed_shader_headers.cmake"
)

# --- Sandbox smoke tests ---

if(TARGET noveltea-sandbox)
    add_test(
        NAME noveltea_sandbox_runtime_compiled_package_smoke
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --compiled-project project:/projects/runtime_phase9_package.ntpkg --frames 5 --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --compiled-project project:/projects/runtime_phase9_package.ntpkg --frames 5 --no-imgui; fi"
    )
    set_tests_properties(noveltea_sandbox_runtime_compiled_package_smoke PROPERTIES
        LABELS "runtime;assets"
        PASS_REGULAR_EXPRESSION "\\[runtime_ui\\] loaded title document"
    )
    add_test(
        NAME noveltea_sandbox_runtime_compiled_package_repeat_smoke
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --compiled-project project:/projects/runtime_phase9_package.ntpkg --frames 5 --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --compiled-project project:/projects/runtime_phase9_package.ntpkg --frames 5 --no-imgui; fi"
    )
    set_tests_properties(noveltea_sandbox_runtime_compiled_package_repeat_smoke PROPERTIES
        LABELS "runtime;assets"
        PASS_REGULAR_EXPRESSION "\\[runtime_ui\\] loaded title document"
    )
endif()
