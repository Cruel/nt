if(NOT DEFINED SOURCE_DIR)
    message(FATAL_ERROR "SOURCE_DIR is required")
endif()

function(assert_file_contains path pattern description)
    file(READ "${SOURCE_DIR}/${path}" contents)
    if(NOT contents MATCHES "${pattern}")
        message(FATAL_ERROR "${description}: ${path}")
    endif()
endfunction()

file(GLOB_RECURSE production_candidates
    LIST_DIRECTORIES false
    "${SOURCE_DIR}/engine/*.cpp"
    "${SOURCE_DIR}/engine/*.hpp"
    "${SOURCE_DIR}/engine/*.h"
    "${SOURCE_DIR}/apps/*.cpp"
    "${SOURCE_DIR}/apps/*.hpp")

set(raw_publication_tokens
    stage_candidate_leases_on_owner
    commit_candidate_leases_on_owner
    rollback_candidate_leases_on_owner
    clear_previous_published_leases_on_owner
    clear_published_leases_on_owner
    stage_focused_candidate_leases_on_owner
    commit_focused_candidate_leases_on_owner
    rollback_focused_candidate_leases_on_owner
    clear_focused_published_leases_on_owner)

foreach(absolute_path IN LISTS production_candidates)
    file(RELATIVE_PATH relative_path "${SOURCE_DIR}" "${absolute_path}")
    if(relative_path MATCHES "(^|/)(tests?|fixtures?|generated|build)(/|$)")
        continue()
    endif()
    file(READ "${absolute_path}" contents)

    if(contents MATCHES "retry_deferred_asset_requests_on_owner|retry_mandatory_assets")
        message(FATAL_ERROR
            "consumer-triggered mandatory retry escape hatch is forbidden: ${relative_path}")
    endif()
    if(contents MATCHES
       "install_texture_preparation_requirements_on_owner|texture_preparation_requirements")
        message(FATAL_ERROR
            "generation-scoped texture preparation requirement registry is forbidden: ${relative_path}")
    endif()

    if(NOT relative_path STREQUAL "engine/include/noveltea/assets/asset_manager.hpp" AND
       NOT relative_path STREQUAL "engine/src/assets/asset_manager.cpp" AND
       NOT relative_path STREQUAL "engine/src/assets/mandatory_asset_gate.cpp")
        foreach(token IN LISTS raw_publication_tokens)
            if(contents MATCHES "${token}")
                message(FATAL_ERROR
                    "raw mandatory publication slot choreography escaped the shared scope: ${relative_path} (${token})")
            endif()
        endforeach()
    endif()
endforeach()

assert_file_contains(
    engine/src/runtime_presentation_bridge.cpp
    "take_ready_transaction_on_owner"
    "runtime presentation must consume the shared mandatory publication transaction")
assert_file_contains(
    engine/src/host/focused_preview_presenter.hpp
    "MandatoryPublicationScope"
    "focused preview must own an independent shared mandatory publication scope")
assert_file_contains(
    engine/src/host/focused_preview_presenter.cpp
    "AssetLeaseLookupScope::FocusedPreview"
    "focused preview realization must use the focused publication lookup scope")
assert_file_contains(
    engine/src/assets/asset_manager.cpp
    "scope == AssetLeaseLookupScope::FocusedPreview"
    "mandatory lease lookup must remain publication-scope aware")
assert_file_contains(
    engine/src/engine.cpp
    "m_asset_progress\\.service_owner_frame"
    "engine owner frames must service shared asset progress")

message(STATUS "NovelTea asset lifecycle boundary policy passed")
