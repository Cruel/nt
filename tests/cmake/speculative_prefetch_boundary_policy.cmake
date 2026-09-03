if(NOT DEFINED SOURCE_DIR)
    message(FATAL_ERROR "SOURCE_DIR is required")
endif()

file(GLOB_RECURSE production_candidates
    LIST_DIRECTORIES false
    "${SOURCE_DIR}/engine/*.cpp"
    "${SOURCE_DIR}/engine/*.hpp"
    "${SOURCE_DIR}/engine/*.h"
    "${SOURCE_DIR}/apps/*.cpp"
    "${SOURCE_DIR}/apps/*.hpp")

set(retired_speculative_tokens
    StructuredAssetDependencyBuckets
    StructuredAssetDependencyContext
    StructuredAssetDependencyCollector
    current_mandatory
    direct_next
    adjacent_alternatives)

foreach(absolute_path IN LISTS production_candidates)
    file(RELATIVE_PATH relative_path "${SOURCE_DIR}" "${absolute_path}")
    if(relative_path MATCHES "(^|/)(tests?|fixtures?|generated|build)(/|$)")
        continue()
    endif()
    file(READ "${absolute_path}" contents)
    foreach(token IN LISTS retired_speculative_tokens)
        if(contents MATCHES "${token}")
            message(FATAL_ERROR
                "retired shallow speculative-prefetch boundary reintroduced: ${relative_path} (${token})")
        endif()
    endforeach()
endforeach()

file(READ "${SOURCE_DIR}/engine/src/assets/mandatory_asset_gate.cpp" gate_contents)
if(NOT gate_contents MATCHES "MandatoryAssetDependencyCollector")
    message(FATAL_ERROR
        "runtime mandatory publication must use the mandatory-only dependency collector")
endif()
if(NOT gate_contents MATCHES "FlowPredictor" OR
   NOT gate_contents MATCHES "resolve_flow_prediction" OR
   NOT gate_contents MATCHES "replace_generation_on_owner")
    message(FATAL_ERROR
        "runtime speculation must flow through FlowPredictor, Flow resolution, and PrefetchPlan")
endif()

message(STATUS "NovelTea speculative prefetch boundary policy passed")
