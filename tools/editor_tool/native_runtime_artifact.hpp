#pragma once

#include <nlohmann/json.hpp>

#include <string>

namespace noveltea::cli {

// Assemble an artifact from exactly one native-admitted Project and its freshly
// compiled wire. No filesystem reads, shader compilation or cache publication
// occur at this boundary; physical preparation is owned by the next stage.
// Failure returns diagnostics without a partially usable artifact.
[[nodiscard]] nlohmann::json prepare_native_runtime_artifact(
    const nlohmann::json& project, const nlohmann::json& compiled_project,
    const nlohmann::json& referenced_asset_ids, const nlohmann::json& profile,
    const nlohmann::json& effective_materials, const std::string& project_root = {},
    const nlohmann::json& recovery = nullptr);

} // namespace noveltea::cli
