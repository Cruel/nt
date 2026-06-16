if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    add_library(noveltea-sandbox SHARED main.cpp)
else()
    add_executable(noveltea-sandbox main.cpp)
endif()

target_link_libraries(noveltea-sandbox PRIVATE engine)

set(NOVELTEA_SANDBOX_ASSETS "${CMAKE_SOURCE_DIR}/apps/sandbox/assets")

# Emscripten output settings
if(EMSCRIPTEN)
    set_target_properties(noveltea-sandbox PROPERTIES
        OUTPUT_NAME "index"
        SUFFIX ".html"
    )
    set(SHELL_FILE "${CMAKE_SOURCE_DIR}/web/shell.html")
    set(PERSISTENT_FS_PRE_JS "${CMAKE_SOURCE_DIR}/web/persistent_fs_pre.js")
    set(PERSISTENT_FS_JS "${CMAKE_SOURCE_DIR}/web/persistent_fs.js")
    target_link_options(noveltea-sandbox PRIVATE
        -sUSE_WEBGL2=1
        -sALLOW_MEMORY_GROWTH=1
        -sEXIT_RUNTIME=0
        -sFORCE_FILESYSTEM=1
        -sEXPORTED_FUNCTIONS=['_main','_noveltea_preview_set_demo_position','_noveltea_preview_reset_demo','_noveltea_preview_set_running']
        -lidbfs.js
        --shell-file "${SHELL_FILE}"
        --pre-js "${PERSISTENT_FS_PRE_JS}"
        --js-library "${PERSISTENT_FS_JS}"
        "SHELL:--preload-file ${NOVELTEA_SANDBOX_ASSETS}@/assets"
    )
    # Force re-link when shell.html changes
    set_property(TARGET noveltea-sandbox APPEND PROPERTY
        LINK_DEPENDS "${SHELL_FILE};${PERSISTENT_FS_PRE_JS};${PERSISTENT_FS_JS}"
    )
    if(CMAKE_BUILD_TYPE STREQUAL "MinSizeRel" OR CMAKE_BUILD_TYPE STREQUAL "Release")
        target_compile_options(noveltea-sandbox PRIVATE -flto)
        target_link_options(noveltea-sandbox PRIVATE -flto)
    endif()
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    set(NOVELTEA_ANDROID_GENERATED_ASSETS
        "${CMAKE_BINARY_DIR}/android-generated-assets")
    add_custom_command(TARGET noveltea-sandbox PRE_BUILD
        COMMAND "${CMAKE_COMMAND}" -E make_directory
                "${NOVELTEA_ANDROID_GENERATED_ASSETS}"
        COMMAND "${CMAKE_COMMAND}" -E copy_directory
                "${NOVELTEA_SANDBOX_ASSETS}"
                "${NOVELTEA_ANDROID_GENERATED_ASSETS}/assets"
        VERBATIM
    )
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-sandbox PRIVATE
        -Wall -Wextra -Wpedantic
    )
endif()
