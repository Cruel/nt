# Host-only narrative CLI implementation sources. These are compiled into
# noveltea_narrative for the standalone native CLI, never into the game runtime.
# Keep this exact list shared by the build and runtime/compiler/JSON policy audits.
set(NOVELTEA_HOST_NARRATIVE_SOURCES
    tools/narrative/catalog.cpp
    tools/narrative/progression.cpp
    tools/narrative/context_manifest.cpp
    tools/narrative/readiness.cpp)

# Accept exact repository-relative paths or absolute paths ending in the same
# repository-relative source path. Do not exempt the entire tools/narrative tree.
function(noveltea_is_host_narrative_source source output)
    string(REPLACE "\\" "/" normalized_source "${source}")
    set(is_host_source FALSE)
    foreach(relative IN LISTS NOVELTEA_HOST_NARRATIVE_SOURCES)
        string(REPLACE "." "\\." escaped_relative "${relative}")
        if(normalized_source STREQUAL relative OR
           normalized_source MATCHES "/${escaped_relative}$")
            set(is_host_source TRUE)
            break()
        endif()
    endforeach()
    set(${output} "${is_host_source}" PARENT_SCOPE)
endfunction()
