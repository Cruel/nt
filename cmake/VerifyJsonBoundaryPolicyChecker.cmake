cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED SOURCE_ROOT)
    message(FATAL_ERROR "SOURCE_ROOT is required")
endif()

set(checker "${SOURCE_ROOT}/cmake/CheckJsonBoundaryPolicy.cmake")
set(temp_root "${SOURCE_ROOT}/build/noveltea-json-boundary-policy-fixtures")
file(REMOVE_RECURSE "${temp_root}")
file(MAKE_DIRECTORY "${temp_root}/engine/include/noveltea/core" "${temp_root}/engine/src"
    "${temp_root}/engine/src/core" "${temp_root}/cmake")
file(WRITE "${temp_root}/cmake/json-boundary-allowlist.txt" "# No exceptions are needed by these fixtures.\n")
file(WRITE "${temp_root}/engine/include/noveltea/core/compiled_project_codec.hpp"
    "#include <nlohmann/json_fwd.hpp>\nnamespace noveltea { void codec(nlohmann::json); }\n")
file(WRITE "${temp_root}/engine/src/core/compiled_package_codec.cpp"
    "#include <nlohmann/json.hpp>\nnamespace noveltea { nlohmann::json codec(); }\n")
execute_process(
    COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${temp_root}
        -DALLOWLIST=${temp_root}/cmake/json-boundary-allowlist.txt -P "${checker}"
    RESULT_VARIABLE positive_result)
if(NOT positive_result EQUAL 0)
    message(FATAL_ERROR "The JSON boundary policy checker rejected an approved codec boundary fixture")
endif()

function(expect_rejected name header_text allowlist_text cmake_text)
    set(fixture_root "${temp_root}/${name}")
    file(MAKE_DIRECTORY "${fixture_root}/engine/include/noveltea/core" "${fixture_root}/cmake")
    file(WRITE "${fixture_root}/engine/include/noveltea/core/domain.hpp" "${header_text}")
    file(WRITE "${fixture_root}/cmake/json-boundary-allowlist.txt" "${allowlist_text}")
    if(NOT cmake_text STREQUAL "")
        file(WRITE "${fixture_root}/CMakeLists.txt" "${cmake_text}")
    endif()
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${fixture_root}
            -DALLOWLIST=${fixture_root}/cmake/json-boundary-allowlist.txt -P "${checker}"
        RESULT_VARIABLE result
        OUTPUT_VARIABLE ignored_output
        ERROR_VARIABLE ignored_error)
    if(result EQUAL 0)
        message(FATAL_ERROR "The JSON boundary policy checker accepted negative fixture '${name}'")
    endif()
endfunction()

function(expect_accepted name header_text allowlist_text cmake_text)
    set(fixture_root "${temp_root}/${name}")
    file(MAKE_DIRECTORY "${fixture_root}/engine/include/noveltea/core" "${fixture_root}/cmake")
    file(WRITE "${fixture_root}/engine/include/noveltea/core/domain.hpp" "${header_text}")
    file(WRITE "${fixture_root}/cmake/json-boundary-allowlist.txt" "${allowlist_text}")
    if(NOT cmake_text STREQUAL "")
        file(WRITE "${fixture_root}/CMakeLists.txt" "${cmake_text}")
    endif()
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${fixture_root}
            -DALLOWLIST=${fixture_root}/cmake/json-boundary-allowlist.txt -P "${checker}"
        RESULT_VARIABLE result
        OUTPUT_VARIABLE ignored_output
        ERROR_VARIABLE ignored_error)
    if(NOT result EQUAL 0)
        message(FATAL_ERROR "The JSON boundary policy checker rejected positive fixture '${name}'")
    endif()
endfunction()

