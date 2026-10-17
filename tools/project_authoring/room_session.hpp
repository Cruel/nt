#pragma once

#include "contracts.hpp"
#include "source_authority.hpp"
#include "source_analysis.hpp"
#include "yaml_codec.hpp"
#include "yaml_transaction.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace noveltea::authoring {

struct RoomPatch {
    enum class Operation {
        Add,
        Replace,
        Remove
    } operation;
    std::string path;       // RFC 6901 within the Room record, never a filesystem path
    std::string value_json; // required for add/replace, absent for remove
    YamlCommentDisposition comments = YamlCommentDisposition::Keep;
};

struct RoomSessionSnapshot {
    std::uint64_t working_revision = 0;
    std::string disk_source_revision; // content identity of the admitted source
    std::string source_json;          // explicit working fields (not implicit defaults)
    std::string baseline_json;        // exact admitted saved semantic source values
    std::string normalized_json;      // only populated when native validation succeeds
    bool dirty = false;
    bool valid = false;
    std::vector<Diagnostic> diagnostics;
    std::vector<std::string> conflicting_paths; // relative, unresolved local/external collisions
};

struct RoomSessionResult {
    bool accepted = false;
    std::string error;
    std::vector<std::string> affected_records;
    std::vector<Diagnostic> diagnostics_added;
    std::vector<Diagnostic> diagnostics_removed;
    RoomSessionSnapshot snapshot;
};

enum class ProjectFileKind {
    TrackedSource,
    ProjectSource,
    IgnoredState,
    UntrackedFile
};
struct ProjectFile {
    std::string path; // canonical Project-relative, forward-slash identity
    ProjectFileKind kind;
};

// A parallel, single-Room certification slice of the future resident Project session.
// No editor, CLI, or runtime production path creates this session yet.
class RoomSession {
public:
    static std::unique_ptr<RoomSession> open(const std::filesystem::path& project_root,
                                             std::string room_id, std::string& error);
    static std::unique_ptr<RoomSession> open_map(const std::filesystem::path& project_root,
                                                 std::string map_id, std::string& error);
    static std::unique_ptr<RoomSession> open_record(const std::filesystem::path& project_root,
                                                    std::string family, std::string id,
                                                    std::string& error);
    // The same generic patch/save boundary with a different admitted source owner.
    // Kept parallel to the production workspace until the migration cutover.
    static std::unique_ptr<RoomSession>
    open_project_source(const std::filesystem::path& project_root, std::string& error);
    static std::unique_ptr<RoomSession>
    open_editor_source(const std::filesystem::path& project_root, std::string& error);
    static std::unique_ptr<RoomSession>
    open_traits_source(const std::filesystem::path& project_root, std::string& error);
    static std::unique_ptr<RoomSession>
    open_localization_source(const std::filesystem::path& project_root,
                             std::string_view relative_path, std::string& error);

    RoomSessionSnapshot snapshot() const;
    RoomSessionResult patch(std::uint64_t expected_working_revision,
                            const std::vector<RoomPatch>& operations);
    // A scoped Save of this Room only. The expected disk identity must match the
    // admitted source; physical content is also compared exactly before replacement.
    RoomSessionResult save(std::string_view expected_disk_revision,
                           const std::vector<std::string>& invalid_source_paths = {});
    RoomSessionResult reconcile_disk();
    RoomSessionResult use_disk();
    RoomSessionResult use_disk_paths(const std::vector<std::string>& paths);
    std::unique_ptr<RoomSession> clone() const
    {
        return std::unique_ptr<RoomSession>(new RoomSession(*this));
    }
    const std::filesystem::path& source_path() const { return path_; }
    const std::vector<ProjectFile>& file_inventory() const { return file_inventory_; }

private:
    friend class ProjectSession;
    RoomSession(std::filesystem::path path, std::string room_id, std::string source,
                std::string source_json);
    RoomSessionResult result(bool accepted, std::string error = {}, bool changed = false) const;
    ValidationResult validate_source(std::string_view source_json) const;

