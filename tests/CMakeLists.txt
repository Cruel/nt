include(Catch)

# Tests that construct JSON wire fixtures are explicit boundary consumers.
find_package(nlohmann_json CONFIG REQUIRED)

# --- Core tests (always built) ---

add_executable(noveltea_core_tests
    core/compiled_package_tests.cpp
    core/compiled_project_model_tests.cpp
    core/compiled_project_wire_tests.cpp
    core/presentation_checkpoint_contracts_tests.cpp
    core/presentation_coordinator_tests.cpp
    core/editor_runtime_protocol_tests.cpp
    core/flow_executor_tests.cpp
    core/gameplay_pause_tests.cpp
    core/json_access_tests.cpp
    core/player_bootstrap_tests.cpp
    core/result_tests.cpp
    core/rich_text_tests.cpp
    core/runtime_value_tests.cpp
    core/runtime_domain_types_tests.cpp
    core/runtime_presentation_tests.cpp
    core/runtime_clock_tests.cpp
    core/runtime_user_settings_tests.cpp
    core/save_state_tests.cpp
    core/typed_save_slot_store_tests.cpp
    core/session_state_tests.cpp
    core/shared_evaluator_tests.cpp
    runtime/runtime_contracts_tests.cpp
)
target_include_directories(noveltea_core_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_core_tests PRIVATE NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_core_tests PRIVATE
    noveltea_core
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
target_compile_definitions(noveltea_core_tests PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
target_link_libraries(noveltea_core_tests PRIVATE miniz::miniz)
catch_discover_tests(noveltea_core_tests)

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
    engine
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
target_link_libraries(noveltea_asset_tests PRIVATE engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_asset_tests)

# --- Tween tests (always built) ---

add_executable(noveltea_tween_tests
    tween/tween_service_tests.cpp
)
target_link_libraries(noveltea_tween_tests PRIVATE engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_tween_tests)

# --- Script tests (Lua is mandatory) ---

add_executable(noveltea_script_tests
    script/compiled_runtime_tests.cpp
    script/runtime_audio_adapter_tests.cpp
    script/script_runtime_tests.cpp
    script/typed_dialogue_execution_tests.cpp
    script/typed_interaction_execution_tests.cpp
    script/typed_map_execution_tests.cpp
    script/typed_execution_kernel_tests.cpp
    script/runtime_checkpoint_service_tests.cpp
    script/typed_room_execution_tests.cpp
    script/typed_runtime_session_tests.cpp
)
target_include_directories(noveltea_script_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_script_tests PRIVATE
    NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}"
    SOL_NO_EXCEPTIONS=1
    SOL_NO_RTTI=1
    SOL_ALL_SAFETIES_ON=1
)
target_link_libraries(noveltea_script_tests PRIVATE
    engine
    Lua::Lua
    sol2::sol2
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
target_compile_definitions(noveltea_script_tests PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
catch_discover_tests(noveltea_script_tests)

# --- Render tests (bgfx is mandatory) ---

add_executable(noveltea_render_tests
    render/material_asset_tests.cpp
    render/material_binder_tests.cpp
    render/shader_compiler_tests.cpp
    render/shader_package_export_tests.cpp
    render/shader_manifest_tests.cpp
    render/shader_variant_tests.cpp
)
target_include_directories(noveltea_render_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_render_tests PRIVATE NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_render_tests PRIVATE
    engine
    miniz::miniz
    nlohmann_json::nlohmann_json
    Catch2::Catch2WithMain
)
target_compile_definitions(noveltea_render_tests PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
catch_discover_tests(noveltea_render_tests)

add_test(
    NAME noveltea_shader_verify
    COMMAND "${CMAKE_COMMAND}"
        "-DNOVELTEA_VERIFY_ONLY=ON"
        "-DNOVELTEA_SHADER_OUTPUT_ROOT=${NOVELTEA_ACTIVE_SHADER_ASSET_ROOT}"
        "-DNOVELTEA_SHADER_VARIANTS=${NOVELTEA_ACTIVE_SHADER_VARIANTS}"
        -P "${CMAKE_SOURCE_DIR}/cmake/CompileNovelTeaShaders.cmake"
)

# --- UI tests (RmlUi is mandatory) ---

add_executable(noveltea_ui_tests
    ui/active_text_layout_tests.cpp
    ui/active_text_playback_tests.cpp
    ui/active_text_tests.cpp
    ui/rmlui_advanced_gallery_asset_tests.cpp
    ui/rmlui_custom_components_tests.cpp
    ui/rmlui_document_binder_tests.cpp
    ui/rmlui_event_disposition_tests.cpp
    ui/rmlui_file_interface_tests.cpp
    ui/rmlui_lifecycle_tests.cpp
    ui/runtime_ui_lifecycle_integration_tests.cpp
    ui/runtime_layout_manager_tests.cpp
    ui/rmlui_template_resolver_tests.cpp
    ui/title_layout_asset_tests.cpp
)
target_include_directories(noveltea_ui_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_ui_tests PRIVATE NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_ui_tests PRIVATE engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_ui_tests)

# --- RmlUi readback capture/verify (requires sandbox target) ---

if(TARGET noveltea-sandbox)
    set(NOVELTEA_RMLUI_READBACK_PPM "${CMAKE_BINARY_DIR}/rmlui-readback-gallery.ppm")
    set(NOVELTEA_RMLUI_RESIZE_READBACK_PPM "${CMAKE_BINARY_DIR}/rmlui-readback-gallery-after-resize.ppm")
    set(NOVELTEA_RMLUI_FEATURE_FIXTURES_PPM "${CMAKE_BINARY_DIR}/rmlui-feature-fixtures.ppm")
    set(NOVELTEA_PRESENTATION_READBACK_PPM "${CMAKE_BINARY_DIR}/presentation-readback.ppm")
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
endif()

# Catch2 is rebuilt under the NovelTea dependency triplet. Its consumers must use the same compiler
# ABI policy or they will emit RTTI/exception references that the library intentionally does not
# provide.
foreach(_noveltea_test_target IN ITEMS
        noveltea_core_tests
        noveltea_text_tests
        noveltea_asset_tests
        noveltea_tween_tests
        noveltea_script_tests
        noveltea_render_tests
        noveltea_ui_tests
        noveltea_rmlui_readback_verifier
        noveltea_rmlui_resize_readback_verifier
        noveltea_rmlui_feature_fixtures_verifier
        noveltea_presentation_readback_verifier)
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
            noveltea_core
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
        noveltea_core
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
