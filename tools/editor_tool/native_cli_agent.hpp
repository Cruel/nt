#pragma once

#include <filesystem>
#include <string>

namespace noveltea::cli {
struct AgentSyncResult {
    bool changed = false;
    bool bootstrap_changed = false;
    std::string bootstrap_status;
    std::string gitignore_status;
    std::filesystem::path guide;
    std::filesystem::path manifest;
};

// Source references are generated at build time and embedded in the executable.
AgentSyncResult sync_native_agent_kit(const std::filesystem::path& project_root, bool fix);
} // namespace noveltea::cli
