#pragma once

#include "tooling_project_authority.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::tooling::daemon {

inline constexpr std::uint32_t protocol_version = 1;
inline constexpr std::size_t max_frame_bytes = 1024 * 1024;
inline constexpr std::uint64_t default_project_session_idle_ms = 5 * 60 * 1000;
inline constexpr std::uint64_t default_daemon_idle_ms = 10 * 60 * 1000;
inline constexpr std::size_t default_project_snapshot_budget_bytes = 64 * 1024 * 1024;
inline constexpr std::size_t default_exact_validation_budget_bytes = 16 * 1024 * 1024;

class FrameDecoder {
public:
    [[nodiscard]] bool feed(std::span<const std::uint8_t> bytes);
    [[nodiscard]] const std::vector<std::string>& frames() const noexcept;
    [[nodiscard]] std::string_view error() const noexcept;
    void clear_frames();

private:
    std::vector<std::uint8_t> buffer_;
    std::vector<std::string> frames_;
    std::string error_;
};

[[nodiscard]] std::vector<std::uint8_t> encode_frame(std::string_view payload);
[[nodiscard]] std::string endpoint_identity(std::string_view build_identity,
                                            std::uint32_t daemon_protocol_version);

/**
 * Resolve a scheduler Project nomination to its canonical physical root.
 * Implicit cwd nominations search upward for the nearest project.json; explicit --project
 * nominations remain exact so scheduler admission preserves the public discovery contract.
 */
[[nodiscard]] std::string canonical_project_owner_root(std::string_view project_root,
                                                       bool search_upwards);

[[nodiscard]] std::string result_event_json(std::string_view request_id, bool ok,
                                            std::string_view result_json,
                                            std::string_view error = {});
[[nodiscard]] std::string text_event_json(std::string_view type, std::string_view request_id,
                                          std::string_view text);
[[nodiscard]] std::string progress_event_json(std::string_view request_id, std::string_view message,
                                              std::uint64_t completed, std::uint64_t total);
[[nodiscard]] std::string cancellation_event_json(std::string_view request_id);

struct ProjectGenerationIdentity {
    std::uint64_t session_epoch = 0;
    std::uint64_t generation = 0;

    friend bool operator==(const ProjectGenerationIdentity&,
                           const ProjectGenerationIdentity&) = default;
};

struct RetainedProjectSnapshot {
    std::string canonical_root;
    ProjectGenerationIdentity identity;
    std::string opaque_owner_metadata;
    std::size_t chunk_count = 0;
    std::size_t byte_size = 0;
    std::size_t pin_count = 0;
    std::uint64_t last_used_millis = 0;
};

/** Native RAM-only storage for opaque portable Project-generation bytes. */
class ProjectSnapshotStore {
public:
    ProjectSnapshotStore();
    [[nodiscard]] bool declare_current(std::string canonical_root,
                                       ProjectGenerationIdentity identity,
                                       std::uint64_t now_millis);
    [[nodiscard]] bool publish(std::string canonical_root, ProjectGenerationIdentity identity,
                               std::vector<std::string> opaque_chunks,
                               std::string opaque_owner_metadata,
                               ProjectAuthorityCheckpoint authority_checkpoint,
                               std::uint64_t now_millis);
    [[nodiscard]] std::optional<RetainedProjectSnapshot> latest(std::string_view canonical_root,
                                                                std::uint64_t now_millis);
    [[nodiscard]] std::optional<RetainedProjectSnapshot> find(std::string_view canonical_root,
                                                              ProjectGenerationIdentity identity,
                                                              std::uint64_t now_millis);
    [[nodiscard]] std::optional<std::string> chunk(std::string_view canonical_root,
                                                   ProjectGenerationIdentity identity,
                                                   std::size_t index, std::uint64_t now_millis);
    [[nodiscard]] std::optional<ProjectAuthorityCheckpoint>
    authority_checkpoint(std::string_view canonical_root, ProjectGenerationIdentity identity,
                         std::uint64_t now_millis);
    [[nodiscard]] bool pin_current(std::string_view canonical_root,
                                   ProjectGenerationIdentity identity, std::uint64_t now_millis);
    [[nodiscard]] bool unpin(std::string_view canonical_root, ProjectGenerationIdentity identity,
                             std::uint64_t now_millis);
    void invalidate_current(std::string_view canonical_root);
    void trim_dormant_to_budget(const std::vector<std::string>& active_roots,
                                std::size_t byte_budget);
    [[nodiscard]] std::size_t retained_bytes() const;
    [[nodiscard]] std::size_t snapshot_count() const;

private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

struct RetainedExactValidationResult {
    std::string canonical_root;
    std::string semantic_key;
    ProjectAuthorityCheckpoint authority;
    std::string semantic_result_json;
    std::uint64_t revision = 0;
    std::size_t byte_size = 0;
    std::uint64_t last_used_millis = 0;
};

/** Native RAM-only storage for one exact validation result per canonical physical Project. */
class ExactValidationStore {
public:
    ExactValidationStore();
    void retain(RetainedExactValidationResult result, std::uint64_t now_millis);
    [[nodiscard]] std::optional<RetainedExactValidationResult>
    find(std::string_view canonical_root, std::string_view semantic_key, std::uint64_t now_millis);
    [[nodiscard]] std::optional<RetainedExactValidationResult> find(std::string_view canonical_root,
                                                                    std::uint64_t now_millis);
    [[nodiscard]] bool contains(std::string_view canonical_root,
                                std::string_view semantic_key) const;
    [[nodiscard]] bool erase_if_revision(std::string_view canonical_root, std::uint64_t revision);
    [[nodiscard]] std::vector<std::string>
    trim_dormant_to_budget(const std::vector<std::string>& active_roots, std::size_t byte_budget);
    [[nodiscard]] std::size_t retained_bytes() const;
    [[nodiscard]] std::size_t result_count() const;

private:
    struct Impl;
    std::shared_ptr<Impl> impl_;
};

struct ExactValidationProof {
    std::optional<RetainedExactValidationResult> result;
    std::optional<ProjectObservation> observation;
};

/**
 * Prove one retained exact validation result against a fresh native Project observation.
 * Watcher state is deliberately insufficient: every candidate performs physical discovery before
 * a result can be reused, and a mismatched retained result is discarded immediately.
 */
[[nodiscard]] ExactValidationProof prove_exact_validation_result(ProjectAuthorityManager& authority,
                                                                 ExactValidationStore& store,
                                                                 std::string_view canonical_root,
                                                                 std::string_view semantic_key,
                                                                 std::uint64_t now_millis);

/** Create the disposable exact-validation cache directory without traversing symlink components. */
[[nodiscard]] std::optional<std::filesystem::path>
ensure_authoring_cache_directory(const std::filesystem::path& project_root);

} // namespace noveltea::tooling::daemon
