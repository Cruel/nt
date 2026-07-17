if(NOT NOVELTEA_PROJECT_ASSET_SOURCE OR NOT NOVELTEA_SHADER_ASSET_SOURCE OR NOT NOVELTEA_RUNTIME_ASSET_ROOT)
    message(FATAL_ERROR "Project source, shader source, and runtime asset root are required")
endif()

set(_tmp "${NOVELTEA_RUNTIME_ASSET_ROOT}.tmp")
file(REMOVE_RECURSE "${_tmp}")
file(MAKE_DIRECTORY "${_tmp}")
file(MAKE_DIRECTORY "${_tmp}/project" "${_tmp}/system")
file(COPY "${NOVELTEA_PROJECT_ASSET_SOURCE}/" DESTINATION "${_tmp}/project")

cmake_path(SET NOVELTEA_ENGINE_ASSET_SOURCE NORMALIZE
           "${CMAKE_CURRENT_LIST_DIR}/../engine/assets/system")
if(EXISTS "${NOVELTEA_ENGINE_ASSET_SOURCE}")
    file(COPY "${NOVELTEA_ENGINE_ASSET_SOURCE}/" DESTINATION "${_tmp}/system")
endif()

set(_system_font_source "${NOVELTEA_PROJECT_ASSET_SOURCE}/rmlui/LiberationSans.ttf")
if(NOT EXISTS "${_system_font_source}")
    message(FATAL_ERROR "Missing required NovelTea system font: ${_system_font_source}")
endif()
file(MAKE_DIRECTORY "${_tmp}/system/fonts")
file(COPY_FILE "${_system_font_source}" "${_tmp}/system/fonts/LiberationSans.ttf")

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
        elseif(_transition_kind STREQUAL "fade")
            set(_transition_duration 1000)
            set(_transition_color "\"#000000\"")
            set(_transition_wait "false")
        else()
            set(_transition_duration 1000)
            set(_transition_color "null")
            set(_transition_wait "false")
        endif()
        string(REPLACE "@DURATION_MS@" "${_transition_duration}" _transition_document
                       "${_transition_document}")
        string(REPLACE "@TRANSITION_COLOR@" "${_transition_color}" _transition_document
                       "${_transition_document}")
        string(REPLACE "@WAIT_FOR_COMPLETION@" "${_transition_wait}" _transition_document
                       "${_transition_document}")
        file(WRITE
            "${_tmp}/project/projects/runtime_transition_${_transition_kind}_readback.json"
            "${_transition_document}")
    endforeach()
    file(REMOVE "${_tmp}/project/projects/runtime_transition_readback.template.json")
endif()

set(_compiled_package_source "${NOVELTEA_PROJECT_ASSET_SOURCE}/projects/runtime_phase9_package")
if(EXISTS "${_compiled_package_source}/game")
    set(_compiled_package_tmp "${_tmp}/runtime_phase9_package_export")
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
  \"format_version\": 1,
  \"kind\": \"runtime\",
  \"created_by\": \"StageNovelTeaAssets.cmake\",
  \"project\": {
    \"name\": \"Golden Minimal\",
    \"version\": \"0.1.0\"
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
            cf "${_tmp}/project/projects/runtime_phase9_package.ntpkg"
            --format=zip
            ${_compiled_package_files}
        WORKING_DIRECTORY "${_compiled_package_tmp}"
        RESULT_VARIABLE _compiled_package_result
    )
    if(NOT _compiled_package_result EQUAL 0)
        message(FATAL_ERROR "Failed to generate runtime_phase9_package.ntpkg")
    endif()
    file(REMOVE_RECURSE "${_compiled_package_tmp}")
endif()
file(REMOVE_RECURSE "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(RENAME "${_tmp}" "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(WRITE "${NOVELTEA_STAGE_STAMP}" "staged\n")
