#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <nlohmann/json_fwd.hpp>

#include <string>
#include <string_view>

namespace noveltea::core {

// Strictly decodes and semantically links noveltea.compiled.project format version 1. The input
// JSON is a boundary value only and is never retained by the returned project.
[[nodiscard]] Result<CompiledProject, Diagnostics>
decode_compiled_project(const nlohmann::json& document, std::string source_path = {});

// Owns JSON parsing as well as strict schema decoding. Runtime/host callers should prefer this
// serialized-data seam so the JSON DOM remains an implementation detail of the content codec.
[[nodiscard]] Result<CompiledProject, Diagnostics>
decode_compiled_project_json(std::string_view text, std::string source_path = {});

} // namespace noveltea::core
