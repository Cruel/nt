if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    add_library(noveltea-player SHARED main.cpp)
else()
    add_executable(noveltea-player main.cpp)
endif()

target_link_libraries(noveltea-player PRIVATE engine)
target_compile_definitions(noveltea-player PRIVATE NOVELTEA_PLAYER_BUILD=1)
if(EMSCRIPTEN)
    set_target_properties(noveltea-player PROPERTIES OUTPUT_NAME "player" SUFFIX ".html")
    target_link_options(noveltea-player PRIVATE
        -sUSE_WEBGL2=1
        -sALLOW_MEMORY_GROWTH=1
        -sEXIT_RUNTIME=0
        -sFORCE_FILESYSTEM=1
        -sEXPORTED_RUNTIME_METHODS=['FS']
        --js-library "${CMAKE_SOURCE_DIR}/web/persistent_fs.js"
    )
endif()
if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-player PRIVATE -Wall -Wextra -Wpedantic)
endif()

set(NOVELTEA_PLAYER_BUILD_ID "${PROJECT_VERSION}-${CMAKE_SYSTEM_NAME}-${CMAKE_SYSTEM_PROCESSOR}-${CMAKE_BUILD_TYPE}")
file(GENERATE OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/player-build.json" CONTENT
"{\n  \"format\": \"noveltea.player-template-build\",\n  \"formatVersion\": 1,\n  \"engineVersion\": \"${PROJECT_VERSION}\",\n  \"buildId\": \"${NOVELTEA_PLAYER_BUILD_ID}\",\n  \"buildFlavor\": \"$<IF:$<CONFIG:Debug>,debug,release>\"\n}\n")
add_custom_command(TARGET noveltea-player POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${CMAKE_CURRENT_BINARY_DIR}/player-build.json"
        "$<TARGET_FILE_DIR:noveltea-player>/player-build.json")
