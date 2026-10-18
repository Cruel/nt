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
set(NOVELTEA_MATERIAL_REGISTRY "${CMAKE_CURRENT_SOURCE_DIR}/../../engine/material-contracts/material-contract-registry.json")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${NOVELTEA_MATERIAL_REGISTRY}")
file(READ "${NOVELTEA_MATERIAL_REGISTRY}" NOVELTEA_MATERIAL_REGISTRY_JSON)
configure_file(embedded_material_registry.hpp.in embedded_material_registry.hpp @ONLY)
add_library(noveltea_project_authoring_contracts STATIC contracts.cpp room_map_semantics.cpp localization_operations.cpp)
set_target_properties(noveltea_project_authoring_contracts PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_features(noveltea_project_authoring_contracts PUBLIC cxx_std_20)
target_include_directories(noveltea_project_authoring_contracts PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(noveltea_project_authoring_contracts PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_include_directories(noveltea_project_authoring_contracts SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
# Keep the new parser off the engine/player graph and outside the JSON schema library.
add_library(noveltea_project_authoring_yaml STATIC yaml_codec.cpp)
set_target_properties(noveltea_project_authoring_yaml PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_features(noveltea_project_authoring_yaml PUBLIC cxx_std_20)
target_include_directories(noveltea_project_authoring_yaml PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(noveltea_project_authoring_yaml SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
target_link_libraries(noveltea_project_authoring_yaml PRIVATE fyaml_static)
# Native Room session remains independent of editor, CLI daemon, and runtime linkage.
add_library(noveltea_project_authoring_session STATIC room_session.cpp clean_validation_cache.cpp preview_preparation.cpp property_semantics.cpp character_archetype_semantics.cpp interactable_inventory_semantics.cpp dialogue_scene_semantics.cpp verb_interaction_semantics.cpp test_semantics.cpp asset_animation_semantics.cpp material_semantics.cpp localization_semantics.cpp source_analysis.cpp source_authority.cpp yaml_transaction.cpp)
set_target_properties(noveltea_project_authoring_session PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_features(noveltea_project_authoring_session PUBLIC cxx_std_20)
target_include_directories(noveltea_project_authoring_session PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_include_directories(noveltea_project_authoring_session PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_include_directories(noveltea_project_authoring_session PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../../engine/include")
target_include_directories(noveltea_project_authoring_session SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
target_link_libraries(noveltea_project_authoring_session PUBLIC noveltea_project_authoring_yaml noveltea_project_authoring_contracts)
# One deterministic semantic fingerprint for all host binaries, irrespective
# of whether the session is linked into the daemon or the Node-API addon.
# Tracked content changes force reconfiguration; old exact-result caches miss.
file(GLOB NOVELTEA_NATIVE_VALIDATION_SOURCES CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp" "${CMAKE_CURRENT_SOURCE_DIR}/*.hpp")
list(FILTER NOVELTEA_NATIVE_VALIDATION_SOURCES EXCLUDE REGEX "(_certify|authoring_node_addon)\\.cpp$")
list(APPEND NOVELTEA_NATIVE_VALIDATION_SOURCES
    "${CMAKE_CURRENT_SOURCE_DIR}/generated/contracts.json" "${NOVELTEA_MATERIAL_REGISTRY}"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../VERSION")
set(NOVELTEA_NATIVE_VALIDATION_SOURCE_IDENTITIES "")
foreach(input IN LISTS NOVELTEA_NATIVE_VALIDATION_SOURCES)
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${input}")
    file(SHA256 "${input}" digest)
    # Cache compatibility must not depend on which CI/worktree path compiled
    # the CLI or editor binary. Only stable source-relative names and bytes.
    file(RELATIVE_PATH relative_input "${CMAKE_CURRENT_SOURCE_DIR}" "${input}")
    string(APPEND NOVELTEA_NATIVE_VALIDATION_SOURCE_IDENTITIES "${relative_input}:${digest};")
endforeach()
string(SHA256 NOVELTEA_NATIVE_VALIDATION_FINGERPRINT "${NOVELTEA_NATIVE_VALIDATION_SOURCE_IDENTITIES}")
set_source_files_properties(clean_validation_cache.cpp PROPERTIES COMPILE_DEFINITIONS
    "NOVELTEA_NATIVE_VALIDATION_FINGERPRINT=\"${NOVELTEA_NATIVE_VALIDATION_FINGERPRINT}\"")
# Only an explicitly requested host build creates the Node-API module.
# The editor packages it as a separate host-only resource for certification;
# it is never linked into players or the CLI daemon.
option(NOVELTEA_BUILD_AUTHORING_NODE_ADDON "Build certification-only Node-API Project session" OFF)
if(NOVELTEA_BUILD_AUTHORING_NODE_ADDON)
    set(NOVELTEA_NODE_API_INCLUDE_DIR "" CACHE PATH "Node-API headers for the host Node/Electron")
    if(NOT NOVELTEA_NODE_API_INCLUDE_DIR)
        find_program(NOVELTEA_AUTHORING_NODE NAMES node REQUIRED)
        execute_process(COMMAND "${NOVELTEA_AUTHORING_NODE}" -p "require('path').resolve(process.execPath,'../../include/node')"
            OUTPUT_VARIABLE NOVELTEA_NODE_API_INCLUDE_DIR OUTPUT_STRIP_TRAILING_WHITESPACE
            RESULT_VARIABLE NOVELTEA_NODE_HEADERS_RESULT)
    endif()
    if(NOT EXISTS "${NOVELTEA_NODE_API_INCLUDE_DIR}/node_api.h")
        message(FATAL_ERROR "Node-API headers matching the installed Node executable are required")
    endif()
    set_target_properties(fyaml_static PROPERTIES POSITION_INDEPENDENT_CODE ON)
    add_library(noveltea-authoring-node MODULE authoring_node_addon.cpp)
    target_compile_features(noveltea-authoring-node PRIVATE cxx_std_20)
    target_include_directories(noveltea-authoring-node SYSTEM PRIVATE
        "${NOVELTEA_NODE_API_INCLUDE_DIR}" "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-authoring-node PRIVATE noveltea_project_authoring_session)
    set_target_properties(noveltea-authoring-node PROPERTIES
        PREFIX "" SUFFIX ".node" OUTPUT_NAME "noveltea-authoring-node")
    if(APPLE)
        target_link_options(noveltea-authoring-node PRIVATE "-undefined" "dynamic_lookup")
    elseif(WIN32)
        set(NOVELTEA_NODE_API_IMPORT_LIBRARY "" CACHE FILEPATH
            "Node-API import library matching the target Electron host")
        if(NOT EXISTS "${NOVELTEA_NODE_API_IMPORT_LIBRARY}")
            message(FATAL_ERROR "Windows Node-API addon requires its matching Electron import library")
        endif()
        target_link_libraries(noveltea-authoring-node PRIVATE "${NOVELTEA_NODE_API_IMPORT_LIBRARY}")
    endif()
    if(BUILD_TESTING)
        find_program(NOVELTEA_AUTHORING_NODE NAMES node REQUIRED)
        add_test(NAME native_authoring_material_differential
            COMMAND "${NOVELTEA_AUTHORING_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-materials.mjs"
                "$<TARGET_FILE:noveltea-authoring-node>"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    endif()
endif()
# Deliberately no engine/player link or install rule: this is a certification-only host library.
add_executable(noveltea-schema-certify certify.cpp types_compile.cpp)
target_link_libraries(noveltea-schema-certify PRIVATE noveltea_project_authoring_contracts)
if(BUILD_TESTING)
    add_test(NAME native_authoring_contracts COMMAND noveltea-schema-certify --self-test)
    find_program(NOVELTEA_AUTHORING_TEST_NODE NAMES node)
    add_executable(noveltea-flow-certify flow_certify.cpp)
    target_include_directories(noveltea-flow-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-flow-certify PRIVATE noveltea_project_authoring_contracts)
    add_test(NAME native_authoring_flow_operations COMMAND noveltea-flow-certify --self-test)
    if(NOVELTEA_AUTHORING_TEST_NODE)
        add_test(NAME native_authoring_flow
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-flow.mjs"
                "$<TARGET_FILE:noveltea-flow-certify>")
        add_test(NAME native_authoring_flow_contract_generation
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/generate-native-schema.mjs"
                --check)
    endif()
    add_executable(noveltea-flow-session-certify flow_session_certify.cpp)
    target_include_directories(noveltea-flow-session-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-flow-session-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_flow_session COMMAND noveltea-flow-session-certify
        "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-dialogue-scene-certify dialogue_scene_certify.cpp)
    target_include_directories(noveltea-dialogue-scene-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-dialogue-scene-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_dialogue_scene COMMAND noveltea-dialogue-scene-certify
        "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    if(NOVELTEA_AUTHORING_TEST_NODE)
        add_test(NAME native_authoring_dialogue_scene_differential
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-dialogue-scenes.mjs"
                "$<TARGET_FILE:noveltea-dialogue-scene-certify>"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    endif()
    add_executable(noveltea-yaml-certify yaml_certify.cpp)
    target_include_directories(noveltea-yaml-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-yaml-certify PRIVATE noveltea_project_authoring_yaml)
    add_test(NAME native_authoring_yaml COMMAND noveltea-yaml-certify)
    add_executable(noveltea-room-session-certify room_session_certify.cpp)
    target_include_directories(noveltea-room-session-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-room-session-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_room_session COMMAND noveltea-room-session-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-room-map-certify room_map_certify.cpp)
    target_include_directories(noveltea-room-map-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-room-map-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_room_map COMMAND noveltea-room-map-certify --self-test)
    add_executable(noveltea-project-session-certify project_session_certify.cpp)
    target_include_directories(noveltea-project-session-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-project-session-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_project_session COMMAND noveltea-project-session-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_test(NAME native_authoring_source_analysis COMMAND noveltea-project-session-certify
        --source-analysis "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_test(NAME native_authoring_project_validation COMMAND noveltea-project-session-certify
        --project-validation "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_test(NAME native_authoring_clean_cache_recovery COMMAND noveltea-project-session-certify
        --clean-cache-recovery "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    if(NOVELTEA_AUTHORING_TEST_NODE)
        add_test(NAME native_authoring_project_record_differential
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-project-records.mjs"
                "$<TARGET_FILE:noveltea-project-session-certify>"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    endif()
    add_test(NAME native_authoring_working_preparation COMMAND noveltea-project-session-certify
        --working-preparation "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-character-archetype-certify character_archetype_certify.cpp)
    target_include_directories(noveltea-character-archetype-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-character-archetype-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_character_archetype COMMAND noveltea-character-archetype-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-asset-animation-certify asset_animation_certify.cpp)
    target_include_directories(noveltea-asset-animation-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-asset-animation-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_asset_animation COMMAND noveltea-asset-animation-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-material-certify material_certify.cpp)
    target_include_directories(noveltea-material-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-material-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_material COMMAND noveltea-material-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-interactable-inventory-certify interactable_inventory_certify.cpp)
    target_include_directories(noveltea-interactable-inventory-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-interactable-inventory-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_interactable_inventory COMMAND noveltea-interactable-inventory-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-verb-interaction-certify verb_interaction_certify.cpp)
    target_include_directories(noveltea-verb-interaction-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-verb-interaction-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_verb_interaction COMMAND noveltea-verb-interaction-certify
        "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-test-certify test_certify.cpp)
    target_include_directories(noveltea-test-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-test-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_tests COMMAND noveltea-test-certify
        "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-localization-certify localization_certify.cpp)
    target_include_directories(noveltea-localization-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-localization-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_localization COMMAND noveltea-localization-certify
        "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    if(NOVELTEA_AUTHORING_TEST_NODE)
        add_test(NAME native_authoring_tests_differential
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-tests.mjs"
                "$<TARGET_FILE:noveltea-test-certify>"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    endif()
    if(NOVELTEA_AUTHORING_TEST_NODE)
        add_test(NAME native_authoring_verb_interaction_differential
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-verbs-interactions.mjs"
                "$<TARGET_FILE:noveltea-verb-interaction-certify>"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    endif()
    if(NOVELTEA_AUTHORING_TEST_NODE)
        add_test(NAME native_authoring_interactable_differential
            COMMAND "${NOVELTEA_AUTHORING_TEST_NODE}"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../editor/scripts/certify-native-interactables.mjs"
                "$<TARGET_FILE:noveltea-interactable-inventory-certify>"
                "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    endif()
    add_executable(noveltea-layout-certify layout_certify.cpp)
    target_include_directories(noveltea-layout-certify SYSTEM PRIVATE "${noveltea_jsoncons_SOURCE_DIR}/include")
    target_link_libraries(noveltea-layout-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_layout COMMAND noveltea-layout-certify "${CMAKE_CURRENT_SOURCE_DIR}/../../tests/projects/feature-lab")
    add_executable(noveltea-yaml-transaction-certify yaml_transaction_certify.cpp)
    target_link_libraries(noveltea-yaml-transaction-certify PRIVATE noveltea_project_authoring_session)
    add_test(NAME native_authoring_yaml_transaction COMMAND noveltea-yaml-transaction-certify)
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
