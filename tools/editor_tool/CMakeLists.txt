add_executable(noveltea-editor-tool
    main.cpp
)

find_package(nlohmann_json CONFIG REQUIRED)
target_link_libraries(noveltea-editor-tool PRIVATE noveltea_engine nlohmann_json::nlohmann_json)
target_compile_definitions(noveltea-editor-tool PRIVATE ${NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS})

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
    target_compile_options(noveltea-editor-tool PRIVATE
        -Wall -Wextra -Wpedantic -Wno-unused-parameter
    )
endif()
noveltea_apply_runtime_compiler_policy(noveltea-editor-tool)
noveltea_apply_policy_warnings(noveltea-editor-tool)
