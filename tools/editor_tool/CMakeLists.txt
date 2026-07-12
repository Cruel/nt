add_executable(noveltea-editor-tool
    main.cpp
)

target_link_libraries(noveltea-editor-tool PRIVATE engine)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-editor-tool PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
noveltea_apply_policy_warnings(noveltea-editor-tool)
