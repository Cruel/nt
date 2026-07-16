#pragma once

#include "noveltea/runtime/running_game.hpp"

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

namespace noveltea::runtime {

struct RunningGameLoadInput {
    nlohmann::json gameplay;
    nlohmann::json manifest;
    std::optional<nlohmann::json> shader_materials;
    std::vector<core::RuntimePackageFile> files;
    std::string gameplay_source_path = "gameplay.json";
    std::string manifest_source_path = "manifest.json";
    std::string shader_materials_source_path = "shader-materials.json";
    std::string runtime_locale;
};

[[nodiscard]] core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game(RunningGameLoadInput input, script::ScriptRuntime& scripts,
                  PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves);

[[nodiscard]] core::Result<std::unique_ptr<RunningGame>, core::Diagnostics>
load_running_game_preview(nlohmann::json gameplay, std::optional<nlohmann::json> shader_materials,
                          script::ScriptRuntime& scripts, PresentationRuntimePort& presentation,
                          core::TypedSaveSlotStore& saves, std::string runtime_locale = {});

} // namespace noveltea::runtime
