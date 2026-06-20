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

file(COPY "${NOVELTEA_SHADER_ASSET_SOURCE}/shaders" DESTINATION "${_tmp}/system")
set(_legacy_package_source "${NOVELTEA_PROJECT_ASSET_SOURCE}/projects/runtime_phase9_package")
if(EXISTS "${_legacy_package_source}/game")
    set(_legacy_package_tmp "${_tmp}/runtime_phase9_package_export")
    file(REMOVE_RECURSE "${_legacy_package_tmp}")
    file(MAKE_DIRECTORY "${_legacy_package_tmp}")
    file(COPY "${_legacy_package_source}/" DESTINATION "${_legacy_package_tmp}")
    if(EXISTS "${NOVELTEA_SHADER_ASSET_SOURCE}/shaders")
        file(COPY "${NOVELTEA_SHADER_ASSET_SOURCE}/shaders" DESTINATION "${_legacy_package_tmp}")
    else()
        message(FATAL_ERROR "Missing shader asset tree for runtime package export: ${NOVELTEA_SHADER_ASSET_SOURCE}/shaders")
    endif()

    file(GLOB_RECURSE _legacy_package_files RELATIVE "${_legacy_package_tmp}" "${_legacy_package_tmp}/*")
    list(SORT _legacy_package_files)
    set(_legacy_package_entries_json "")
    set(_legacy_package_shader_variants_json "")
    set(_legacy_package_entry_separator "")
    set(_legacy_package_variant_separator "")
    foreach(_entry IN LISTS _legacy_package_files)
        if(NOT IS_DIRECTORY "${_legacy_package_tmp}/${_entry}")
            string(APPEND _legacy_package_entries_json "${_legacy_package_entry_separator}    { \"path\": \"${_entry}\" }")
            set(_legacy_package_entry_separator ",\n")
        endif()
    endforeach()
    file(GLOB _legacy_package_shader_variant_dirs LIST_DIRECTORIES true
         "${_legacy_package_tmp}/shaders/bgfx/*")
    foreach(_variant_dir IN LISTS _legacy_package_shader_variant_dirs)
        if(IS_DIRECTORY "${_variant_dir}")
            get_filename_component(_variant "${_variant_dir}" NAME)
            string(APPEND _legacy_package_shader_variants_json "${_legacy_package_variant_separator}    \"${_variant}\"")
            set(_legacy_package_variant_separator ",\n")
        endif()
    endforeach()
    file(WRITE "${_legacy_package_tmp}/manifest.json"
"{
  \"format\": \"noveltea.runtime-package\",
  \"format_version\": 1,
  \"kind\": \"runtime\",
  \"created_by\": \"StageNovelTeaAssets.cmake\",
  \"project\": {
    \"name\": \"runtime_phase9_package\",
    \"version\": \"1.0\"
  },
  \"shader_variants\": [
${_legacy_package_shader_variants_json}
  ],
  \"entries\": [
${_legacy_package_entries_json}${_legacy_package_entry_separator}    { \"path\": \"manifest.json\" }
  ],
  \"checksums\": {}
}
")
    file(GLOB_RECURSE _legacy_package_files RELATIVE "${_legacy_package_tmp}" "${_legacy_package_tmp}/*")
    list(SORT _legacy_package_files)
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -E tar
            cf "${_tmp}/project/projects/runtime_phase9_package.ntpkg"
            --format=zip
            ${_legacy_package_files}
        WORKING_DIRECTORY "${_legacy_package_tmp}"
        RESULT_VARIABLE _legacy_package_result
    )
    if(NOT _legacy_package_result EQUAL 0)
        message(FATAL_ERROR "Failed to generate runtime_phase9_package.ntpkg")
    endif()
    file(REMOVE_RECURSE "${_legacy_package_tmp}")
endif()
file(REMOVE_RECURSE "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(RENAME "${_tmp}" "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(WRITE "${NOVELTEA_STAGE_STAMP}" "staged\n")
