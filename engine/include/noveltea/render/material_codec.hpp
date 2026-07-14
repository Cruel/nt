#pragma once

#include "noveltea/render/material.hpp"

#include <nlohmann/json_fwd.hpp>

#include <string_view>

namespace noveltea {

[[nodiscard]] ShaderMaterialProjectParseResult
parse_shader_material_project_json(std::string_view source);
[[nodiscard]] ShaderMaterialProjectParseResult
parse_shader_material_project_json_value(const nlohmann::json& value);

} // namespace noveltea
