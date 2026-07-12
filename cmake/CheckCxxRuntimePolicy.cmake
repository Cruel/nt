cmake_minimum_required(VERSION 3.24)

if(NOT DEFINED SOURCE_ROOT OR NOT DEFINED ALLOWLIST)
    message(FATAL_ERROR "SOURCE_ROOT and ALLOWLIST are required")
endif()

file(STRINGS "${ALLOWLIST}" allowed REGEX "^[^#].+")
file(GLOB_RECURSE sources
    "${SOURCE_ROOT}/engine/*.cpp" "${SOURCE_ROOT}/engine/*.h" "${SOURCE_ROOT}/engine/*.hpp"
    "${SOURCE_ROOT}/apps/*.cpp" "${SOURCE_ROOT}/apps/*.h" "${SOURCE_ROOT}/apps/*.hpp"
    "${SOURCE_ROOT}/tools/*.cpp" "${SOURCE_ROOT}/tools/*.h" "${SOURCE_ROOT}/tools/*.hpp")

set(rule_names
    exception-syntax
    compiler-rtti
    container-at
    throwing-number-conversion
    filesystem-operation
    unsafe-json-get
    unsafe-json-value)
set(rule_patterns
    "(^|[^A-Za-z0-9_])(throw|try|catch)([^A-Za-z0-9_]|$)"
    "(^|[^A-Za-z0-9_])(dynamic_cast|typeid|std::type_info|std::type_index)([^A-Za-z0-9_]|$)"
    "\\.at[ \\t]*\\("
    "(^|[^A-Za-z0-9_])std::(stoi|stol|stoll|stoul|stoull|stof|stod|stold)[ \\t]*\\("
    "std::filesystem::(canonical|copy|copy_file|create_directories|create_directory|current_path|directory_iterator|equivalent|exists|file_size|is_directory|is_regular_file|last_write_time|permissions|read_symlink|recursive_directory_iterator|relative|remove|remove_all|rename|space|status|symlink_status|temp_directory_path|weakly_canonical)[ \\t]*\\("
    "\\.get[ \\t]*<"
    "\\.value[ \\t]*\\(")

set(failures "")
foreach(source IN LISTS sources)
    file(RELATIVE_PATH relative "${SOURCE_ROOT}" "${source}")
    file(STRINGS "${source}" lines)
    set(line_number 0)
    foreach(line IN LISTS lines)
        math(EXPR line_number "${line_number} + 1")
        foreach(rule_index RANGE 0 6)
            list(GET rule_names ${rule_index} rule_name)
            list(GET rule_patterns ${rule_index} rule_pattern)
            if(line MATCHES "${rule_pattern}")
                string(MAKE_C_IDENTIFIER "${relative}_${rule_name}" count_key)
                if(DEFINED count_${count_key})
                    math(EXPR count_${count_key} "${count_${count_key}} + 1")
                else()
                    set(count_${count_key} 1)
                    list(APPEND observed_keys "${relative}|${rule_name}|${count_key}")
                endif()
            endif()
        endforeach()
    endforeach()
endforeach()

foreach(observed IN LISTS observed_keys)
    string(REPLACE "|" ";" fields "${observed}")
    list(GET fields 0 relative)
    list(GET fields 1 rule_name)
    list(GET fields 2 count_key)
    set(actual "${count_${count_key}}")
    set(allowed_count 0)
    foreach(entry IN LISTS allowed)
        string(REGEX REPLACE "[ \t]+#.*$" "" entry_without_comment "${entry}")
        string(REPLACE "|" ";" allow_fields "${entry_without_comment}")
        list(LENGTH allow_fields allow_length)
        if(allow_length EQUAL 3)
            list(GET allow_fields 0 allow_path)
            list(GET allow_fields 1 allow_rule)
            list(GET allow_fields 2 allow_count)
            if(allow_path STREQUAL relative AND allow_rule STREQUAL rule_name)
                set(allowed_count "${allow_count}")
            endif()
        endif()
    endforeach()
    if(actual GREATER allowed_count)
        string(APPEND failures "\n  ${relative}|${rule_name}: ${actual} observed, ${allowed_count} allowed")
    endif()
endforeach()

if(failures)
    message(FATAL_ERROR "C++ runtime policy violations:${failures}")
endif()
