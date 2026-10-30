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
    std::vector<std::pair<std::string, std::string>> asset_trash_moves;
    struct CommentImpact {
        std::string file;
        std::string path;
        std::string comment;
        std::string kind;
    };
    std::vector<CommentImpact> comment_impacts;
};

struct ProjectAssetTransition {
    enum class Kind {
        Trash,
        Restore,
        Publish,
        Move,
        SourceFiles
    } kind = Kind::Trash;
    std::vector<std::string> paths;
    std::vector<std::pair<std::string, std::string>> moves;
    struct Publication {
        std::string project_relative_path;
        std::string staged_relative_path;
        std::string source_revision;
    };
    std::vector<Publication> publications;
    struct SourceFile {
        std::string path;
        std::string expected_revision;
        std::optional<std::string> contents;
    };
    std::vector<SourceFile> source_files;
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
    // Stage a generic new record without touching disk. Physical creation is
    // owned by the same revision-checked transaction as normal scoped Save.
    static std::unique_ptr<RoomSession>
    stage_new_record(const std::filesystem::path& project_root, std::string family, std::string id,
                     std::string source_json, std::string& error,
                     std::map<std::string, std::string> layout_companions = {});
    // The same generic patch/save boundary with a different admitted source owner.
    // Kept parallel to the production workspace until the migration cutover.
    static std::unique_ptr<RoomSession>
    open_project_source(const std::filesystem::path& project_root, std::string& error,
                        bool validation_only = false);
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
    // The physical owner was verified absent. A dirty record becomes a
    // whole-owner conflict; a clean record is removed by ProjectSession.
    RoomSessionResult reconcile_deleted_disk();
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
    ValidationResult
    validate_source(std::string_view source_json,
                    const std::map<std::string, std::string>* layout_companions = nullptr) const;

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
    // Bytes belonging to a staged Layout clone/rename. They do not exist at
    // the destination until the entire native Save journal is committed.
    std::map<std::string, std::string> layout_companion_sources_;
    std::string layout_companion_origin_;
    std::vector<std::string> conflicting_paths_;
    std::vector<ProjectFile> file_inventory_;
    mutable std::optional<RoomSessionSnapshot> snapshot_cache_;
    // Companion contents and physical Asset membership are the external inputs
    // missing from a YAML-only snapshot revision. Never cache solely by YAML.
    mutable std::map<std::string, std::string> snapshot_layout_companions_;
    mutable std::map<std::string, bool> snapshot_asset_membership_;
    mutable std::optional<std::pair<std::string, ValidationResult>> asset_structural_cache_;
};

