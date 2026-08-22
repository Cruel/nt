if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "noveltea-editor-preview is Web-only")
endif()

add_executable(noveltea-editor-preview
    main.cpp
    editor_preview_app.cpp
)

target_link_libraries(noveltea-editor-preview PRIVATE
    noveltea_engine
    SDL3::SDL3
    bgfx::bgfx
    nlohmann_json::nlohmann_json
)

target_compile_definitions(noveltea-editor-preview PRIVATE
    ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS}
    NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=${NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER_VALUE}
)
target_include_directories(noveltea-editor-preview PRIVATE "${CMAKE_SOURCE_DIR}/engine/src")

noveltea_attach_runtime_assets(noveltea-editor-preview)

set_target_properties(noveltea-editor-preview PROPERTIES
    OUTPUT_NAME "index"
    SUFFIX ".html"
)

set(NOVELTEA_EDITOR_PREVIEW_EXPORTED_FUNCTIONS
    "['_main','_noveltea_preview_set_running','_noveltea_preview_set_host_active','_noveltea_preview_active_shader_variant','_noveltea_preview_host_generation','_noveltea_engine_set_show_fps_counter','_noveltea_engine_set_fps_cap','_noveltea_engine_set_rmlui_raster_snapping','_noveltea_preview_load_rml_document','_noveltea_preview_execute_lua_script','_noveltea_preview_apply_editor_document','_noveltea_runtime_load_project','_noveltea_runtime_reset','_noveltea_runtime_start','_noveltea_runtime_stop','_noveltea_runtime_step','_noveltea_runtime_continue','_noveltea_runtime_dialogue_option','_noveltea_runtime_navigate','_noveltea_runtime_select_subjects','_noveltea_runtime_clear_subject_selection','_noveltea_runtime_run_interaction','_noveltea_runtime_set_variable','_noveltea_runtime_reset_variable','_noveltea_runtime_teleport_room','_noveltea_runtime_create_instance','_noveltea_runtime_replace_instance_configuration','_noveltea_runtime_clear_instance_configuration','_noveltea_runtime_destroy_instance','_noveltea_runtime_retarget_room_exit','_noveltea_runtime_debug_snapshot','_noveltea_runtime_fast_forward_to_input','_noveltea_preview_resize','_noveltea_preview_backbuffer_width','_noveltea_preview_backbuffer_height','_noveltea_audio_play_sfx','_noveltea_audio_play_track','_noveltea_audio_stop_track']")
if(NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER)
    string(REGEX REPLACE "\\]$"
        ",'_noveltea_asset_profiler_snapshot','_noveltea_asset_profiler_delta']"
        NOVELTEA_EDITOR_PREVIEW_EXPORTED_FUNCTIONS "${NOVELTEA_EDITOR_PREVIEW_EXPORTED_FUNCTIONS}")
endif()

target_link_options(noveltea-editor-preview PRIVATE
    -sUSE_WEBGL2=1
    -sALLOW_MEMORY_GROWTH=1
    -sEXIT_RUNTIME=0
    -sFORCE_FILESYSTEM=1
    -sMODULARIZE=0
    -sEXPORTED_RUNTIME_METHODS=['FS','ccall']
    "-sEXPORTED_FUNCTIONS=${NOVELTEA_EDITOR_PREVIEW_EXPORTED_FUNCTIONS}"
    --shell-file "${CMAKE_SOURCE_DIR}/web/widget.html"
    "SHELL:--js-library ${CMAKE_SOURCE_DIR}/web/persistent_fs.js"
    "SHELL:--preload-file ${CMAKE_BINARY_DIR}/runtime-assets@/assets"
)

if(NOVELTEA_ENABLE_THREADS)
    target_link_options(noveltea-editor-preview PRIVATE
        "SHELL:--pre-js ${CMAKE_SOURCE_DIR}/web/threading_pre.js")
    set_property(TARGET noveltea-editor-preview APPEND PROPERTY
        LINK_DEPENDS "${CMAKE_SOURCE_DIR}/web/threading_pre.js")
endif()

set_property(TARGET noveltea-editor-preview APPEND PROPERTY
    LINK_DEPENDS
        "${CMAKE_SOURCE_DIR}/web/widget.html;${CMAKE_SOURCE_DIR}/web/persistent_fs.js;${NOVELTEA_RUNTIME_ASSET_STAMP}")

if(CMAKE_BUILD_TYPE STREQUAL "MinSizeRel" OR CMAKE_BUILD_TYPE STREQUAL "Release")
    target_compile_options(noveltea-editor-preview PRIVATE -flto)
    target_link_options(noveltea-editor-preview PRIVATE -flto)
endif()

noveltea_apply_runtime_compiler_policy(noveltea-editor-preview)
noveltea_apply_policy_warnings(noveltea-editor-preview)
