#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace noveltea::cli {
// Read-only projection of the canonical Story and native-admitted Project.
nlohmann::ordered_json narrative_coverage(const std::filesystem::path& story_root,
                                          const std::filesystem::path& project_root,
                                          const std::vector<std::filesystem::path>& test_reports);
} // namespace noveltea::cli
