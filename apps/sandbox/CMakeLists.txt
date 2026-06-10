add_executable(noveltea-sandbox main.cpp)

target_link_libraries(noveltea-sandbox PRIVATE engine)

# Emscripten output settings
if(EMSCRIPTEN)
    set_target_properties(noveltea-sandbox PROPERTIES
        SUFFIX ".js"
    )
    target_link_options(noveltea-sandbox PRIVATE
        -sUSE_SDL=3
        -sUSE_WEBGL2=1
        -sALLOW_MEMORY_GROWTH=1
        --shell-file "${CMAKE_SOURCE_DIR}/web/shell.html"
    )
endif()

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-sandbox PRIVATE
        -Wall -Wextra -Wpedantic
    )
endif()
