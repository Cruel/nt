#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>

namespace noveltea::narrative {
// Read-only standalone catalog admission and bounded structural evidence, never gameplay proof.
nlohmann::ordered_json validate(const std::filesystem::path& root);
} // namespace noveltea::narrative
