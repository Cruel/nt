#pragma once

#include <nlohmann/json.hpp>

namespace noveltea::cli {

// Logical Shader/Material metadata from native owner-resolved Material inputs.
// Shader compiler outputs and physical resources are attached by the next stage.
[[nodiscard]] nlohmann::json
native_runtime_material_metadata(const nlohmann::json& project,
                                 const nlohmann::json& effective_materials);

} // namespace noveltea::cli
