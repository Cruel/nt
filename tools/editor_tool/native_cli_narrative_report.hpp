#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
// Present an already analyzed validation/readiness envelope without changing its verdict.
std::string narrative_result_message(const nlohmann::ordered_json& result);
void compact_narrative_result(nlohmann::ordered_json& result);
} // namespace noveltea::cli
