#pragma once

#include "noveltea/core/compiled_package.hpp"

#include <nlohmann/json_fwd.hpp>

#include <string>

namespace noveltea::core {

[[nodiscard]] Result<RuntimePackageManifest, Diagnostics>
decode_runtime_package_manifest(const nlohmann::json& value,
                                std::string source_path = "manifest.json");

[[nodiscard]] Result<ShaderMaterialProject, Diagnostics>
decode_shader_material_manifest(const nlohmann::json& value,
                                std::string source_path = "shader-materials.json");

} // namespace noveltea::core
