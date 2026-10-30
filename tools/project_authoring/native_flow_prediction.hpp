#pragma once

#include <nlohmann/json.hpp>
#include <optional>

namespace noveltea::cli {
// The compiler owns prediction metadata. Engine execution never infers Flow
// topology by re-traversing raw compiled gameplay commands.
[[nodiscard]] std::optional<nlohmann::json>
compile_native_flow_prediction(const nlohmann::json& wire, const nlohmann::json& hints);
} // namespace noveltea::cli