function(expect_source_rejected name source_text)
    set(fixture_root "${temp_root}/${name}")
    file(MAKE_DIRECTORY "${fixture_root}/engine/src" "${fixture_root}/cmake")
    file(WRITE "${fixture_root}/engine/src/runtime_leak.cpp" "${source_text}")
    file(WRITE "${fixture_root}/cmake/json-boundary-allowlist.txt" "# No exceptions.\n")
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${fixture_root}
            -DALLOWLIST=${fixture_root}/cmake/json-boundary-allowlist.txt -P "${checker}"
        RESULT_VARIABLE result
        OUTPUT_VARIABLE ignored_output
        ERROR_VARIABLE ignored_error)
    if(result EQUAL 0)
        message(FATAL_ERROR
            "The JSON boundary policy checker accepted source leak fixture '${name}'")
    endif()
endfunction()

function(expect_tool_boundary name relative content should_pass)
    set(fixture_root "${temp_root}/${name}")
    get_filename_component(relative_parent "${relative}" DIRECTORY)
    file(MAKE_DIRECTORY "${fixture_root}/${relative_parent}" "${fixture_root}/cmake")
    file(WRITE "${fixture_root}/${relative}" "${content}")
    file(WRITE "${fixture_root}/cmake/json-boundary-allowlist.txt" "# No exceptions.\n")
    execute_process(
        COMMAND "${CMAKE_COMMAND}" -DSOURCE_ROOT=${fixture_root}
            -DALLOWLIST=${fixture_root}/cmake/json-boundary-allowlist.txt -P "${checker}"
        RESULT_VARIABLE result
        OUTPUT_VARIABLE ignored_output
        ERROR_VARIABLE ignored_error)
    if(should_pass AND NOT result EQUAL 0)
        message(FATAL_ERROR "The JSON boundary policy checker rejected native tool fixture '${name}': ${ignored_error}")
    elseif(NOT should_pass AND result EQUAL 0)
        message(FATAL_ERROR "The JSON boundary policy checker accepted unauthorized tool fixture '${name}'")
    endif()
endfunction()

expect_rejected(domain-jsoncons-include "#include <jsoncons/json.hpp>\n" "" "")
expect_rejected(domain-jsoncons-quoted-include "#include \"jsoncons/json.hpp\"\n" "" "")
expect_rejected(domain-jsoncons-schema "#include <jsoncons_ext/jsonschema/jsonschema.hpp>\n" "" "")
expect_rejected(domain-jsoncons-type "void decode(jsoncons::json value);\n" "" "")
expect_rejected(domain-include "#include <nlohmann/json.hpp>\n" "" "")
expect_rejected(domain-quoted-include "#include \"nlohmann/json.hpp\"\n" "" "")
expect_rejected(domain-basic-json "void decode(nlohmann::basic_json<> value);\n" "" "")
expect_rejected(domain-adl-serializer "struct nlohmann::adl_serializer<Value>;\n" "" "")
expect_rejected(adl-codec "void to_json();\n" "" "")
expect_rejected(nlohmann-macro "NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Value, field)\n" "" "")
expect_rejected(opaque-wrapper "struct JsonPayload {};\n" "" "")
expect_source_rejected(source-json-leak
    "#include <nlohmann/json.hpp>\nvoid leak(nlohmann::json value) {}\n")
expect_tool_boundary(native-authoring-header "tools/project_authoring/session.hpp"
    "#include <jsoncons/json.hpp>\nvoid author(jsoncons::json value);\n" TRUE)
expect_tool_boundary(native-authoring-source "tools/project_authoring/session.cpp"
    "#include <jsoncons_ext/jsonpointer/jsonpointer.hpp>\n" TRUE)
expect_tool_boundary(native-cli-header "tools/editor_tool/tooling_native_project_contract.hpp"
    "#include <nlohmann/json.hpp>\nvoid transport(nlohmann::json value);\n" TRUE)
expect_tool_boundary(native-cli-source "tools/editor_tool/tooling_native_project_contract.cpp"
    "#include <nlohmann/json.hpp>\nvoid transport(nlohmann::json value) {}\n" TRUE)
