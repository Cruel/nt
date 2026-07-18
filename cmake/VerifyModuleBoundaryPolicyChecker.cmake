cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED SOURCE_ROOT)
    message(FATAL_ERROR "SOURCE_ROOT is required")
endif()

set(checker "${SOURCE_ROOT}/cmake/CheckModuleBoundaryPolicy.cmake")
set(temp_root "${SOURCE_ROOT}/build/noveltea-module-boundary-policy-fixtures")
file(REMOVE_RECURSE "${temp_root}")

function(write_base_fixture fixture_root)
    file(MAKE_DIRECTORY
        "${fixture_root}/cmake"
        "${fixture_root}/docs/architecture"
        "${fixture_root}/engine/include/noveltea/core"
        "${fixture_root}/engine/include/noveltea/runtime"
        "${fixture_root}/engine/include/noveltea/presentation"
        "${fixture_root}/engine/include/noveltea/script"
        "${fixture_root}/engine/include/noveltea"
        "${fixture_root}/engine/src")
    file(WRITE "${fixture_root}/engine/include/noveltea/core/domain.hpp" "#pragma once\n")
    file(WRITE "${fixture_root}/engine/include/noveltea/core/content.hpp"
        "#pragma once\n#include <noveltea/core/domain.hpp>\n#include <nlohmann/json_fwd.hpp>\n")
    file(WRITE "${fixture_root}/engine/include/noveltea/runtime/runtime.hpp"
        "#pragma once\n#include <noveltea/core/domain.hpp>\n#include <noveltea/core/content.hpp>\n")
    file(WRITE "${fixture_root}/engine/include/noveltea/presentation/presentation.hpp"
        "#pragma once\n#include <noveltea/core/domain.hpp>\n#include <noveltea/runtime/runtime.hpp>\n")
    file(WRITE "${fixture_root}/engine/include/noveltea/script/lua.hpp"
        "#pragma once\n#include <noveltea/core/domain.hpp>\n#include <noveltea/runtime/runtime.hpp>\n#include <lua.hpp>\n")
    file(WRITE "${fixture_root}/engine/include/noveltea/engine.hpp"
        "#pragma once\n#include <noveltea/core/content.hpp>\n#include <noveltea/presentation/presentation.hpp>\n#include <noveltea/script/lua.hpp>\n#include <SDL3/SDL.h>\n")
    file(WRITE "${fixture_root}/cmake/NovelTeaModuleFileClassification.cmake" [=[
set(NOVELTEA_MODULE_CLASSIFICATION_VERSION 1)
set(NOVELTEA_MODULE_CLASSIFICATION_TARGETS
    noveltea_domain
    noveltea_content
    noveltea_runtime
    noveltea_presentation
    noveltea_script_lua
    noveltea_engine)
set(NOVELTEA_MODULE_FILES_noveltea_domain
    engine/include/noveltea/core/domain.hpp)
set(NOVELTEA_MODULE_FILES_noveltea_content
    engine/include/noveltea/core/content.hpp)
set(NOVELTEA_MODULE_FILES_noveltea_runtime
    engine/include/noveltea/runtime/runtime.hpp)
set(NOVELTEA_MODULE_FILES_noveltea_presentation
    engine/include/noveltea/presentation/presentation.hpp)
set(NOVELTEA_MODULE_FILES_noveltea_script_lua
    engine/include/noveltea/script/lua.hpp)
set(NOVELTEA_MODULE_FILES_noveltea_engine
    engine/include/noveltea/engine.hpp)
]=])
    file(WRITE "${fixture_root}/engine/CMakeLists.txt" [=[
target_link_libraries(noveltea_content PUBLIC noveltea_domain PRIVATE nlohmann_json::nlohmann_json)
target_link_libraries(noveltea_runtime PUBLIC noveltea_domain noveltea_content)
target_link_libraries(noveltea_presentation PUBLIC noveltea_domain noveltea_runtime)
target_link_libraries(noveltea_script_lua PUBLIC noveltea_domain noveltea_runtime PRIVATE Lua::Lua sol2::sol2)
target_link_libraries(noveltea_engine PUBLIC noveltea_domain noveltea_content noveltea_runtime noveltea_presentation PRIVATE noveltea_script_lua SDL3::SDL3)
]=])
    file(WRITE "${fixture_root}/cmake/module-boundary-allowlist.txt"
        "# No exceptions are needed by the base fixture.\n")
    file(WRITE "${fixture_root}/docs/architecture/exceptions.md" "# Fixture exceptions\n")
