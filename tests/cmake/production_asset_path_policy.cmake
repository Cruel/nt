if(NOT DEFINED SOURCE_DIR)
    message(FATAL_ERROR "SOURCE_DIR is required")
endif()

function(assert_file_lacks path pattern description)
    file(READ "${SOURCE_DIR}/${path}" contents)
    if(contents MATCHES "${pattern}")
        message(FATAL_ERROR "${description}: ${path}")
    endif()
endfunction()

function(assert_file_contains path pattern description)
    file(READ "${SOURCE_DIR}/${path}" contents)
    if(NOT contents MATCHES "${pattern}")
        message(FATAL_ERROR "${description}: ${path}")
    endif()
endfunction()

set(asset_manager_files
    engine/include/noveltea/assets/asset_manager.hpp
    engine/src/assets/asset_manager.cpp)
foreach(path IN LISTS asset_manager_files)
    assert_file_lacks(
        "${path}"
        "(AssetManager::)?load_(font|texture|shader_program|material|audio)(_alias)?[ \t\r\n]*\\("
        "synchronous prepared AssetManager facade must remain deleted")
endforeach()

assert_file_lacks(
    engine/include/noveltea/audio/audio_system.hpp
    "play[ \t\r\n]*\\([ \t\r\n]*AudioClipHandle|play_sfx|play_track_alias|play_sfx_alias|play_track[ \t\r\n]*\\([^;]*const std::string&[ \t\r\n]+path"
    "AudioSystem must expose only lease-backed prepared playback")

set(lease_only_consumers
    engine/src/world_presentation.cpp
    engine/src/render/bgfx/bgfx_material_binder.cpp
    engine/src/ui/rmlui/active_text_presenter.cpp
    engine/src/runtime_audio_adapter.cpp
    engine/src/host/audio_preview_adapter.cpp)
foreach(path IN LISTS lease_only_consumers)
    assert_file_lacks(
        "${path}"
        "\\.load_(font|texture|shader_program|material|audio)(_alias)?[ \t\r\n]*\\("
        "production prepared consumer must not synchronously load through AssetManager")
endforeach()

assert_file_contains(
    engine/src/world_presentation.cpp
    "leased_texture_on_owner"
    "world presentation must realize textures from published leases")
assert_file_contains(
    engine/src/render/bgfx/bgfx_material_binder.cpp
    "leased_shader_program_on_owner"
    "material binding must realize shader programs from published leases")
assert_file_contains(
    engine/src/ui/rmlui/active_text_presenter.cpp
    "request_font"
    "ActiveText must use the asynchronous font request path")
assert_file_contains(
    engine/src/runtime_audio_adapter.cpp
    "leased_audio_on_owner"
    "runtime audio must consume mandatory published leases")
assert_file_contains(
    engine/src/host/audio_preview_adapter.cpp
    "request_audio"
    "editor preview audio must use asynchronous demand requests")
assert_file_lacks(
    apps/sandbox/sandbox_app.cpp
    "EngineTooling::renderer[^\n]*set_postprocess_material"
    "sandbox postprocess tooling must not bypass asynchronous asset preparation")
assert_file_contains(
    engine/src/engine.cpp
    "MandatoryAssetRequestGroup"
    "tooling postprocess materials must use the asynchronous mandatory request path")
assert_file_contains(
    engine/src/engine.cpp
    "set_supplemental_leases_on_owner"
    "tooling postprocess resources must retain a lease set while the renderer uses them")

file(GLOB_RECURSE production_candidates
    LIST_DIRECTORIES false
    "${SOURCE_DIR}/engine/*.cpp"
    "${SOURCE_DIR}/engine/*.hpp"
    "${SOURCE_DIR}/engine/*.h"
    "${SOURCE_DIR}/apps/*.cpp"
    "${SOURCE_DIR}/apps/*.hpp"
    "${SOURCE_DIR}/web/*.js"
    "${SOURCE_DIR}/web/*.mjs"
    "${SOURCE_DIR}/web/*.ts"
    "${SOURCE_DIR}/editor/src/*.ts"
    "${SOURCE_DIR}/editor/src/*.tsx")

foreach(absolute_path IN LISTS production_candidates)
    file(RELATIVE_PATH relative_path "${SOURCE_DIR}" "${absolute_path}")
    if(relative_path MATCHES "(^|/)(tests?|fixtures?|generated|dist-electron|node_modules|build)(/|$)")
        continue()
    endif()

    file(READ "${absolute_path}" contents)
    if(contents MATCHES "NOVELTEA_WEB_THREADS")
        message(FATAL_ERROR "stale NOVELTEA_WEB_THREADS symbol: ${relative_path}")
    endif()
    if(contents MATCHES "FS\\.writeFile[^\n]*(\\.ntpkg|package)")
        message(FATAL_ERROR "compiled package must not be copied into Web VFS: ${relative_path}")
    endif()
    if(contents MATCHES "MemoryAssetSource" AND
       NOT relative_path STREQUAL "engine/include/noveltea/assets/asset_source.hpp" AND
       NOT relative_path STREQUAL "engine/src/assets/asset_manager.cpp")
        message(FATAL_ERROR
            "production package/runtime path must not materialize through MemoryAssetSource: ${relative_path}")
    endif()
endforeach()

message(STATUS "NovelTea production asset-path policy passed")
