#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::tooling::daemon {

enum class ProjectAuthorityState {
    untracked,
    proven,
    dirty,
    unknown,
};

[[nodiscard]] const char* project_authority_state_name(ProjectAuthorityState state) noexcept;

struct ProjectSourceDiscoveryScope {
    std::string root;
    std::vector<std::string> extensions;
    std::vector<std::string> excluded_prefixes;

    friend bool operator==(const ProjectSourceDiscoveryScope&,
                           const ProjectSourceDiscoveryScope&) = default;
};

struct ProjectAuthorityRequest {
    std::filesystem::path project_root;
    std::vector<std::string> authoritative_paths;
    std::vector<ProjectSourceDiscoveryScope> discovery_scopes;
};

struct ProjectSourceManifestEntry {
    std::string path;
    std::string source_identity;
    std::uint64_t byte_size = 0;
    std::optional<std::uint64_t> mtime_nanoseconds;
    std::optional<std::string> content_hash;

    friend bool operator==(const ProjectSourceManifestEntry&,
                           const ProjectSourceManifestEntry&) = default;
};

struct ProjectSourceManifest {
    std::string canonical_root;
    std::vector<ProjectSourceManifestEntry> entries;

    friend bool operator==(const ProjectSourceManifest&, const ProjectSourceManifest&) = default;
};

struct ProjectSourceDelta {
    std::vector<std::string> added;
    std::vector<std::string> changed;
    std::vector<std::string> removed;

    [[nodiscard]] bool empty() const noexcept
    {
        return added.empty() && changed.empty() && removed.empty();
    }
};

struct ProjectObservation {
    ProjectAuthorityState previous_state = ProjectAuthorityState::untracked;
    bool unchanged = false;
    bool full_rescan = true;
    std::vector<std::string> watcher_paths;
    ProjectSourceDelta delta;
    ProjectSourceManifest manifest;
};

struct ProjectAuthorityStatus {
    ProjectAuthorityState state = ProjectAuthorityState::untracked;
    bool has_manifest = false;
    std::vector<std::string> pending_paths;
};

/**
 * Native physical-authority baseline associated with one portable Project generation.
 *
 * The checkpoint intentionally contains only native source-discovery/proof state. It is retained
 * separately from opaque serialized Project bytes so crash recovery can compare current disk state
 * against the exact physical baseline that produced a retained semantic generation.
 */
struct ProjectAuthorityCheckpoint {
    std::filesystem::path canonical_root;
    std::vector<std::string> authoritative_paths;
    std::vector<ProjectSourceDiscoveryScope> discovery_scopes;
    ProjectSourceManifest manifest;

    friend bool operator==(const ProjectAuthorityCheckpoint&,
                           const ProjectAuthorityCheckpoint&) = default;
};

struct ProjectAuthorityOptions {
    bool enable_native_watcher = true;
    std::function<std::optional<std::uint64_t>(const std::filesystem::path&)> mtime_reader;
    // Deterministic Windows watcher lifecycle test seam invoked immediately before an overlapped
    // directory observation is armed.
    std::function<void()> windows_watcher_before_read;
    // Deterministic Windows watcher lifecycle test seam invoked after the stop event is signalled
    // and before the owning thread waits for watcher termination.
    std::function<void()> windows_watcher_stop_requested;
};

/**
 * Native physical authority for active Projects.
 *
 * The interface deliberately exposes one batched observation operation. Watcher notifications only
 * revoke a retained proof and provide reconciliation hints; every successful observation performs
 * conservative native source discovery before declaring the returned manifest current.
 */
class ProjectAuthorityManager {
public:
    explicit ProjectAuthorityManager(ProjectAuthorityOptions options = {});
    ~ProjectAuthorityManager();

    ProjectAuthorityManager(const ProjectAuthorityManager&) = delete;
    ProjectAuthorityManager& operator=(const ProjectAuthorityManager&) = delete;

    [[nodiscard]] ProjectObservation observe(const ProjectAuthorityRequest& request);
    [[nodiscard]] std::optional<ProjectAuthorityStatus>
    status(const std::filesystem::path& project_root) const;
    [[nodiscard]] std::optional<ProjectAuthorityCheckpoint>
    checkpoint(const std::filesystem::path& project_root) const;

    /**
     * Replace retained native authority with the exact baseline associated with a portable
     * generation and leave it dormant/unknown. The next observation recreates watcher coverage and
     * performs a complete proof against this baseline, recovering deltas already consumed by a
     * crashed owner after the snapshot was prepared.
     */
    [[nodiscard]] bool
    restore_checkpoint_for_rehydration(const ProjectAuthorityCheckpoint& checkpoint);

    // Deterministic adapter seams for watcher delivery/failure tests. Unknown notification also
    // drops active native watcher coverage so recovery must recreate it before proving current.
    void notify_path_changed(const std::filesystem::path& project_root, std::string relative_path,
                             bool directory);
    void notify_watcher_unknown(const std::filesystem::path& project_root);

    /** Stop native watcher coverage while retaining the last manifest/configuration for
     * rehydration. */
    [[nodiscard]] bool suspend(const std::filesystem::path& project_root);
    [[nodiscard]] bool release(const std::filesystem::path& project_root);
    [[nodiscard]] std::size_t tracked_project_count() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace noveltea::tooling::daemon
