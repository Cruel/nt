#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {
// Present an already analyzed validation/readiness envelope without changing its verdict.
std::string narrative_result_message(const nlohmann::ordered_json& result);
void compact_narrative_result(nlohmann::ordered_json& result,
                              nlohmann::ordered_json positions = nullptr);
nlohmann::ordered_json summarize_narrative_position(const nlohmann::ordered_json& coverage,
                                                    const std::string& id);
} // namespace noveltea::cli
