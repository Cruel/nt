include_guard(GLOBAL)

function(_noveltea_collect_buildsystem_targets directory output_var)
    get_property(_directory_targets DIRECTORY "${directory}" PROPERTY BUILDSYSTEM_TARGETS)
    get_property(_subdirectories DIRECTORY "${directory}" PROPERTY SUBDIRECTORIES)

    set(_targets ${_directory_targets})
    foreach(_subdirectory IN LISTS _subdirectories)
        _noveltea_collect_buildsystem_targets("${_subdirectory}" _child_targets)
        list(APPEND _targets ${_child_targets})
    endforeach()

    set(${output_var} "${_targets}" PARENT_SCOPE)
endfunction()

function(_noveltea_normalize_inventory_values output_var)
    set(_normalized_values)
    foreach(_value IN LISTS ARGN)
        if(_value MATCHES "^::@")
            continue()
        endif()

        string(REPLACE "${CMAKE_BINARY_DIR}" "<build>" _value "${_value}")
        string(REPLACE "${CMAKE_SOURCE_DIR}" "<source>" _value "${_value}")
        list(APPEND _normalized_values "${_value}")
    endforeach()

    list(REMOVE_DUPLICATES _normalized_values)
    list(SORT _normalized_values)
    set(${output_var} "${_normalized_values}" PARENT_SCOPE)
endfunction()

function(_noveltea_normalize_inventory_source
        source target_source_dir output_var first_party_output_var)
    set(_is_first_party FALSE)
    if(source MATCHES "^\\$<")
        set(_normalized_source "${source}")
    elseif(IS_ABSOLUTE "${source}")
        set(_absolute_source "${source}")
    else()
        cmake_path(ABSOLUTE_PATH source
            BASE_DIRECTORY "${target_source_dir}"
            NORMALIZE
            OUTPUT_VARIABLE _absolute_source)
    endif()

    if(DEFINED _absolute_source)
        file(RELATIVE_PATH _build_relative "${CMAKE_BINARY_DIR}" "${_absolute_source}")
        if(NOT _build_relative MATCHES "^\\.\\.")
            set(_normalized_source "<build>/${_build_relative}")
        else()
            file(RELATIVE_PATH _source_relative "${CMAKE_SOURCE_DIR}" "${_absolute_source}")
            if(NOT _source_relative MATCHES "^\\.\\.")
                set(_normalized_source "${_source_relative}")
                if(NOT _source_relative MATCHES
                        "^(build|refs|rmlui-bgfx|vcpkg_installed)(/|$)")
                    set(_is_first_party TRUE)
                endif()
            else()
                set(_normalized_source "${_absolute_source}")
            endif()
        endif()
    endif()

    set(${output_var} "${_normalized_source}" PARENT_SCOPE)
    set(${first_party_output_var} "${_is_first_party}" PARENT_SCOPE)
endfunction()