    std::filesystem::path path_;
    std::string room_id_;
    std::string disk_source_;
    std::string disk_revision_;
    std::string disk_json_;
    std::string working_json_;
    std::vector<RoomPatch> unsaved_patches_;
    std::uint64_t working_revision_ = 0;
    bool is_project_ = false;
    bool is_editor_ = false;
    bool is_traits_ = false;
    bool is_localization_ = false;
    bool is_map_ = false;
    std::string record_family_ = "rooms";
    std::string validation_contract_;
    std::vector<std::string> conflicting_paths_;
    std::vector<ProjectFile> file_inventory_;
};

// Certification-only resident working model: manifest and touched Room/Map owners
// use one revision and one atomic generic patch batch. Production still uses TS.
class ProjectSession {
public:
    static std::unique_ptr<ProjectSession> open(const std::filesystem::path& root,
                                                std::string& error);
    RoomSessionSnapshot snapshot() const;
    RoomSessionResult patch(std::uint64_t revision, const std::vector<RoomPatch>& patches,
                            const std::map<std::string, std::string>& disk_preconditions = {});
    RoomSessionResult inspect_record(std::string_view owner);
    RoomSessionResult reconcile_owner(std::string_view owner);
    RoomSessionResult use_disk(std::uint64_t revision, std::string_view owner,
                               const std::vector<std::string>& paths = {});
    RoomSessionResult use_disk_owners(std::uint64_t revision,
                                      const std::map<std::string, std::vector<std::string>>& paths);
    RoomSessionResult
    restore_conflicts(std::uint64_t revision,
                      const std::map<std::string, std::vector<std::string>>& conflicts);
    // Dirty shader text is a distinct source owner; the existing native shader
    // tool compiles it via an overlay root. Do not insert it into Material YAML.
    RoomSessionResult stage_shader_source(std::uint64_t revision, std::string_view relative_path,
                                          std::string source_text);
    // Unsaved Lua/RML/RCSS buffers are private to this editor-side session.
    // Source text is not inserted into YAML, and CLI sessions see only disk.
    RoomSessionResult stage_text_source(std::uint64_t revision, std::string_view relative_path,
                                        std::string source_text);
    const std::map<std::string, SourceAnalysis>& source_analyses() const;
    const std::map<std::string, std::string>& text_source_overlays() const
    {
        return text_source_overlays_;
    }
    struct WorkingPreparation {
        bool accepted = false;
        std::string error;
        std::uint64_t working_revision = 0;
        std::string project_json;
        std::string record_overrides_json;
        std::map<std::string, std::string> source_revisions;
        std::map<std::string, std::string> text_overlays;
        std::map<std::string, std::string> shader_overlays;
        std::vector<Diagnostic> diagnostics;
    };
    // The editor's opt-in preparation seam: capture one revision-consistent
    // effective working Project, without persisting it or invoking the CLI.
    WorkingPreparation prepare_working(std::uint64_t expected_revision,
                                       std::string_view test_id = {}) const;
    RoomSessionResult publish_material_compiler_result(std::uint64_t revision,
                                                       std::string_view material_id,
                                                       std::string_view native_tool_result_json);
    std::optional<std::string> material_compiler_request(std::string_view material_id) const;
    const std::map<std::string, std::string>& shader_source_overlays() const
    {
        return shader_overlays_;
    }
    RoomSessionResult
    save_owners(std::uint64_t revision, const std::vector<std::string>& owners, bool keep_mine,
                TransactionDecision comments,
                const std::map<std::string, std::vector<std::string>>& paths = {});
    std::map<std::string, RoomSessionSnapshot> record_snapshots() const;
    RoomSessionResult save(std::string_view disk_revision)
    {
        for (const auto& [owner, record] : records_) {
            if (record->snapshot().dirty) {
                RoomSessionResult blocked;
                blocked.error = "Cannot partially save dirty native Project owner: " + owner;
                blocked.snapshot = snapshot();
                return blocked;
            }
        }
        if (source_authority_->uncertain()) {
            RoomSessionResult blocked;
            blocked.error = "Cannot save while Project source watcher authority is uncertain.";
            blocked.snapshot = snapshot();
            return blocked;
        }
        const auto prior_revision = source_->snapshot().disk_source_revision;
        const auto prior_working_json = source_->snapshot().source_json;
        auto result = source_->save(disk_revision, source_authority_->invalid_source_paths());
        if (result.accepted && result.snapshot.disk_source_revision != prior_revision &&
            !source_authority_->acknowledge_own_write("project.yaml",
                                                      result.snapshot.disk_source_revision))
            source_authority_->coverage_lost();
        if (result.accepted && source_->snapshot().source_json != prior_working_json)
            ++working_revision_;
        result.snapshot = snapshot();
        return result;
    }
    const std::vector<ProjectFile>& file_inventory() const { return source_->file_inventory(); }

