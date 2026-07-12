cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED SOURCE_ROOT)
    message(FATAL_ERROR "SOURCE_ROOT is required")
endif()

if(DEFINED ENV{TMPDIR} AND NOT "$ENV{TMPDIR}" STREQUAL "")
    set(temp_root "$ENV{TMPDIR}")
else()
    set(temp_root "/tmp")
endif()
set(fixture_root "${temp_root}/noveltea-cxx-runtime-policy-negative-fixture")
file(REMOVE_RECURSE "${fixture_root}")
file(MAKE_DIRECTORY "${fixture_root}/engine")
file(WRITE "${fixture_root}/allowlist.txt" "# Intentionally empty.\n")
file(WRITE "${fixture_root}/engine/negative.cpp" [=[
#include <filesystem>
#include <map>
#include <string>
#include <typeinfo>
#include <vector>
void rejected(std::vector<int>& values, std::map<int, int>& mapping) {
    try { (void)values.at(0); } catch (...) {}
    (void)mapping.at(0);
    (void)std::stoul("1");
    (void)std::filesystem::exists("missing");
    (void)typeid(values);
}
]=])

execute_process(
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE_ROOT=${fixture_root}"
        "-DALLOWLIST=${fixture_root}/allowlist.txt"
        -P "${SOURCE_ROOT}/cmake/CheckCxxRuntimePolicy.cmake"
    RESULT_VARIABLE result
    OUTPUT_VARIABLE output
    ERROR_VARIABLE error)

if(result EQUAL 0)
    message(FATAL_ERROR "The C++ runtime policy checker accepted its negative fixture")
endif()

set(combined "${output}\n${error}")
foreach(expected IN ITEMS exception-syntax compiler-rtti container-at throwing-number-conversion
                          filesystem-operation)
    if(NOT combined MATCHES "${expected}")
        message(FATAL_ERROR "Negative fixture did not trigger ${expected}:\n${combined}")
    endif()
endforeach()
