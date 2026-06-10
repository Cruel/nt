if(CMAKE_SYSTEM_NAME STREQUAL "Android")
    add_library(noveltea-sandbox SHARED main.cpp)
else()
    add_executable(noveltea-sandbox main.cpp)
endif()

target_link_libraries(noveltea-sandbox PRIVATE engine)

# Emscripten output settings
if(EMSCRIPTEN)
    set_target_properties(noveltea-sandbox PROPERTIES
        OUTPUT_NAME "index"
        SUFFIX ".html"
    )
    set(SHELL_FILE "${CMAKE_SOURCE_DIR}/web/shell.html")
    target_link_options(noveltea-sandbox PRIVATE
        -sUSE_WEBGL2=1
        -sALLOW_MEMORY_GROWTH=1
        -sEXIT_RUNTIME=0
        --shell-file "${SHELL_FILE}"
    )
    # Force re-link when shell.html changes
    set_property(TARGET noveltea-sandbox APPEND PROPERTY
        LINK_DEPENDS "${SHELL_FILE}"
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
