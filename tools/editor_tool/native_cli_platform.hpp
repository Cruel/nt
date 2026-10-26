#pragma once

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace noveltea::cli {

struct PlatformCliResult {
    nlohmann::ordered_json envelope;
    std::string human;
};

// Direct CLI adapter for Project-scoped profiles and the machine-local
// template/config registry. The Project callback is the existing native owner.
PlatformCliResult run_native_platform_cli(
    const std::vector<std::string>& command, const std::filesystem::path& project_root,
    bool explicit_project,
    const std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>& project_request);

} // namespace noveltea::cli
