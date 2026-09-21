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

struct ProjectAuthorityOptions {
    bool enable_native_watcher = true;
    std::function<std::optional<std::uint64_t>(const std::filesystem::path&)> mtime_reader;
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

    // Adapter seam used by native watchers and deterministic broker tests.
    void notify_path_changed(const std::filesystem::path& project_root, std::string relative_path,
                             bool directory);
    void notify_watcher_unknown(const std::filesystem::path& project_root);

    [[nodiscard]] bool release(const std::filesystem::path& project_root);
    [[nodiscard]] std::size_t tracked_project_count() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace noveltea::tooling::daemon
