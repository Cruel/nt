cmake_minimum_required(VERSION 3.25)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    project(NovelTeaProjectAuthoring LANGUAGES C CXX)
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

# Host-only YAML authoring codec. Pin the actual source commit, not a moving tag.
FetchContent_Declare(noveltea_libfyaml
    GIT_REPOSITORY https://github.com/pantoniou/libfyaml.git
    GIT_TAG 7a0d93e17b7e694c45ffb1d726665030cf0cb4ed
    GIT_SHALLOW FALSE
    SOURCE_SUBDIR noveltea-no-upstream-build
)
FetchContent_MakeAvailable(noveltea_libfyaml)
# Import only the pinned static parser into the ordinary host build; do not build
# upstream CLI tools, Python bindings, shared libraries or tests with NovelTea.
function(noveltea_add_host_libfyaml)
    # Keep upstream's generic option names confined to this host-only dependency.
    set(BUILD_TESTING OFF)
    set(ENABLE_PYTHON_BINDINGS OFF)
    set(ENABLE_REFLECTION OFF)
    set(ENABLE_GENERIC OFF)
    add_subdirectory("${noveltea_libfyaml_SOURCE_DIR}" "${noveltea_libfyaml_BINARY_DIR}" EXCLUDE_FROM_ALL)
endfunction()
noveltea_add_host_libfyaml()

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
# Keep the new parser off the engine/player graph and outside the JSON schema library.
add_library(noveltea_project_authoring_yaml STATIC yaml_codec.cpp)
target_compile_features(noveltea_project_authoring_yaml PUBLIC cxx_std_20)
target_include_directories(noveltea_project_authoring_yaml PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(noveltea_project_authoring_yaml SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
target_link_libraries(noveltea_project_authoring_yaml PRIVATE fyaml_static)
# Native Room session remains independent of editor, CLI daemon, and runtime linkage.
add_library(noveltea_project_authoring_session STATIC room_session.cpp)
target_compile_features(noveltea_project_authoring_session PUBLIC cxx_std_20)
target_include_directories(noveltea_project_authoring_session PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(noveltea_project_authoring_session SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
target_link_libraries(noveltea_project_authoring_session PUBLIC noveltea_project_authoring_yaml noveltea_project_authoring_contracts)
# Deliberately no engine/player link or install rule: this is a certification-only host library.
add_executable(noveltea-schema-certify certify.cpp types_compile.cpp)
target_link_libraries(noveltea-schema-certify PRIVATE noveltea_project_authoring_contracts)
if(BUILD_TESTING)
    add_test(NAME native_authoring_contracts COMMAND noveltea-schema-certify --self-test)
    add_executable(noveltea-yaml-certify yaml_certify.cpp)
    target_include_directories(noveltea-yaml-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-yaml-certify PRIVATE noveltea_project_authoring_yaml)
    add_test(NAME native_authoring_yaml COMMAND noveltea-yaml-certify)
    add_executable(noveltea-room-session-certify room_session_certify.cpp)
    target_include_directories(noveltea-room-session-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-room-session-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_room_session COMMAND noveltea-room-session-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
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
