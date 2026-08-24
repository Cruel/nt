if(NOT NOVELTEA_SHADER_ASSET_SOURCE OR NOT NOVELTEA_RUNTIME_ASSET_ROOT)
    message(FATAL_ERROR "Shader source and runtime asset root are required")
endif()

set(_tmp "${NOVELTEA_RUNTIME_ASSET_ROOT}.tmp")
file(REMOVE_RECURSE "${_tmp}")
file(MAKE_DIRECTORY "${_tmp}")
file(MAKE_DIRECTORY "${_tmp}/project" "${_tmp}/system")
if(NOVELTEA_PROJECT_ASSET_SOURCE)
    file(COPY "${NOVELTEA_PROJECT_ASSET_SOURCE}/" DESTINATION "${_tmp}/project")
endif()

cmake_path(SET NOVELTEA_ENGINE_ASSET_SOURCE NORMALIZE
           "${CMAKE_CURRENT_LIST_DIR}/../engine/assets/system")
if(EXISTS "${NOVELTEA_ENGINE_ASSET_SOURCE}")
    file(COPY "${NOVELTEA_ENGINE_ASSET_SOURCE}/" DESTINATION "${_tmp}/system")
endif()

set(_system_font_source "${NOVELTEA_ENGINE_ASSET_SOURCE}/fonts/LiberationSans.ttf")
if(NOT EXISTS "${_system_font_source}")
    message(FATAL_ERROR "Missing required NovelTea system font: ${_system_font_source}")
endif()
file(COPY "${NOVELTEA_SHADER_ASSET_SOURCE}/shaders" DESTINATION "${_tmp}/system")

set(_transition_template
    "${NOVELTEA_PROJECT_ASSET_SOURCE}/projects/runtime_transition_readback.template.json")
if(EXISTS "${_transition_template}")
    file(READ "${_transition_template}" _transition_source)
    foreach(_transition_kind IN ITEMS cut fade dissolve)
        set(_transition_document "${_transition_source}")
        string(REPLACE "@TRANSITION_KIND@" "${_transition_kind}" _transition_document
                       "${_transition_document}")
        if(_transition_kind STREQUAL "cut")
            set(_transition_duration 0)
            set(_transition_color "null")
            set(_transition_wait "false")
            set(_transition_save_contract "sc1:b05daad5948abd6f94664e05276fa363")
        elseif(_transition_kind STREQUAL "fade")
            set(_transition_duration 1000)
            set(_transition_color "\"#000000\"")
            set(_transition_wait "false")
            set(_transition_save_contract "sc1:f82683c4325129723fdfded4404eb006")
        else()
            set(_transition_duration 1000)
            set(_transition_color "null")
            set(_transition_wait "false")
            set(_transition_save_contract "sc1:d8e7982d4e18e4c33404c15d41a7ee0f")
        endif()
        string(REPLACE "@DURATION_MS@" "${_transition_duration}" _transition_document
                       "${_transition_document}")
        string(REPLACE "@TRANSITION_COLOR@" "${_transition_color}" _transition_document
                       "${_transition_document}")
        string(REPLACE "@WAIT_FOR_COMPLETION@" "${_transition_wait}" _transition_document
                       "${_transition_document}")
        string(REPLACE "@SAVE_CONTRACT@" "${_transition_save_contract}" _transition_document
                       "${_transition_document}")
        file(WRITE
            "${_tmp}/project/projects/runtime_transition_${_transition_kind}_readback.json"
            "${_transition_document}")
    endforeach()
    file(REMOVE "${_tmp}/project/projects/runtime_transition_readback.template.json")
endif()

