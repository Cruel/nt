include_guard(GLOBAL)

include("${CMAKE_SOURCE_DIR}/cmake/NovelTeaModuleFileClassification.cmake")

function(noveltea_public_header_probe_sources out_var module)
    set(options)
    set(multi_value_args HEADERS)
    cmake_parse_arguments(PARSE_ARGV 2 PROBE "${options}" "" "${multi_value_args}")

    set(_probe_sources)
    set(_probe_dir "${CMAKE_BINARY_DIR}/public-header-probes/${module}")

    if(PROBE_HEADERS)
        set(_headers ${PROBE_HEADERS})
    else()
        foreach(_path IN LISTS NOVELTEA_MODULE_FILES_${module})
            if(_path MATCHES "^engine/include/(.+)$")
                list(APPEND _headers "${CMAKE_MATCH_1}")
            endif()
        endforeach()
    endif()

    foreach(_header IN LISTS _headers)
        if(NOT _header MATCHES "^noveltea/")
            message(FATAL_ERROR "Invalid public-header probe path for ${module}: ${_header}")
        endif()
        string(MAKE_C_IDENTIFIER "${_header}" _source_name)
        set(_source "${_probe_dir}/${_source_name}.cpp")
        file(GENERATE OUTPUT "${_source}" CONTENT
            "#include <${_header}>\n#include \"public_header_probe_guard.hpp\"\n")
        list(APPEND _probe_sources "${_source}")
    endforeach()

    if(NOT _probe_sources)
        message(FATAL_ERROR "No public headers were classified for ${module}")
    endif()

    set(${out_var} "${_probe_sources}" PARENT_SCOPE)
endfunction()

function(noveltea_add_public_header_probe module)
    set(options)
    set(one_value_args EXTRA_SOURCE)
    set(multi_value_args HEADERS)
    cmake_parse_arguments(PARSE_ARGV 1 PROBE "${options}" "${one_value_args}"
        "${multi_value_args}")

    noveltea_public_header_probe_sources(_probe_sources "${module}" HEADERS ${PROBE_HEADERS})
    if(PROBE_EXTRA_SOURCE)
        list(APPEND _probe_sources "${PROBE_EXTRA_SOURCE}")
    endif()

    set(_target "${module}_public_header_probe")
    add_library(${_target} OBJECT ${_probe_sources})
    target_link_libraries(${_target} PRIVATE ${module})
    target_include_directories(${_target} PRIVATE
        "${CMAKE_SOURCE_DIR}/tests/public_headers")
    target_compile_features(${_target} PRIVATE cxx_std_20)
    noveltea_apply_runtime_compiler_policy(${_target})
    noveltea_apply_policy_warnings(${_target})
    set(${module}_PUBLIC_HEADER_PROBE_TARGET "${_target}" PARENT_SCOPE)
endfunction()

function(noveltea_add_public_header_probes)
    noveltea_add_public_header_probe(noveltea_domain)
    # JSON codec/adapter headers remain source-facing content boundaries and intentionally require
    # the private nlohmann-json implementation dependency. The dependency-clean content consumer
    # surface is the package/model/bootstrap/shader contract set below; Phase 6 owns any later
    # public-surface cleanup of the JSON boundary headers.
    noveltea_add_public_header_probe(noveltea_content HEADERS
        noveltea/core/compiled_package.hpp
        noveltea/core/editor_preview_contracts.hpp
        noveltea/core/player_bootstrap.hpp
        noveltea/render/shader_compiler.hpp
        noveltea/render/shader_manifest.hpp)
    noveltea_add_public_header_probe(noveltea_runtime
        EXTRA_SOURCE "${CMAKE_SOURCE_DIR}/tests/public_headers/runtime_fake_ports.cpp")
    noveltea_add_public_header_probe(noveltea_presentation)
    noveltea_add_public_header_probe(noveltea_script_lua)

    add_library(noveltea_engine_facade_public_header_probe OBJECT
        "${CMAKE_SOURCE_DIR}/tests/public_headers/engine_facade.cpp")
    target_link_libraries(noveltea_engine_facade_public_header_probe PRIVATE noveltea_engine)
    target_include_directories(noveltea_engine_facade_public_header_probe PRIVATE
        "${CMAKE_SOURCE_DIR}/tests/public_headers")
    target_compile_features(noveltea_engine_facade_public_header_probe PRIVATE cxx_std_20)
    noveltea_apply_runtime_compiler_policy(noveltea_engine_facade_public_header_probe)
    noveltea_apply_policy_warnings(noveltea_engine_facade_public_header_probe)

    add_custom_target(public-header-probes DEPENDS
        ${noveltea_domain_PUBLIC_HEADER_PROBE_TARGET}
        ${noveltea_content_PUBLIC_HEADER_PROBE_TARGET}
        ${noveltea_runtime_PUBLIC_HEADER_PROBE_TARGET}
        ${noveltea_presentation_PUBLIC_HEADER_PROBE_TARGET}
        ${noveltea_script_lua_PUBLIC_HEADER_PROBE_TARGET}
        noveltea_engine_facade_public_header_probe)
endfunction()
