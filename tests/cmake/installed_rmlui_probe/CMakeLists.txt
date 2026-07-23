cmake_minimum_required(VERSION 3.24)
project(noveltea_installed_rmlui_probe LANGUAGES CXX)

if(NOT DEFINED NOVELTEA_SOURCE_DIR)
    message(FATAL_ERROR "NOVELTEA_SOURCE_DIR is required")
endif()

add_library(RmlUi::Core INTERFACE IMPORTED GLOBAL)
set_target_properties(RmlUi::Core PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/include")

list(APPEND CMAKE_MODULE_PATH "${NOVELTEA_SOURCE_DIR}/cmake")
include(NovelTeaRmlUi)

_noveltea_verify_installed_rmlui_extension_api()
