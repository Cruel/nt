#pragma once

#include "contracts.hpp"
#include "yaml_codec.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
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

// A parallel, single-Room certification slice of the future resident Project session.
// No editor, CLI, or runtime production path creates this session yet.
class RoomSession {
public:
    static std::unique_ptr<RoomSession> open(const std::filesystem::path& project_root,
                                             std::string room_id, std::string& error);

    RoomSessionSnapshot snapshot() const;
    RoomSessionResult patch(std::uint64_t expected_working_revision,
                            const std::vector<RoomPatch>& operations);
    // A scoped Save of this Room only. The expected disk identity must match the
    // admitted source; physical content is also compared exactly before replacement.
    RoomSessionResult save(std::string_view expected_disk_revision);
    const std::filesystem::path& source_path() const { return path_; }

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
};

} // namespace noveltea::authoring