set(_compiled_package_source "${NOVELTEA_PROJECT_ASSET_SOURCE}/projects/runtime_presentation_package")
if(EXISTS "${_compiled_package_source}/game")
    set(_compiled_package_tmp "${_tmp}/runtime_presentation_package_export")
    file(REMOVE_RECURSE "${_compiled_package_tmp}")
    file(MAKE_DIRECTORY "${_compiled_package_tmp}")
    file(COPY "${_compiled_package_source}/" DESTINATION "${_compiled_package_tmp}")
    file(COPY_FILE
        "${CMAKE_CURRENT_LIST_DIR}/../editor/src/renderer/test/fixtures/compiled-project-golden/minimal.json"
        "${_compiled_package_tmp}/game")
    file(READ "${_compiled_package_tmp}/game" _compiled_demo_game)
    string(REPLACE
        "\"assets\":[]"
        "\"assets\":[{\"aliases\":[],\"id\":\"demo-notification\",\"kind\":\"audio\",\"path\":\"audio/notification.mp3\"}]"
        _compiled_demo_game
        "${_compiled_demo_game}")
    string(REPLACE
        "\"background\":{\"asset\":null,\"color\":null,\"fit\":\"cover\",\"material\":null}"
        "\"background\":{\"asset\":null,\"color\":\"#204060\",\"fit\":\"cover\",\"material\":null}"
        _compiled_demo_game
        "${_compiled_demo_game}")
    string(REPLACE
        "\"saveContract\":\"sc1:3a00b6888fd0dc16349f15985ba1cbea\""
        "\"saveContract\":\"sc1:92ae23f3684d8ccda09c0da3fe01e7b1\""
        _compiled_demo_game
        "${_compiled_demo_game}")
    file(WRITE "${_compiled_package_tmp}/game" "${_compiled_demo_game}")
    file(MAKE_DIRECTORY "${_compiled_package_tmp}/audio")
    file(COPY_FILE
        "${NOVELTEA_PROJECT_ASSET_SOURCE}/audio/notification.mp3"
        "${_compiled_package_tmp}/audio/notification.mp3")
    file(REMOVE "${_compiled_package_tmp}/shader-materials.json")

    file(GLOB_RECURSE _compiled_package_files RELATIVE "${_compiled_package_tmp}" "${_compiled_package_tmp}/*")
    list(SORT _compiled_package_files)
    set(_compiled_package_entries_json "")
    set(_compiled_package_shader_variants_json "")
    set(_compiled_package_entry_separator "")
    set(_compiled_package_variant_separator "")
    foreach(_entry IN LISTS _compiled_package_files)
        if(NOT IS_DIRECTORY "${_compiled_package_tmp}/${_entry}")
            file(SIZE "${_compiled_package_tmp}/${_entry}" _entry_size)
            string(APPEND _compiled_package_entries_json "${_compiled_package_entry_separator}    { \"path\": \"${_entry}\", \"size\": ${_entry_size} }")
            set(_compiled_package_entry_separator ",\n")
        endif()
    endforeach()
    file(WRITE "${_compiled_package_tmp}/manifest.json"
"{
  \"format\": \"noveltea.runtime-package\",
  \"runtime_api_version\": 1,
  \"kind\": \"runtime\",
  \"created_by\": \"StageNovelTeaAssets.cmake\",
  \"project\": {
    \"name\": \"Golden Minimal\",
    \"version\": \"0.1.0\"
  },
  \"display\": {
    \"reference_resolution\": { \"width\": 1920, \"height\": 1080 },
    \"world_raster_policy\": \"capped\",
    \"bar_color\": \"#000000\"
  },
  \"accessibility\": {
    \"ui_scale\": { \"enabled\": true, \"minimum\": 1, \"maximum\": 2 },
    \"text_scale\": { \"enabled\": true, \"minimum\": 1, \"maximum\": 2 }
  },
  \"shader_variants\": [
${_compiled_package_shader_variants_json}
  ],
  \"entries\": [
${_compiled_package_entries_json}
  ],
  \"checksums\": {}
}
")
    file(GLOB_RECURSE _compiled_package_files RELATIVE "${_compiled_package_tmp}" "${_compiled_package_tmp}/*")
    list(SORT _compiled_package_files)
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -E tar
            cf "${_tmp}/project/projects/runtime_presentation_package.ntpkg"
            --format=zip
            ${_compiled_package_files}
        WORKING_DIRECTORY "${_compiled_package_tmp}"
        RESULT_VARIABLE _compiled_package_result
    )
    if(NOT _compiled_package_result EQUAL 0)
        message(FATAL_ERROR "Failed to generate runtime_presentation_package.ntpkg")
    endif()
    file(REMOVE_RECURSE "${_compiled_package_tmp}")
endif()
file(REMOVE_RECURSE "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(RENAME "${_tmp}" "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(WRITE "${NOVELTEA_STAGE_STAMP}" "staged\n")
