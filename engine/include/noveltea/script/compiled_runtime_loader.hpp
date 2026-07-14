#pragma once

#include "noveltea/script/compiled_runtime.hpp"

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

namespace noveltea::script {

struct CompiledRuntimeLoadInput {
    nlohmann::json gameplay;
    nlohmann::json manifest;
    std::optional<nlohmann::json> shader_materials;
    std::vector<core::RuntimePackageFile> files;
    std::string gameplay_source_path = "gameplay.json";
    std::string manifest_source_path = "manifest.json";
    std::string shader_materials_source_path = "shader-materials.json";
    std::string runtime_locale;
};

[[nodiscard]] core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
load_compiled_runtime(CompiledRuntimeLoadInput input, ScriptRuntime& scripts,
                      core::TypedSaveSlotStore& saves);

[[nodiscard]] core::Result<std::unique_ptr<CompiledRuntime>, core::Diagnostics>
load_compiled_runtime_preview(nlohmann::json gameplay,
                              std::optional<nlohmann::json> shader_materials,
                              ScriptRuntime& scripts, core::TypedSaveSlotStore& saves,
                              std::string runtime_locale = {});

} // namespace noveltea::script
