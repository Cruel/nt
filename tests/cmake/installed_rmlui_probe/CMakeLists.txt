cmake_minimum_required(VERSION 3.24)
project(noveltea_installed_rmlui_probe LANGUAGES CXX)

if(NOT DEFINED NOVELTEA_SOURCE_DIR)
    message(FATAL_ERROR "NOVELTEA_SOURCE_DIR is required")
endif()
if(NOT DEFINED NOVELTEA_FAKE_RMLUI_PATCH_REVISION)
    set(NOVELTEA_FAKE_RMLUI_PATCH_REVISION "6c-feature-calc-lua-listener-state-1")
endif()

configure_file(
    "${CMAKE_CURRENT_LIST_DIR}/include/RmlUi/Core/NovelTeaPatch.h.in"
    "${CMAKE_CURRENT_BINARY_DIR}/include/RmlUi/Core/NovelTeaPatch.h"
    @ONLY)

add_library(RmlUi::Core INTERFACE IMPORTED GLOBAL)
set_target_properties(RmlUi::Core PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES
        "${CMAKE_CURRENT_BINARY_DIR}/include;${CMAKE_CURRENT_LIST_DIR}/include")

list(APPEND CMAKE_MODULE_PATH "${NOVELTEA_SOURCE_DIR}/cmake")
include(NovelTeaRmlUi)

_noveltea_verify_installed_rmlui_extension_api()
