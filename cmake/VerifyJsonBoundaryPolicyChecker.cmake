cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED SOURCE_ROOT)
    message(FATAL_ERROR "SOURCE_ROOT is required")
endif()

set(checker "${SOURCE_ROOT}/cmake/CheckJsonBoundaryPolicy.cmake")
set(temp_root "${SOURCE_ROOT}/build/noveltea-json-boundary-policy-fixtures")
file(REMOVE_RECURSE "${temp_root}")
file(MAKE_DIRECTORY "${temp_root}/engine/include/noveltea/core" "${temp_root}/engine/src"
    "${temp_root}/cmake")
file(WRITE "${temp_root}/cmake/json-boundary-allowlist.txt" "# No exceptions are needed by these fixtures.\n")
file(WRITE "${temp_root}/engine/include/noveltea/core/compiled_project_codec.hpp"
    "#include <nlohmann/json_fwd.hpp>\nnamespace noveltea { void codec(nlohmann::json); }\n")
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

expect_rejected(domain-include "#include <nlohmann/json.hpp>\n" "" "")
expect_rejected(domain-quoted-include "#include \"nlohmann/json.hpp\"\n" "" "")
expect_rejected(domain-basic-json "void decode(nlohmann::basic_json<> value);\n" "" "")
expect_rejected(domain-adl-serializer "struct nlohmann::adl_serializer<Value>;\n" "" "")
expect_rejected(adl-codec "void to_json();\n" "" "")
expect_rejected(nlohmann-macro "NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Value, field)\n" "" "")
expect_rejected(opaque-wrapper "struct JsonPayload {};\n" "" "")
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
