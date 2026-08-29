#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/compiled_package.hpp"
#include "noveltea/runtime/running_game.hpp"

#include <string>
#include <string_view>

namespace noveltea::runtime {

struct RunningGameLoadInput {
    core::LoadedCompiledPackage package;
    std::string runtime_locale;
};

struct ResolvedRunningGameSource {
    RunningGameLoadInput input;
    assets::AssetManager::NamespaceMounts project_mounts;
    bool replaces_project_namespace = false;
};

[[nodiscard]] core::Result<ResolvedRunningGameSource, core::Diagnostics>
resolve_running_game_source(assets::AssetManager& assets, std::string_view logical_path,
                            std::string runtime_locale = {});

[[nodiscard]] core::Result<ResolvedRunningGameSource, core::Diagnostics>
resolve_running_game_package_source(std::shared_ptr<assets::ZipAssetSource> package_source,
                                    std::string_view logical_path, std::string runtime_locale = {});

[[nodiscard]] core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptCertificationPort& script_certifier,
                  ScriptInvocationPort& scripts, PresentationRuntimePort& presentation,
                  core::TypedSaveSlotStore& saves);

[[nodiscard]] core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, ScriptRuntimePort& scripts,
                  PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves);

} // namespace noveltea::runtime
