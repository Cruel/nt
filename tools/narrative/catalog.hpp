#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace noveltea::narrative {
// Read-only standalone catalog admission and bounded structural evidence, never gameplay proof.
nlohmann::ordered_json validate(const std::filesystem::path& root);
// Deterministic task-scoped file discovery over the same canonical parsed catalog.
nlohmann::ordered_json context_manifest(const std::filesystem::path& root, const std::string& kind,
                                        const std::vector<std::string>& ids,
                                        const std::string& position, const std::string& scope);
} // namespace noveltea::narrative
