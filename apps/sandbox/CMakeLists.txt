set(NOVELTEA_SANDBOX_SOURCES
    main.cpp
    sandbox_app.cpp
    sandbox_demo_harness.cpp
)

if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    add_library(noveltea-sandbox SHARED ${NOVELTEA_SANDBOX_SOURCES})
else()
    add_executable(noveltea-sandbox ${NOVELTEA_SANDBOX_SOURCES})
endif()

if(NOT TARGET nlohmann_json::nlohmann_json)
    find_package(nlohmann_json CONFIG REQUIRED)
endif()
target_link_libraries(noveltea-sandbox PRIVATE
    noveltea_engine
    SDL3::SDL3
    bgfx::bgfx
    nlohmann_json::nlohmann_json
)
target_compile_definitions(noveltea-sandbox PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})
target_include_directories(noveltea-sandbox PRIVATE
    "${CMAKE_SOURCE_DIR}/engine/src"
)
noveltea_attach_runtime_assets(noveltea-sandbox)

set(NOVELTEA_SANDBOX_ASSETS "${CMAKE_SOURCE_DIR}/apps/sandbox/assets")
set(NOVELTEA_BUILD_ASSETS "${CMAKE_BINARY_DIR}/runtime-assets")
set(NOVELTEA_RUNTIME_ASSET_STAMP "${CMAKE_BINARY_DIR}/generated-assets/runtime-assets.stamp")

# Emscripten output settings
if(EMSCRIPTEN)
    set_target_properties(noveltea-sandbox PROPERTIES
        OUTPUT_NAME "index"
        SUFFIX ".html"
    )
    set(NOVELTEA_WEB_SHELL_FILE "${CMAKE_SOURCE_DIR}/web/shell.html" CACHE FILEPATH "HTML shell used by the Emscripten sandbox")
    set(SHELL_FILE "${NOVELTEA_WEB_SHELL_FILE}")
    set(PERSISTENT_FS_PRE_JS "${CMAKE_SOURCE_DIR}/web/persistent_fs_pre.js")
    set(PERSISTENT_FS_JS "${CMAKE_SOURCE_DIR}/web/persistent_fs.js")
    target_link_options(noveltea-sandbox PRIVATE
        -sUSE_WEBGL2=1
        -sALLOW_MEMORY_GROWTH=1
        -sEXIT_RUNTIME=0
        -sFORCE_FILESYSTEM=1
        -sEXPORTED_FUNCTIONS=['_main','_noveltea_preview_set_demo_position','_noveltea_preview_reset_demo','_noveltea_preview_set_running','_noveltea_engine_set_show_fps_counter','_noveltea_engine_set_fps_cap','_noveltea_preview_load_rml_document','_noveltea_preview_execute_lua_script','_noveltea_preview_show_editor_document','_noveltea_runtime_load_project','_noveltea_runtime_reset','_noveltea_runtime_start','_noveltea_runtime_stop','_noveltea_runtime_step','_noveltea_runtime_continue','_noveltea_runtime_dialogue_option','_noveltea_runtime_navigate','_noveltea_runtime_select_subjects','_noveltea_runtime_clear_subject_selection','_noveltea_runtime_run_interaction','_noveltea_runtime_set_variable','_noveltea_runtime_reset_variable','_noveltea_runtime_give_object','_noveltea_runtime_remove_inventory_object','_noveltea_runtime_teleport_room','_noveltea_runtime_debug_snapshot','_noveltea_runtime_fast_forward_to_input','_noveltea_preview_resize','_noveltea_audio_play_sfx','_noveltea_audio_play_track','_noveltea_audio_stop_track']
        -sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','FS']
        -lidbfs.js
        --shell-file "${SHELL_FILE}"
        "SHELL:--pre-js ${PERSISTENT_FS_PRE_JS}"
        --js-library "${PERSISTENT_FS_JS}"
        "SHELL:--preload-file ${NOVELTEA_BUILD_ASSETS}@/assets"
    )
    if(NOVELTEA_WEB_THREADS)
        set(THREADING_PRE_JS "${CMAKE_SOURCE_DIR}/web/threading_pre.js")
        target_link_options(noveltea-sandbox PRIVATE
            "SHELL:--pre-js ${THREADING_PRE_JS}"
        )
        set_property(TARGET noveltea-sandbox APPEND PROPERTY
            LINK_DEPENDS "${THREADING_PRE_JS}")
    endif()
    # Force re-link when web shell files or staged assets change.
    set_property(TARGET noveltea-sandbox APPEND PROPERTY
        LINK_DEPENDS "${SHELL_FILE};${PERSISTENT_FS_PRE_JS};${PERSISTENT_FS_JS};${NOVELTEA_RUNTIME_ASSET_STAMP}"
    )
    if(CMAKE_BUILD_TYPE STREQUAL "MinSizeRel" OR CMAKE_BUILD_TYPE STREQUAL "Release")
        target_compile_options(noveltea-sandbox PRIVATE -flto)
        target_link_options(noveltea-sandbox PRIVATE -flto)
    endif()
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-sandbox PRIVATE
        -Wall -Wextra -Wpedantic
    )
endif()
noveltea_apply_runtime_compiler_policy(noveltea-sandbox)
noveltea_apply_policy_warnings(noveltea-sandbox)