// Certification-only resident working model: manifest and touched Room/Map owners
// use one revision and one atomic generic patch batch. Production still uses TS.
class ProjectSession {
public:
    static std::unique_ptr<ProjectSession> open(const std::filesystem::path& root,
                                                std::string& error);
    // Cold diagnostics may inspect malformed saved fragments, but cannot
    // expose such a Project as a mutable session.
    static std::optional<RoomSessionSnapshot>
    validate_cold_project(const std::filesystem::path& root, std::string& error);
    RoomSessionSnapshot snapshot() const;
    // Complete certification-only Project validation. Unlike snapshot(), this
    // includes every tracked record, not just editor-admitted working owners.
    // Validation owners and their physical proofs stay resident across calls.
    // Only for a caller that just established an authoritative physical
    // observation and will require a fresh post-validation observation.
    RoomSessionSnapshot validate_project(bool observed_at_entry = false);
    // Portable exact-result cache shared by the opt-in editor worker and the
    // existing CLI Project owner; dirty working state is never published.
    struct CleanValidation {
        RoomSessionSnapshot snapshot;
        bool cache_hit = false;
    };
    // The native disk owner may have just observed the same source authority
    // before entering this serialized validation call.
    CleanValidation validate_clean_project(bool initially_observed = false);
    struct ValidationWork {
        std::size_t rechecked_records = 0;
        std::size_t retained_records = 0;
        std::size_t rechecked_contributions = 0;
        std::size_t retained_contributions = 0;
    };
    ValidationWork validation_work() const { return validation_work_; }
    // An internal consumer of the same serialized certification request may
    // reuse the resident semantic snapshot. The caller must subsequently
    // prove physical authority before publishing its derived result.
    std::optional<RoomSessionSnapshot> validated_snapshot_for_preparation() const
    {
        if (validation_pending_uncertain_ || !validation_pending_source_revisions_.empty() ||
            source_authority_->uncertain())
            return std::nullopt;
        return validation_snapshot_;
    }
    RoomSessionResult patch(std::uint64_t revision, const std::vector<RoomPatch>& patches,
                            const std::map<std::string, std::string>& disk_preconditions = {},
                            const std::map<std::string, std::string>& layout_copy_sources = {});
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
    // Exact-revision physical publication of previously admitted Lua/RML/RCSS
    // overlays. Uses the Project YAML transaction journal for crash recovery,
    // but writes verbatim text without interpreting it as YAML.
    RoomSessionResult
    save_text_sources(std::uint64_t revision, const std::vector<std::string>& paths,
                      const std::map<std::string, std::string>& disk_preconditions);
    const std::map<std::string, SourceAnalysis>& source_analyses() const;
    const std::map<std::string, std::string>& text_source_overlays() const
    {
        return text_source_overlays_;
    }
    const std::map<std::string, std::string>& text_source_disk_revisions() const
    {
        return text_disk_revisions_;
    }
    struct WorkingPreparation {
        bool accepted = false;
        std::string error;
        std::uint64_t working_revision = 0;
        std::string project_json;
        std::string record_overrides_json;
        // Complete effective Project assembled by resident native validation,
        // rather than by overlaying dirty owners on a TypeScript saved Project.
        std::string complete_project_json;
        // Same admitted runtime-only Asset closure as the native CLI exporter.
        // Empty is meaningful; only complete preparation publishes the field.
        std::optional<std::set<std::string>> referenced_asset_ids;
        std::map<std::string, std::string> source_revisions;
        std::map<std::string, std::string> text_overlays;
        std::map<std::string, std::string> shader_overlays;
        std::vector<Diagnostic> diagnostics;
    };
    // The editor's opt-in preparation seam: capture one revision-consistent
    // effective working Project, without persisting it or invoking the CLI.
    WorkingPreparation prepare_working(std::uint64_t expected_revision,
                                       std::string_view test_id = {},
                                       bool allow_invalid_test_semantics = false) const;
    // A caller that just completed clean validation may reuse its resident
    // snapshot; this still requires fresh physical observation on both sides
    // of complete preparation and fails closed if authority has advanced.
    WorkingPreparation prepare_complete_working(std::uint64_t expected_revision,
                                                std::string_view test_id = {},
                                                bool reuse_clean_validation = false);
    // Read-only, revision-pinned semantic evidence from the resident native
    // Project. This deliberately does not require unrelated records to pass
    // semantic validation; incomplete owners are explicitly reported.
    std::string semantic_graph(std::uint64_t expected_revision);
    RoomSessionResult publish_material_compiler_result(std::uint64_t revision,
                                                       std::string_view material_id,
                                                       std::string_view native_tool_result_json);
    std::optional<std::string> material_compiler_request(std::string_view material_id) const;
    // Effective native Material inputs for disk-authoritative compiler/reflection
    // certification. Call only after inspecting the Material owner.
    std::optional<std::string> material_compiler_effective(std::string_view material_id) const
    {
        return resolved_material(material_id);
    }
    const std::map<std::string, std::string>& shader_source_overlays() const
    {
        return shader_overlays_;
    }
    RoomSessionResult
    save_owners(std::uint64_t revision, const std::vector<std::string>& owners, bool keep_mine,
                TransactionDecision comments,
                const std::map<std::string, std::vector<std::string>>& paths = {},
                const std::vector<std::string>& text_paths = {},
                const std::optional<ProjectAssetTransition>& assets = std::nullopt);
    // Empty Project Explorer folders have no YAML or byte targets. Their
    // single-entry mkdir/rename/rmdir remains native-session-revision checked.
    RoomSessionResult mutate_source_directory(std::uint64_t revision, std::string_view kind,
                                              std::string_view source, std::string_view target);
    std::map<std::string, RoomSessionSnapshot> record_snapshots() const;
    // Immutable disk-validation contributors, including lazily uninspected
    // record owners. Valid only after validate_project() has refreshed proof.
    std::map<std::string, RoomSessionSnapshot> validated_disk_record_snapshots() const;
    // Reconciliation can read disk contributors when stale localization alone
    // prevents a whole-Project validation proof.
    std::map<std::string, RoomSessionSnapshot> reconciliation_disk_record_snapshots() const;
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
    std::optional<std::map<std::string, std::string>> verified_source_revisions() const
    {
        return source_authority_->verified_revisions();
    }
    std::uint64_t source_capture_count() const noexcept
    {
        return source_authority_->source_capture_count();
    }
    // The observer's immutable, exactly hashed capture. Diagnostic projections
    // must consume these same bytes, not reopen files after observation.
    const VerifiedProjectSource* verified_observed_source(std::string_view path) const
    {
        return source_authority_->verified_source(path);
    }
    void source_watch_hint(std::string_view path) { source_authority_->hint(path); }
    void source_watch_coverage_lost() { source_authority_->coverage_lost(); }

private:
    static std::unique_ptr<ProjectSession> open_impl(const std::filesystem::path& root,
                                                     std::string& error, bool validation_only);
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
    // Immutable parsed source values shared by admission, observation and
    // validation within this Project session; never a source freshness proof.
    std::shared_ptr<YamlDecodeCache> yaml_decode_cache_;
    std::filesystem::path root_;
    std::string traits_baseline_json_;
    std::map<std::string, std::unique_ptr<RoomSession>> records_;
    // Persisted records removed from the working Project retain their exact
    // physical baselines until an atomic structural Save commits the deletion.
    std::map<std::string, std::unique_ptr<RoomSession>> deleted_records_;
    std::map<std::string, std::unique_ptr<RoomSession>> validation_records_;
    std::map<std::string, std::string> validation_source_revisions_;
    // Source changes observed outside validation remain pending until the next
    // diagnostic generation consumes their exact physical evidence.
    std::map<std::string, std::string> validation_pending_source_revisions_;
    // Binary Asset changes invalidate their owners even if the YAML revision
    // stays constant. Carry the evidence across separate watcher polls.
    std::set<std::string> validation_pending_asset_owners_;
    bool validation_pending_uncertain_ = false;
    std::map<std::string, std::string> validation_shader_overlays_;
    std::map<std::string, Diagnostic> validation_source_errors_;
    std::set<std::string> validation_source_paths_;
    std::optional<RoomSessionSnapshot> validation_snapshot_;
    // RAM-only source evidence for a verified imported exact-result generation.
    // The disk cache never persists parsed records or semantic contributions.
    std::optional<RoomSessionSnapshot> imported_clean_validation_;
    std::map<std::string, std::string> imported_clean_sources_;
    std::map<std::string, std::string> imported_clean_revisions_;
    mutable ValidationWork validation_work_;
    mutable bool validation_view_active_ = false;
    struct ValidationContribution {
        bool valid = false;
        bool dirty = false;
        std::vector<Diagnostic> diagnostics;
    };
    mutable std::map<std::string, ValidationContribution> validation_contributions_;
    // Normalized records and their reverse reference edges are reused across
    // validation generations, and invalidated by exact normalized content.
    struct IndexedNormalizedRecord {
        std::string normalized_json;
        std::set<std::string> referenced_ids;
    };
    std::map<std::string, IndexedNormalizedRecord> validation_normalized_records_;
    std::map<std::string, std::set<std::string>> validation_reference_consumers_;
    std::set<std::string> validation_invalidated_owners_;
    std::optional<ValidationResult> validation_room_map_cache_;
    std::map<std::string, std::string> shader_overlays_;
    std::map<std::string, std::string> text_source_overlays_;
    // Baseline at the first unsaved text edit. Source observation may advance
    // the *current* disk revision, but must never rebase an overlay silently.
    std::map<std::string, std::string> text_overlay_disk_revisions_;
    std::map<std::string, std::string> inline_text_sources_;
    std::map<std::string, std::string> inline_source_diagnostic_paths_;
    std::set<std::string> text_source_paths_;
    std::map<std::string, std::string> text_disk_revisions_;
    std::map<std::string, std::set<std::string>> text_source_owners_;
    std::map<std::string, std::set<std::string>> asset_text_consumers_;
    // Last indexed semantic source per owner. Reindexing an unchanged owner
    // must not revoke a validated localization generation.
    std::map<std::string, std::string> indexed_text_sources_;
    // Referenced Asset normalization is reusable while its exact on-disk YAML
    // revision remains unchanged. A working Asset always takes precedence.
    struct IndexedAsset {
        std::string revision;
        std::optional<std::string> normalized;
    };
    std::map<std::string, IndexedAsset> indexed_asset_sources_;
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
