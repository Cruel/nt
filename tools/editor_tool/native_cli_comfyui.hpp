#pragma once

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace noveltea::cli {
struct ComfyUiResult {
    nlohmann::ordered_json envelope;
    std::string human;
};

// Project admission stays with the existing native CLI Project authority.
ComfyUiResult run_native_comfyui_catalog(
    const std::vector<std::string>& command, const std::filesystem::path& project_root,
    const std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>& project_request,
    bool json_mode);
} // namespace noveltea::cli
