cmake_minimum_required(VERSION 3.25)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(NovelTeaProjectAuthoring LANGUAGES CXX)
    include(CTest)
endif()
if(CMAKE_CROSSCOMPILING OR EMSCRIPTEN OR CMAKE_SYSTEM_NAME STREQUAL "Android")
    message(FATAL_ERROR "Project authoring contracts are host-only")
endif()

include(FetchContent)
FetchContent_Declare(noveltea_jsoncons
    URL https://codeload.github.com/danielaparker/jsoncons/tar.gz/d273865feb0d7e35a757c805dc4d1d9320eb6b72
    URL_HASH SHA256=698f41f9f3bd1bdb3127c0548139bb3b68c379fae452c514aec9f0cf92e82b5b
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    SOURCE_SUBDIR noveltea-no-upstream-build
)
FetchContent_MakeAvailable(noveltea_jsoncons)

set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/generated/contracts.json")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/generated/contracts.json" contract_json)
string(LENGTH "${contract_json}" contract_length)
set(NOVELTEA_NATIVE_CONTRACT_CHUNKS "")
set(offset 0)
# Keep individual literals below MSVC's string-size limit; no Node generator runs here.
while(offset LESS contract_length)
    string(SUBSTRING "${contract_json}" ${offset} 16000 chunk)
    string(LENGTH "${chunk}" chunk_length)
    string(APPEND NOVELTEA_NATIVE_CONTRACT_CHUNKS "std::string_view{R\"nt_contracts(${chunk})nt_contracts\", ${chunk_length}},\n")
    math(EXPR offset "${offset} + 16000")
endwhile()
configure_file(embedded_contracts.hpp.in embedded_contracts.hpp @ONLY)
add_library(noveltea_project_authoring_contracts STATIC contracts.cpp)
target_compile_features(noveltea_project_authoring_contracts PUBLIC cxx_std_20)
target_include_directories(noveltea_project_authoring_contracts PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(noveltea_project_authoring_contracts PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_include_directories(noveltea_project_authoring_contracts SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
# Deliberately no engine/player link or install rule: this is a certification-only host library.
add_executable(noveltea-schema-certify certify.cpp types_compile.cpp)
target_link_libraries(noveltea-schema-certify PRIVATE noveltea_project_authoring_contracts)
if(BUILD_TESTING)
    add_test(NAME native_authoring_contracts COMMAND noveltea-schema-certify --self-test)
endif()
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    foreach(mode IN ITEMS format format-check)
        if(mode STREQUAL "format")
            set(format_mode format)
        else()
            set(format_mode check)
        endif()
        add_custom_target(${mode}
            COMMAND "${CMAKE_COMMAND}" -DMODE=${format_mode}
                -DSOURCE_ROOT=${CMAKE_CURRENT_SOURCE_DIR}/../..
                -P "${CMAKE_CURRENT_SOURCE_DIR}/../../cmake/RunClangFormat.cmake")
    endforeach()
endif()
