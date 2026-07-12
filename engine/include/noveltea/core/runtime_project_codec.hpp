#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_project.hpp"

#include <nlohmann/json_fwd.hpp>

namespace noveltea::core {

using RuntimeProjectDecodeResult = Result<RuntimeProject, Diagnostics>;

[[nodiscard]] RuntimeProjectDecodeResult decode_runtime_project(const nlohmann::json& document);

} // namespace noveltea::core
