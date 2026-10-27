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

// Host-only adapters into the existing native compiler, package writer, image
// codec and archive writer. Platform staging must not create a second compiler
// or depend on the legacy ScriptC/TypeScript CLI.
using PlatformJson = nlohmann::ordered_json;
struct PlatformExportTools {
    std::function<PlatformJson(const PlatformJson&, const PlatformJson&,
                               const std::filesystem::path&)>
        prepare_package;
    std::function<PlatformJson(const PlatformJson&)> create_archive;
    std::function<PlatformJson(const PlatformJson&)> resize_image;
    std::function<bool(const PlatformJson&)> physical_sources_current;
    std::function<bool()> cancelled;
    std::function<void(const std::string&, const std::string&)> progress;
};

// Direct CLI adapter for Project-scoped profiles and the machine-local
// template/config registry. The Project callback is the existing native owner.
PlatformCliResult run_native_platform_cli(
    const std::vector<std::string>& command, const std::filesystem::path& project_root,
    bool explicit_project,
    const std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>& project_request,
    const PlatformExportTools& export_tools);

} // namespace noveltea::cli