    // Certified physical changes are separate from working-state mutation; #495
    // will reconcile these paths into the resident editor/daemon Project model.
    SourceObservation observe_sources();
    void source_watch_hint(std::string_view path) { source_authority_->hint(path); }
    void source_watch_coverage_lost() { source_authority_->coverage_lost(); }

private:
    ProjectSession(std::unique_ptr<RoomSession> source,
                   std::unique_ptr<SourceAuthority> source_authority, std::filesystem::path root,
                   std::string traits_baseline_json)
        : source_(std::move(source)), source_authority_(std::move(source_authority)),
          root_(std::move(root)), traits_baseline_json_(std::move(traits_baseline_json))
    {
    }
    std::optional<std::string> resolved_material(std::string_view material_id) const;
    void index_text_owner(std::string_view owner, std::string_view raw_json);
    void reindex_asset_consumers(std::string_view asset_id);
    ValidationResult validate_working_localization() const;
    std::unique_ptr<RoomSession> source_;
    std::unique_ptr<SourceAuthority> source_authority_;
    std::filesystem::path root_;
    std::string traits_baseline_json_;
    std::map<std::string, std::unique_ptr<RoomSession>> records_;
    std::map<std::string, std::string> shader_overlays_;
    std::map<std::string, std::string> text_source_overlays_;
    std::map<std::string, std::string> inline_text_sources_;
    std::map<std::string, std::string> inline_source_diagnostic_paths_;
    std::set<std::string> text_source_paths_;
    std::map<std::string, std::string> text_disk_revisions_;
    std::map<std::string, std::set<std::string>> text_source_owners_;
    std::map<std::string, std::set<std::string>> asset_text_consumers_;
    std::map<std::string, std::set<std::string>> layout_declared_scripts_;
    mutable std::map<std::string, SourceAnalysis> text_analysis_cache_;
    std::map<std::string, ValidationResult> material_compiler_results_;
    std::uint64_t working_revision_ = 0;
    // Full cross-record resolver analysis is immutable between Project edit
    // generations and inspected-owner inventory changes.
    mutable std::optional<ValidationResult> interaction_resolver_cache_;
    mutable std::uint64_t interaction_resolver_revision_ = 0;
    mutable std::size_t interaction_resolver_owner_count_ = 0;
    mutable std::optional<std::vector<std::pair<std::string, std::string>>> interaction_sources_;
    mutable std::optional<std::vector<std::pair<std::string, std::string>>> test_sources_;
    mutable std::vector<std::pair<std::string, std::string>> interaction_resolver_sources_;
    // Reuse unchanged localization fragments across unrelated Project snapshots;
    // only native i18n edits and observed i18n source changes invalidate them.
    mutable std::optional<ValidationResult> localization_cache_;
    // An effective lock materialized from sparse disk content is still a
    // working-session invariant, even before the policy YAML is next saved.
    std::optional<std::string> localization_source_lock_;
};

} // namespace noveltea::authoring
