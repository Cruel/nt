#pragma once

#include <filesystem>
#include <functional>
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::cli {
struct ComfyUiResult {
    nlohmann::ordered_json envelope;
    std::string human;
};

struct ComfyUiStagedFilesystemOutput {
    std::filesystem::path staged_path;
    std::filesystem::path final_path;
    std::filesystem::path backup_path;
    bool force = false;
};

// Optional ownership boundary supplied by the native broker's disposable
// worker adapter (#550). Register each never-before-created staged file with
// the broker before writing it. The broker callback must dispatch mutations
// to the current pinned Project owner, never open a mutable Project here.
// In the direct standalone candidate, native Project authority is used instead.
struct ComfyUiExecutionHooks {
    std::function<void(const std::filesystem::path&)> register_staged_output;
    std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>
        commit_staged_project_assets;
    // For Projectless/file-only disposable runs, broker transaction ownership
    // must cover activation and acceptance. Never install files in the worker.
    std::function<void(const std::vector<ComfyUiStagedFilesystemOutput>&)> publish_staged_files;
    std::function<bool()> cancelled;
    std::function<void(std::string_view, std::string_view)> progress;
};

// Project admission stays with the existing native CLI Project authority.
ComfyUiResult run_native_comfyui_catalog(
    const std::vector<std::string>& command, const std::filesystem::path& project_root,
    const std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>& project_request,
    bool json_mode, const ComfyUiExecutionHooks& hooks = {});
} // namespace noveltea::cli
