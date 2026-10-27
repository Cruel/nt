#pragma once

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>
#include <optional>
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
    std::function<PlatformJson(const PlatformJson&, const PlatformJson&)> check_runtime;
    std::function<bool()> cancelled;
    std::function<void(const std::string&, const std::string&)> progress;
    // Host-only, argv-based signing command runner; must never invoke a shell
    // or write command arguments (which may contain secrets) to diagnostics.
    std::function<bool(const std::string&, const std::vector<std::string>&,
                       const std::filesystem::path&)>
        run_signing_command;
    // Read-only argv-based host inspection with captured output. Never use this
    // for a command containing secrets, and never put captured output in user
    // diagnostics without separately validating/redacting it.
    std::function<std::optional<std::string>(const std::string&, const std::vector<std::string>&,
                                             const std::filesystem::path&)>
        inspect_command;
};

// Direct CLI adapter for Project-scoped profiles and the machine-local
// template/config registry. The Project callback is the existing native owner.
PlatformCliResult run_native_platform_cli(
    const std::vector<std::string>& command, const std::filesystem::path& project_root,
    bool explicit_project,
    const std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>& project_request,
    const PlatformExportTools& export_tools);

} // namespace noveltea::cli