endfunction()

function(run_checker fixture_root out_result)
    execute_process(
        COMMAND "${CMAKE_COMMAND}"
            -DSOURCE_ROOT=${fixture_root}
            -DCLASSIFICATION=${fixture_root}/cmake/NovelTeaModuleFileClassification.cmake
            -DALLOWLIST=${fixture_root}/cmake/module-boundary-allowlist.txt
            -P "${checker}"
        RESULT_VARIABLE result
        OUTPUT_VARIABLE ignored_output
        ERROR_VARIABLE ignored_error)
    set(${out_result} "${result}" PARENT_SCOPE)
endfunction()

function(expect_accepted name)
    set(fixture_root "${temp_root}/${name}")
    write_base_fixture("${fixture_root}")
    run_checker("${fixture_root}" result)
    if(NOT result EQUAL 0)
        message(FATAL_ERROR "The module boundary checker rejected positive fixture '${name}'")
    endif()
endfunction()

function(expect_rejected name mutation_kind mutation_value allowlist_text documentation_text)
    set(fixture_root "${temp_root}/${name}")
    write_base_fixture("${fixture_root}")
    if(mutation_kind STREQUAL "domain-header")
        file(APPEND "${fixture_root}/engine/include/noveltea/core/domain.hpp" "${mutation_value}")
    elseif(mutation_kind STREQUAL "runtime-header")
        file(APPEND "${fixture_root}/engine/include/noveltea/runtime/runtime.hpp" "${mutation_value}")
    elseif(mutation_kind STREQUAL "cmake")
        file(APPEND "${fixture_root}/engine/CMakeLists.txt" "${mutation_value}")
    elseif(mutation_kind STREQUAL "unclassified-source")
        file(WRITE "${fixture_root}/engine/src/unclassified.cpp" "${mutation_value}")
    elseif(NOT mutation_kind STREQUAL "none")
        message(FATAL_ERROR "Unknown fixture mutation kind: ${mutation_kind}")
    endif()
    if(NOT allowlist_text STREQUAL "")
        file(WRITE "${fixture_root}/cmake/module-boundary-allowlist.txt" "${allowlist_text}")
    endif()
    if(NOT documentation_text STREQUAL "")
        file(WRITE "${fixture_root}/docs/architecture/exceptions.md" "${documentation_text}")
    endif()
    run_checker("${fixture_root}" result)
    if(result EQUAL 0)
        message(FATAL_ERROR "The module boundary checker accepted negative fixture '${name}'")
    endif()
endfunction()

expect_accepted(allowed-graph)

set(build_tree_fixture "${temp_root}/build-tree-exclusion")
write_base_fixture("${build_tree_fixture}")
file(MAKE_DIRECTORY "${build_tree_fixture}/build/generated")
file(WRITE "${build_tree_fixture}/build/generated/forbidden.cpp"
    "#include <noveltea/runtime/runtime.hpp>\n#include <SDL3/SDL.h>\n")
file(WRITE "${build_tree_fixture}/build/CMakeLists.txt"
    "target_link_libraries(noveltea_domain PRIVATE noveltea_engine)\n")
run_checker("${build_tree_fixture}" build_tree_result)
if(NOT build_tree_result EQUAL 0)
    message(FATAL_ERROR "The module boundary checker scanned a generated/build tree fixture")
endif()

