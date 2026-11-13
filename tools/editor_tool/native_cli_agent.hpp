#pragma once

#include <filesystem>
#include <string>
#include <vector>

namespace noveltea::cli {
struct AgentSyncResult {
    bool changed = false;
    bool bootstrap_changed = false;
    std::string bootstrap_status;
    std::string gitignore_status;
    std::filesystem::path guide;
    std::filesystem::path manifest;
};

struct RepairCandidateEvidence {
    std::string recognition = "none"; // strong, weak, or none
    std::vector<std::string> sources;
    bool newer_workspace_version = false;
};

// Source references are generated at build time and embedded in the executable.
AgentSyncResult sync_native_agent_kit(const std::filesystem::path& project_root, bool fix);
// Lightweight, read-only candidate recognition; never runs workspace admission.
RepairCandidateEvidence inspect_repair_candidate(const std::filesystem::path& root);
} // namespace noveltea::cli
