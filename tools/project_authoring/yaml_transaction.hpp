#pragma once

#include "yaml_codec.hpp"

#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::authoring {

enum class TransactionDecision {
    KeepComments,
    RemoveComments,
    UseEditDecisions, // native Room's existing per-patch Keep/Remove contract
    Cancel
};

struct YamlTransactionTarget {
    std::string path;              // canonical Project-relative tracked YAML source
    std::string expected_revision; // sha256:<hex> or absent
    std::string baseline_source;   // exact bytes that edits were authored against
    std::vector<YamlValueEdit> edits;
    std::optional<std::string> create_source; // only when expected_revision is absent
    bool erase = false;
    // Atomic whole-source formatting; unlike a normal edit, content must
    // decode to the same source value as its baseline.
    std::optional<std::string> replacement_source = std::nullopt;
    // Only permitted for a canonical record source, when native validation
    // proves that omission of explicit defaults leaves its effective value
    // exactly unchanged.
    std::optional<std::string> semantic_compaction_family = std::nullopt;
};

struct PreparedYamlTarget {
    std::string path;
    std::string before_revision;
    std::string after_revision;
    std::string before_source;
    std::string after_source;
    std::vector<std::string> affected_comments;
    bool erase = false;
};

struct PreparedYamlTransaction {
    bool accepted = false;
    std::string error;
    std::string approval; // exact physical revisions + proposed semantic operation
    TransactionDecision decision = TransactionDecision::KeepComments;
    std::vector<PreparedYamlTarget> targets;
};

struct YamlTransactionResult {
    bool accepted = false;
    std::string error;
    std::vector<std::string> changed_paths;
};

// Host-only parallel native equivalent of workspace transaction ownership.
// The user-facing comment approval occurs before this boundary: Prepare records
// what the user reviewed, and Commit rejects a stale approval/physical revision.
class YamlTransactionService {
public:
    explicit YamlTransactionService(std::filesystem::path root);

    PreparedYamlTransaction prepare(const std::vector<YamlTransactionTarget>& targets,
                                    TransactionDecision decision) const;
    YamlTransactionResult commit(const PreparedYamlTransaction& prepared,
                                 TransactionDecision decision);
    YamlTransactionResult recover();

    // When an invalid source has an attributable owner, only dependent paths
    // are blocked. Unknown structural attribution blocks every tracked write.
    void set_invalid_sources(std::vector<std::string> blocked_paths, bool structural_uncertainty);

    // Certification seam: simulate a process terminating after installing one
    // physical target but before recording its journal completion marker.
    void set_after_target_hook_for_certification(std::function<void(std::size_t)> hook)
    {
        after_target_hook_ = std::move(hook);
    }

private:
    std::filesystem::path checked_path(std::string_view relative) const;
    std::filesystem::path root_;
    std::vector<std::string> blocked_paths_;
    bool structural_uncertainty_ = false;
    std::function<void(std::size_t)> after_target_hook_;
};

} // namespace noveltea::authoring