expect_rejected(forbidden-module-include domain-header
    "#include <noveltea/runtime/runtime.hpp>\n" "" "")
expect_rejected(forbidden-backend-include runtime-header
    "#include <SDL3/SDL.h>\n" "" "")
expect_rejected(forbidden-target-edge cmake
    "target_link_libraries(noveltea_domain PRIVATE noveltea_engine)\n" "" "")
expect_rejected(dynamic-target-edge cmake [=[target_link_libraries(noveltea_runtime PRIVATE ${HIDDEN_TARGET})
]=] "" "")
expect_rejected(unclassified-production-file unclassified-source
    "#include <SDL3/SDL.h>\n" "" "")
expect_rejected(malformed-allowlist none ""
    "include|engine/include/noveltea/core/domain.hpp|noveltea/runtime/runtime.hpp\n" "")
expect_rejected(wildcard-allowlist domain-header
    "#include <noveltea/runtime/runtime.hpp>\n"
    "include|engine/include/noveltea/core/*.hpp|noveltea/runtime/runtime.hpp|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\n"
    "include|engine/include/noveltea/core/*.hpp|noveltea/runtime/runtime.hpp\n")
expect_rejected(duplicate-allowlist domain-header
    "#include <noveltea/runtime/runtime.hpp>\n"
    "include|engine/include/noveltea/core/domain.hpp|noveltea/runtime/runtime.hpp|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\ninclude|engine/include/noveltea/core/domain.hpp|noveltea/runtime/runtime.hpp|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\n"
    "include|engine/include/noveltea/core/domain.hpp|noveltea/runtime/runtime.hpp\n")
expect_rejected(stale-allowlist none ""
    "include|engine/include/noveltea/core/content.hpp|noveltea/core/domain.hpp|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\n"
    "include|engine/include/noveltea/core/content.hpp|noveltea/core/domain.hpp\n")
expect_rejected(undocumented-allowlist domain-header
    "#include <noveltea/runtime/runtime.hpp>\n"
    "include|engine/include/noveltea/core/domain.hpp|noveltea/runtime/runtime.hpp|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\n"
    "# Fixture exceptions\n")

set(documented_include_fixture "${temp_root}/documented-include-exception")
write_base_fixture("${documented_include_fixture}")
file(APPEND "${documented_include_fixture}/engine/include/noveltea/core/domain.hpp"
    "#include <noveltea/runtime/runtime.hpp>\n")
set(include_exception_key
    "include|engine/include/noveltea/core/domain.hpp|noveltea/runtime/runtime.hpp")
file(WRITE "${documented_include_fixture}/cmake/module-boundary-allowlist.txt"
    "${include_exception_key}|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\n")
file(WRITE "${documented_include_fixture}/docs/architecture/exceptions.md"
    "${include_exception_key}\n")
run_checker("${documented_include_fixture}" documented_include_result)
if(NOT documented_include_result EQUAL 0)
    message(FATAL_ERROR "The module boundary checker rejected an exact documented include exception")
endif()

set(documented_edge_fixture "${temp_root}/documented-target-edge-exception")
write_base_fixture("${documented_edge_fixture}")
file(APPEND "${documented_edge_fixture}/engine/CMakeLists.txt"
    "target_link_libraries(noveltea_domain PRIVATE noveltea_engine)\n")
set(edge_exception_key "target-edge|noveltea_domain|noveltea_engine")
file(WRITE "${documented_edge_fixture}/cmake/module-boundary-allowlist.txt"
    "${edge_exception_key}|architecture|fixture exception|remove fixture|docs/architecture/exceptions.md\n")
file(WRITE "${documented_edge_fixture}/docs/architecture/exceptions.md"
    "${edge_exception_key}\n")
run_checker("${documented_edge_fixture}" documented_edge_result)
if(NOT documented_edge_result EQUAL 0)
    message(FATAL_ERROR "The module boundary checker rejected an exact documented target-edge exception")
endif()

file(REMOVE_RECURSE "${temp_root}")
