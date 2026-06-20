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
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -E tar
            cf "${_tmp}/project/projects/runtime_phase9_package.ntpkg"
            --format=zip
            game
            image
            fonts/package.ttf
            textures/package.txt
            scripts/bootstrap.lua
            text/intro.txt
        WORKING_DIRECTORY "${_legacy_package_source}"
        RESULT_VARIABLE _legacy_package_result
    )
    if(NOT _legacy_package_result EQUAL 0)
        message(FATAL_ERROR "Failed to generate runtime_phase9_package.ntpkg")
    endif()
endif()
file(REMOVE_RECURSE "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(RENAME "${_tmp}" "${NOVELTEA_RUNTIME_ASSET_ROOT}")
file(WRITE "${NOVELTEA_STAGE_STAMP}" "staged\n")
