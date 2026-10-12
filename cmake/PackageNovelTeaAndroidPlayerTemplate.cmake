cmake_minimum_required(VERSION 3.25)
foreach(required NOVELTEA_RELEASE_TAG NOVELTEA_ANDROID_ABI NOVELTEA_ANDROID_FLAVOR NOVELTEA_BUNDLETOOL_JAR)
    if(NOT DEFINED ${required})
        message(FATAL_ERROR "${required} is required")
    endif()
endforeach()
set(root "${CMAKE_CURRENT_LIST_DIR}/..")
cmake_path(ABSOLUTE_PATH root NORMALIZE OUTPUT_VARIABLE root)
include("${root}/cmake/NovelTeaBgfxVersion.cmake")
find_program(NODE_EXECUTABLE node REQUIRED)
set(template_id "android-${NOVELTEA_ANDROID_ABI}-${NOVELTEA_ANDROID_FLAVOR}")
set(stage "${root}/build/package/${template_id}")
execute_process(COMMAND "${NODE_EXECUTABLE}" "${root}/cmake/package-android-player-template.mjs"
    "${root}" "${stage}" "${NOVELTEA_RELEASE_TAG}" "${NOVELTEA_ANDROID_ABI}"
    "${NOVELTEA_ANDROID_FLAVOR}" "${NOVELTEA_BUNDLETOOL_JAR}" "${NOVELTEA_BGFX_VERSION}"
    OUTPUT_VARIABLE package_result
    COMMAND_ERROR_IS_FATAL ANY)
file(MAKE_DIRECTORY "${root}/dist")
if(WIN32)
    set(extension zip)
    execute_process(COMMAND "${CMAKE_COMMAND}" -E tar cf
        "${root}/dist/noveltea-player-template-${NOVELTEA_RELEASE_TAG}-${template_id}.${extension}"
        --format=zip "${template_id}" WORKING_DIRECTORY "${root}/build/package" COMMAND_ERROR_IS_FATAL ANY)
else()
    set(extension tar.gz)
    execute_process(COMMAND "${CMAKE_COMMAND}" -E tar czf
        "${root}/dist/noveltea-player-template-${NOVELTEA_RELEASE_TAG}-${template_id}.${extension}"
        "${template_id}" WORKING_DIRECTORY "${root}/build/package" COMMAND_ERROR_IS_FATAL ANY)
endif()
file(COPY_FILE "${stage}/template.json" "${root}/dist/${template_id}.template.json")
file(COPY_FILE "${stage}/SBOM.cdx.json" "${root}/dist/${template_id}.SBOM.cdx.json")
file(COPY_FILE "${stage}/licenses/index.json" "${root}/dist/${template_id}.licenses.index.json")
string(JSON symbol_input GET "${package_result}" nativeLibraryPath)
set(symbol_stage "${root}/build/package/${template_id}-symbols")
file(REMOVE_RECURSE "${symbol_stage}")
file(MAKE_DIRECTORY "${symbol_stage}/${NOVELTEA_ANDROID_ABI}")
file(WRITE "${symbol_stage}/BUILD_ID" "${NOVELTEA_RELEASE_TAG}-${template_id}\n")
file(COPY_FILE "${symbol_input}" "${symbol_stage}/${NOVELTEA_ANDROID_ABI}/libnoveltea-player.so")
execute_process(COMMAND "${CMAKE_COMMAND}" -E tar cf
    "${root}/dist/noveltea-player-symbols-${NOVELTEA_RELEASE_TAG}-${template_id}.zip"
    --format=zip "${template_id}-symbols" WORKING_DIRECTORY "${root}/build/package"
    COMMAND_ERROR_IS_FATAL ANY)
