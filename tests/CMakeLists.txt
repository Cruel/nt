include(Catch)

# --- Core tests (always built) ---

add_executable(noveltea_core_tests
    core/compatibility_completion_tests.cpp
    core/cutscene_controller_tests.cpp
    core/dialogue_controller_tests.cpp
    core/editor_api_tests.cpp
    core/entity_ref_tests.cpp
    core/game_session_tests.cpp
    core/legacy_entity_schema_tests.cpp
    core/project_document_tests.cpp
    core/project_model_tests.cpp
    core/project_validator_tests.cpp
    core/rich_text_tests.cpp
    core/runtime_controller_tests.cpp
    core/runtime_events_tests.cpp
    core/runtime_session_host_tests.cpp
    core/runtime_ui_view_tests.cpp
    core/save_document_tests.cpp
)
target_link_libraries(noveltea_core_tests PRIVATE noveltea_core Catch2::Catch2WithMain)
target_link_libraries(noveltea_core_tests PRIVATE miniz::miniz)
catch_discover_tests(noveltea_core_tests)

add_test(
    NAME noveltea_editor_tool_malformed_json
    COMMAND /bin/sh -c "printf '{' | '$<TARGET_FILE:noveltea-editor-tool>' load-project || true"
)
set_tests_properties(noveltea_editor_tool_malformed_json PROPERTIES
    PASS_REGULAR_EXPRESSION "Malformed request JSON"
)

add_test(
    NAME noveltea_editor_tool_load_project
    COMMAND /bin/sh -c "printf '%s' '{\"source\":\"{\\\"objects\\\":{},\\\"verbs\\\":{},\\\"actions\\\":{},\\\"rooms\\\":{},\\\"maps\\\":{},\\\"dialogues\\\":{},\\\"cutscenes\\\":{},\\\"scripts\\\":{},\\\"entrypoint\\\":[3,\\\"missing\\\"]}\"}' | '$<TARGET_FILE:noveltea-editor-tool>' load-project"
)
set_tests_properties(noveltea_editor_tool_load_project PROPERTIES
    PASS_REGULAR_EXPRESSION "\"ok\""
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
    script/script_runtime_tests.cpp
    script/game_bindings_tests.cpp
    script/runtime_script_executor_tests.cpp
)
target_include_directories(noveltea_script_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_link_libraries(noveltea_script_tests PRIVATE engine Lua::Lua sol2::sol2 Catch2::Catch2WithMain)
catch_discover_tests(noveltea_script_tests)

# --- Render tests (bgfx is mandatory) ---

add_executable(noveltea_render_tests
    render/material_asset_tests.cpp
    render/shader_manifest_tests.cpp
    render/shader_variant_tests.cpp
)
target_include_directories(noveltea_render_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_link_libraries(noveltea_render_tests PRIVATE engine Catch2::Catch2WithMain)
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
    ui/active_text_tests.cpp
    ui/rmlui_advanced_gallery_asset_tests.cpp
    ui/rmlui_custom_components_tests.cpp
    ui/rmlui_document_binder_tests.cpp
    ui/rmlui_event_disposition_tests.cpp
    ui/rmlui_file_interface_tests.cpp
    ui/rmlui_layer_system_tests.cpp
    ui/rmlui_render_bounds_tests.cpp
    ui/rmlui_conservative_mask_bounds_tests.cpp
    ui/rmlui_render_planning_tests.cpp
    ui/rmlui_render_pass_scheduler_tests.cpp
    ui/rmlui_template_resolver_tests.cpp
)
target_include_directories(noveltea_ui_tests PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")
target_compile_definitions(noveltea_ui_tests PRIVATE NOVELTEA_SOURCE_DIR="${CMAKE_SOURCE_DIR}")
target_link_libraries(noveltea_ui_tests PRIVATE engine Catch2::Catch2WithMain)
catch_discover_tests(noveltea_ui_tests)

# --- RmlUi readback capture/verify (requires sandbox target) ---

if(TARGET noveltea-sandbox)
    set(NOVELTEA_RMLUI_READBACK_PPM "${CMAKE_BINARY_DIR}/rmlui-readback-gallery.ppm")
    set(NOVELTEA_RMLUI_RESIZE_READBACK_PPM "${CMAKE_BINARY_DIR}/rmlui-readback-gallery-after-resize.ppm")
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
        NAME noveltea_rmlui_resize_readback_capture
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --rmlui-document project:/rmlui/readback_gallery.rml --resize-sequence 1280x720,1423x1869,1280x720 --readback-after-resize-frames 3 --screenshot '${NOVELTEA_RMLUI_RESIZE_READBACK_PPM}' --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --rmlui-document project:/rmlui/readback_gallery.rml --resize-sequence 1280x720,1423x1869,1280x720 --readback-after-resize-frames 3 --screenshot '${NOVELTEA_RMLUI_RESIZE_READBACK_PPM}' --no-imgui; fi"
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
endif()

if(EMSCRIPTEN)
    add_test(
        NAME noveltea_web_rmlui_smoke
        COMMAND node "${CMAKE_SOURCE_DIR}/scripts/web-smoke.mjs"
    )
    set_tests_properties(noveltea_web_rmlui_smoke PROPERTIES
        LABELS "rmlui;web;smoke"
    )
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
        NAME noveltea_sandbox_runtime_legacy_package_smoke
        COMMAND /bin/sh -c
            "if [ -f '${NOVELTEA_RMLUI_COMPAT_MARKER}' ]; then exec '$<TARGET_FILE:noveltea-sandbox>' --rmlui-base-direct-compat --demo none --runtime-project project:/projects/runtime_phase9_package.ntpkg --frames 5 --no-imgui; else exec '$<TARGET_FILE:noveltea-sandbox>' --demo none --runtime-project project:/projects/runtime_phase9_package.ntpkg --frames 5 --no-imgui; fi"
    )
    set_tests_properties(noveltea_sandbox_runtime_legacy_package_smoke PROPERTIES
        LABELS "runtime;assets"
    )
endif()
