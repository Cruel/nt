#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <nlohmann/json_fwd.hpp>

#include <string>

namespace noveltea::core {

// Strictly decodes and semantically links noveltea.compiled.project version 1. The input JSON is a
// boundary value only and is never retained by the returned project.
[[nodiscard]] Result<CompiledProject, Diagnostics>
decode_compiled_project(const nlohmann::json& document, std::string source_path = {});

} // namespace noveltea::core
