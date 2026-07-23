if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    add_library(noveltea-player SHARED main.cpp)
elseif(WIN32)
    add_executable(noveltea-player WIN32 main.cpp)
else()
    add_executable(noveltea-player main.cpp)
endif()

target_link_libraries(noveltea-player PRIVATE
    noveltea_engine
    SDL3::SDL3
)
noveltea_attach_runtime_assets(noveltea-player)
target_compile_definitions(noveltea-player PRIVATE NOVELTEA_PLAYER_BUILD=1)
if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    target_link_options(noveltea-player PRIVATE
        "LINKER:-z,max-page-size=16384"
    )
endif()
if(EMSCRIPTEN)
    set(NOVELTEA_PLAYER_BUILD_ASSETS "${CMAKE_BINARY_DIR}/runtime-assets")
    set(NOVELTEA_PLAYER_RUNTIME_ASSET_STAMP
        "${CMAKE_BINARY_DIR}/generated-assets/runtime-assets.stamp")
    set_target_properties(noveltea-player PROPERTIES OUTPUT_NAME "player" SUFFIX ".html")
    target_link_options(noveltea-player PRIVATE
        -sUSE_WEBGL2=1
        -sALLOW_MEMORY_GROWTH=1
        -sEXIT_RUNTIME=0
        -sFORCE_FILESYSTEM=1
        -sEXPORTED_FUNCTIONS=['_main','_noveltea_player_resize','_noveltea_player_prepare_package','_noveltea_player_commit_package','_noveltea_player_retained_package_bytes']
        -sEXPORTED_RUNTIME_METHODS=['FS','addRunDependency','removeRunDependency']
        -lidbfs.js
        "SHELL:--shell-file ${CMAKE_SOURCE_DIR}/web/player_shell.html"
        "SHELL:--pre-js ${CMAKE_SOURCE_DIR}/web/player_bootstrap.js"
        "SHELL:--pre-js ${CMAKE_SOURCE_DIR}/web/player_pre.js"
        "SHELL:--js-library ${CMAKE_SOURCE_DIR}/web/player_bridge.js"
        "SHELL:--js-library ${CMAKE_SOURCE_DIR}/web/persistent_fs.js"
        "SHELL:--preload-file ${NOVELTEA_PLAYER_BUILD_ASSETS}@/assets"
    )
    if(NOVELTEA_ENABLE_THREADS)
        target_link_options(noveltea-player PRIVATE
            "SHELL:--pre-js ${CMAKE_SOURCE_DIR}/web/threading_pre.js"
        )
        set_property(TARGET noveltea-player APPEND PROPERTY LINK_DEPENDS
            "${CMAKE_SOURCE_DIR}/web/threading_pre.js")
    endif()
    set_property(TARGET noveltea-player APPEND PROPERTY LINK_DEPENDS
        "${CMAKE_SOURCE_DIR}/web/player_shell.html;${CMAKE_SOURCE_DIR}/web/player_bootstrap.js;${CMAKE_SOURCE_DIR}/web/player_pre.js;${CMAKE_SOURCE_DIR}/web/player_bridge.js;${CMAKE_SOURCE_DIR}/web/persistent_fs.js;${NOVELTEA_PLAYER_RUNTIME_ASSET_STAMP}")
    if(CMAKE_BUILD_TYPE STREQUAL "Release" OR CMAKE_BUILD_TYPE STREQUAL "RelWithDebInfo" OR CMAKE_BUILD_TYPE STREQUAL "MinSizeRel")
        set(NOVELTEA_PLAYER_DWARF_SYMBOLS
            "${CMAKE_CURRENT_BINARY_DIR}/player.wasm.debug.wasm")
        target_link_options(noveltea-player PRIVATE
            "SHELL:-gseparate-dwarf=${NOVELTEA_PLAYER_DWARF_SYMBOLS}"
        )
    endif()
endif()
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-player PRIVATE -Wall -Wextra -Wpedantic)
endif()
noveltea_apply_runtime_compiler_policy(noveltea-player)
noveltea_apply_policy_warnings(noveltea-player)

set(NOVELTEA_PLAYER_BUILD_ID "${PROJECT_VERSION}-${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}-${CMAKE_BUILD_TYPE}")
file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/player-build.json" CONTENT
"{\n  \"format\": \"noveltea.player-template-build\",\n  \"formatVersion\": 1,\n  \"engineVersion\": \"${PROJECT_VERSION}\",\n  \"buildId\": \"${NOVELTEA_PLAYER_BUILD_ID}\",\n  \"buildFlavor\": \"$<IF:$<CONFIG:Debug>,debug,release>\"\n}\n")
add_custom_command(TARGET noveltea-player POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/player-build.json"
        "$<TARGET_FILE_DIR:noveltea-player>/player-build.json")
