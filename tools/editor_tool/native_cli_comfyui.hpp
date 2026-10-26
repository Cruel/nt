#pragma once

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace noveltea::cli {
struct ComfyUiResult {
    nlohmann::ordered_json envelope;
    std::string human;
};

// Project admission stays with the existing native CLI Project authority.
ComfyUiResult run_native_comfyui_catalog(const std::vector<std::string>& command,
                                         const std::filesystem::path& project_root);
} // namespace noveltea::cli
