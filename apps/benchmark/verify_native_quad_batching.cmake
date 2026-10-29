# Verify that the production Renderer actually combines its consecutive quad commands.
# Keep this independent of renderer internals: the benchmark captures bgfx's draw count.
if(NOT DEFINED REPORT OR NOT EXISTS "${REPORT}")
    message(FATAL_ERROR "Native quad batching benchmark report is missing: ${REPORT}")
endif()
file(READ "${REPORT}" report)
string(JSON scenario_id ERROR_VARIABLE error GET "${report}" scenarios 0 id)
if(error OR NOT scenario_id STREQUAL "native-2d-geometry")
    message(FATAL_ERROR "Unexpected native quad batching report scenario: ${error}")
endif()
string(JSON outcome ERROR_VARIABLE error GET "${report}" scenarios 0 outcome)
if(error OR NOT outcome STREQUAL "complete")
    message(FATAL_ERROR "Native quad batching report did not complete: ${error}")
endif()
string(JSON submitted_quads ERROR_VARIABLE error GET "${report}"
    configuration parameters geometry_quads)
if(error OR NOT submitted_quads EQUAL 256)
    message(FATAL_ERROR "Native quad batching fixture changed its quad count: ${error}")
endif()
string(JSON draw_calls ERROR_VARIABLE error GET "${report}"
    scenarios 0 trials 0 diagnostic draw_calls max)
if(error OR draw_calls GREATER_EQUAL 128 OR draw_calls LESS 1)
    message(FATAL_ERROR
        "Native quad batching regressed: expected <128 GPU draws for 256 identical-state "
        "quads, found ${draw_calls} (${error})")
endif()
message(STATUS "Native quad batching verified: ${submitted_quads} quads, ${draw_calls} GPU draws")