function(noveltea_add_module_dependency_inventory)
    set(_options)
    set(_one_value_args OUTPUT)
    set(_multi_value_args)
    cmake_parse_arguments(PARSE_ARGV 0 INVENTORY
        "${_options}" "${_one_value_args}" "${_multi_value_args}")

    if(NOT INVENTORY_OUTPUT)
        message(FATAL_ERROR "noveltea_add_module_dependency_inventory requires OUTPUT")
    endif()

    _noveltea_collect_buildsystem_targets("${CMAKE_SOURCE_DIR}" _all_targets)
    list(REMOVE_DUPLICATES _all_targets)
    list(SORT _all_targets)

    set(_report "format: noveltea.module-dependency-inventory.v1\n")
    string(APPEND _report "system: ${CMAKE_SYSTEM_NAME}\n")
    string(APPEND _report "processor: ${CMAKE_SYSTEM_PROCESSOR}\n")
    string(APPEND _report "build_type: ${CMAKE_BUILD_TYPE}\n")
    string(APPEND _report "devtools: ${NOVELTEA_ENABLE_DEVTOOLS}\n")
    string(APPEND _report "source_root: <source>\n")
    string(APPEND _report "build_root: <build>\n")

    foreach(_target IN LISTS _all_targets)
        get_target_property(_target_type "${_target}" TYPE)
        if(NOT _target_type MATCHES
                "^(EXECUTABLE|STATIC_LIBRARY|SHARED_LIBRARY|MODULE_LIBRARY|OBJECT_LIBRARY|INTERFACE_LIBRARY)$")
            continue()
        endif()

        get_target_property(_target_source_dir "${_target}" SOURCE_DIR)
        if(NOT _target_source_dir OR _target_source_dir MATCHES "-NOTFOUND$")
            continue()
        endif()

        file(RELATIVE_PATH _target_build_relative
            "${CMAKE_BINARY_DIR}" "${_target_source_dir}")
        if(NOT _target_build_relative MATCHES "^\\.\\.")
            continue()
        endif()

        file(RELATIVE_PATH _target_source_relative
            "${CMAKE_SOURCE_DIR}" "${_target_source_dir}")
        if(_target_source_relative MATCHES "^\\.\\."
                OR _target_source_relative MATCHES
                    "^(refs|rmlui-bgfx|vcpkg_installed)(/|$)")
            continue()
        endif()
        if(_target_source_relative STREQUAL "")
            set(_target_source_relative ".")
        endif()

        get_target_property(_target_sources "${_target}" SOURCES)
        set(_normalized_sources)
        set(_has_first_party_source FALSE)
        if(_target_sources AND NOT _target_sources MATCHES "-NOTFOUND$")
            foreach(_source IN LISTS _target_sources)
                _noveltea_normalize_inventory_source(
                    "${_source}" "${_target_source_dir}"
                    _normalized_source _source_is_first_party)
                list(APPEND _normalized_sources "${_normalized_source}")
                if(_source_is_first_party)
                    set(_has_first_party_source TRUE)
                endif()
            endforeach()
        endif()
        if(NOT _has_first_party_source)
            continue()
        endif()

        list(REMOVE_DUPLICATES _normalized_sources)
        list(SORT _normalized_sources)

        string(APPEND _report "\n[target ${_target}]\n")
        string(APPEND _report "type: ${_target_type}\n")
        string(APPEND _report "source_dir: ${_target_source_relative}\n")
        string(APPEND _report "sources:\n")
        if(_normalized_sources)
            foreach(_source IN LISTS _normalized_sources)
                string(APPEND _report "  - ${_source}\n")
            endforeach()
        else()
            string(APPEND _report "  - (none)\n")
        endif()

        foreach(_property IN ITEMS
                LINK_LIBRARIES
                INTERFACE_LINK_LIBRARIES
                INCLUDE_DIRECTORIES
                INTERFACE_INCLUDE_DIRECTORIES
                COMPILE_DEFINITIONS
                INTERFACE_COMPILE_DEFINITIONS)
            get_target_property(_property_values "${_target}" "${_property}")
            if(NOT _property_values OR _property_values MATCHES "-NOTFOUND$")
                set(_property_values)
            endif()
            _noveltea_normalize_inventory_values(
                _normalized_property_values ${_property_values})
            string(TOLOWER "${_property}" _property_label)
            string(APPEND _report "${_property_label}:\n")
            if(_normalized_property_values)
                foreach(_value IN LISTS _normalized_property_values)
                    string(APPEND _report "  - ${_value}\n")
                endforeach()
            else()
                string(APPEND _report "  - (none)\n")
            endif()
        endforeach()
    endforeach()

    get_filename_component(_output_directory "${INVENTORY_OUTPUT}" DIRECTORY)
    file(MAKE_DIRECTORY "${_output_directory}")
    file(WRITE "${INVENTORY_OUTPUT}" "${_report}")

    add_custom_target(module-dependency-inventory
        COMMAND "${CMAKE_COMMAND}" -E cat "${INVENTORY_OUTPUT}"
        COMMENT "Displaying configured NovelTea source-to-target dependency inventory"
        VERBATIM)
endfunction()
