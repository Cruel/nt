function(noveltea_apply_runtime_compiler_policy target)
    if(MSVC)
        target_compile_options("${target}" PRIVATE /GR- /EHs-c-)
        target_compile_definitions("${target}" PRIVATE _HAS_EXCEPTIONS=0)
    else()
        target_compile_options("${target}" PRIVATE -fno-exceptions -fno-rtti)
    endif()
endfunction()

function(noveltea_apply_runtime_dependency_policy target)
    if(NOT TARGET "${target}")
        return()
    endif()

    get_target_property(_noveltea_aliased_target "${target}" ALIASED_TARGET)
    if(_noveltea_aliased_target)
        set(target "${_noveltea_aliased_target}")
    endif()

    get_target_property(_noveltea_imported "${target}" IMPORTED)
    get_target_property(_noveltea_type "${target}" TYPE)
    if(_noveltea_imported OR _noveltea_type STREQUAL "INTERFACE_LIBRARY")
        return()
    endif()

    noveltea_apply_runtime_compiler_policy("${target}")
endfunction()
function(noveltea_apply_policy_warnings target)
    if(MSVC)
        target_compile_options("${target}" PRIVATE /WX)
    else()
        target_compile_options("${target}" PRIVATE -Werror)
        if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
            # bx headers use the established GNU empty variadic-macro extension.
            # Treat this third-party header diagnostic separately from first-party warnings.
            target_compile_options("${target}" PRIVATE
                -Wno-gnu-zero-variadic-macro-arguments)
        endif()
        if(EMSCRIPTEN)
            # Emscripten emits this toolchain-owned diagnostic whenever its SDL3
            # port is enabled. This is not a first-party source warning.
            target_compile_options("${target}" PRIVATE
                -Wno-experimental)
        endif()
    endif()
endfunction()