expect_tool_boundary(other-tool-source "tools/editor_tool/other_json.cpp"
    "#include <nlohmann/json.hpp>\n" FALSE)
expect_tool_boundary(other-tool-header "tools/editor_tool/other_json.hpp"
    "#include <nlohmann/json.hpp>\n" FALSE)
expect_tool_boundary(nested-authoring-source "tools/project_authoring/internal/other.cpp"
    "#include <jsoncons/json.hpp>\n" FALSE)
expect_tool_boundary(native-authoring-adl "tools/project_authoring/session.hpp"
    "#include <jsoncons/json.hpp>\nvoid to_json();\n" FALSE)
expect_tool_boundary(native-cli-wrapper "tools/editor_tool/tooling_native_project_contract.hpp"
    "#include <nlohmann/json.hpp>\nstruct JsonPayload {};\n" FALSE)
expect_tool_boundary(project-compiler-codec "tools/project_authoring/native_compiled_project.hpp"
    "#include <nlohmann/json.hpp>\nvoid compile(nlohmann::json project);\n" TRUE)
expect_tool_boundary(project-compiler-old-header "tools/editor_tool/native_compiled_project.hpp"
    "#include <nlohmann/json.hpp>\nvoid compile(nlohmann::json project);\n" FALSE)
expect_tool_boundary(unapproved-native-preparer "tools/editor_tool/native_runtime_experimental.cpp"
    "#include <nlohmann/json.hpp>\n" FALSE)
expect_tool_boundary(external-comfyui-adapter "tools/editor_tool/native_cli_comfyui_http.hpp"
    "#include <nlohmann/json.hpp>\n" TRUE)
expect_tool_boundary(other-native-cli-header "tools/editor_tool/native_cli_unapproved.hpp"
    "#include <nlohmann/json.hpp>\n" FALSE)
expect_tool_boundary(project-compiler-nested "tools/project_authoring/experimental/codec.hpp"
    "#include <nlohmann/json.hpp>\n" FALSE)
expect_rejected(public-link "" "" "target_link_libraries(domain PUBLIC nlohmann_json::nlohmann_json)\n")
expect_rejected(public-link-after-other-dependency "" ""
    "target_link_libraries(domain PUBLIC other::dependency nlohmann_json::nlohmann_json)\n")
expect_rejected(interface-link-multiline "" ""
    "target_link_libraries(domain\n  INTERFACE\n    other::dependency\n    nlohmann_json::nlohmann_json\n)\n")
expect_rejected(malformed-allowlist "" "domain.hpp|nlohmann::json\n" "")
expect_rejected(stale-allowlist "" "engine/include/noveltea/core/domain.hpp|nlohmann::json|core|external-boundary-codec|fixture|permanent external boundary\n" "")
expect_rejected(duplicate-allowlist "nlohmann::json value;\n"
    "engine/include/noveltea/core/domain.hpp|nlohmann::json|core|external-boundary-codec|fixture|permanent external boundary\nengine/include/noveltea/core/domain.hpp|nlohmann::json|core|external-boundary-codec|fixture|permanent external boundary\n"
    "")
expect_rejected(wildcard-allowlist "nlohmann::json value;\n"
    "engine/include/noveltea/core/*.hpp|nlohmann::json|core|external-boundary-codec|fixture|permanent external boundary\n"
    "")
expect_rejected(missing-owner "nlohmann::json value;\n"
    "engine/include/noveltea/core/domain.hpp|nlohmann::json||external-boundary-codec|fixture|permanent external boundary\n"
    "")
expect_accepted(exact-allowlist "nlohmann::json value;\n"
    "engine/include/noveltea/core/domain.hpp|nlohmann::json|core|external-boundary-codec|fixture|remove when fixture moves to an approved codec path\n"
    "")

file(REMOVE_RECURSE "${temp_root}")
