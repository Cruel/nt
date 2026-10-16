#pragma once

#include "contracts.hpp"
#include "source_authority.hpp"
#include "yaml_codec.hpp"
#include "yaml_transaction.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <map>
#include <optional>
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
    std::string normalized_json;      // only populated when native validation succeeds
    bool dirty = false;
    bool valid = false;
    std::vector<Diagnostic> diagnostics;
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
    // The same generic patch/save boundary with a different admitted source owner.
    // Kept parallel to the production workspace until the migration cutover.
    static std::unique_ptr<RoomSession>
    open_project_source(const std::filesystem::path& project_root, std::string& error);

    RoomSessionSnapshot snapshot() const;
    RoomSessionResult patch(std::uint64_t expected_working_revision,
                            const std::vector<RoomPatch>& operations);
    // A scoped Save of this Room only. The expected disk identity must match the
    // admitted source; physical content is also compared exactly before replacement.
    RoomSessionResult save(std::string_view expected_disk_revision,
                           const std::vector<std::string>& invalid_source_paths = {});
    std::unique_ptr<RoomSession> clone() const
    {
        return std::unique_ptr<RoomSession>(new RoomSession(*this));
    }
    const std::filesystem::path& source_path() const { return path_; }
    const std::vector<ProjectFile>& file_inventory() const { return file_inventory_; }

private:
    RoomSession(std::filesystem::path path, std::string room_id, std::string source,
                std::string source_json);
    RoomSessionResult result(bool accepted, std::string error = {}, bool changed = false) const;

    std::filesystem::path path_;
    std::string room_id_;
    std::string disk_source_;
    std::string disk_revision_;
    std::string disk_json_;
    std::string working_json_;
    std::vector<RoomPatch> unsaved_patches_;
    std::uint64_t working_revision_ = 0;
    bool is_project_ = false;
    bool is_map_ = false;
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
    SourceObservation observe_sources() { return source_authority_->observe(); }
    void source_watch_hint(std::string_view path) { source_authority_->hint(path); }
    void source_watch_coverage_lost() { source_authority_->coverage_lost(); }

private:
    ProjectSession(std::unique_ptr<RoomSession> source,
                   std::unique_ptr<SourceAuthority> source_authority, std::filesystem::path root)
        : source_(std::move(source)), source_authority_(std::move(source_authority)),
          root_(std::move(root))
    {
    }
    std::unique_ptr<RoomSession> source_;
    std::unique_ptr<SourceAuthority> source_authority_;
    std::filesystem::path root_;
    std::map<std::string, std::unique_ptr<RoomSession>> records_;
    std::uint64_t working_revision_ = 0;
};

} // namespace noveltea::authoring
