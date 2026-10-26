#pragma once

#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {

// Common physical-byte identity used by the YAML session and source observer.
std::string exact_source_revision(std::string_view bytes);

struct SourceDelta {
    std::vector<std::string> added;
    std::vector<std::string> changed;
    std::vector<std::string> removed;
};

struct InvalidSource {
    std::string path; // safely attributable physical YAML owner
    std::string error;
};

struct SourceObservation {
    // False means no cache or admitted snapshot may be certified current.
    bool authoritative = false;
    // The physical inventory was verified, but known invalid owned sources
    // prevent whole-Project admission. Unrelated targets retain scoped proof.
    bool scoped_authority = false;
    bool unchanged = false;
    bool full_rescan = false;
    std::string error;
    SourceDelta delta;
    // Exact physical identities for changed/added paths, or 'absent' for deletions.
    std::map<std::string, std::string> delta_revisions;
    std::vector<InvalidSource> invalid_sources;
    std::vector<std::string> watch_paths;
};

// Each editor/daemon Project session owns an independent instance. OS events are
// scheduling hints, never evidence of a physical source revision. A successful
// observation re-discovers canonical source membership and hashes exact bytes.
// Neither an Asset's unrelated neighbors nor arbitrary Project-root files are read.
class SourceAuthority {
public:
    explicit SourceAuthority(std::filesystem::path root);
    ~SourceAuthority();
    SourceAuthority(const SourceAuthority&) = delete;
    SourceAuthority& operator=(const SourceAuthority&) = delete;

    // Establish a baseline. This is separate from observe so initial sources do
    // not appear as externally added files.
    bool initialize(std::string& error, bool allow_invalid_sources = false);
    SourceObservation observe();
    // Adopt only a successfully persisted source whose current bytes still
    // prove the writer's revision. Other external changes remain observable.
    bool acknowledge_own_write(std::string_view relative_path, std::string_view revision);
    void hint(std::string_view relative_path);
    void coverage_lost(); // watcher errors, overflow, resume, or a replaced directory
    bool uncertain() const { return uncertain_; }
    std::vector<std::string> invalid_source_paths() const;
    // Only usable after a successful full observation; never a watcher-only proof.
    std::optional<std::map<std::string, std::string>> verified_revisions() const;
    // Physical Asset media changes do not change the Asset's YAML revision.
    // Return the owning YAML records whose local membership checks must be
    // repeated after a proven physical observation.
    std::set<std::string> affected_asset_records(const SourceDelta& delta) const;

private:
    struct NativeWatch;
    struct Capture {
        std::map<std::string, std::string> revisions;
        std::set<std::string> directories;
        std::map<std::string, std::set<std::string>> asset_references;
        std::vector<InvalidSource> invalid_sources;
    };
    Capture capture() const;
    void arm(const std::set<std::string>& directories);

    std::filesystem::path root_;
    std::filesystem::path canonical_root_;
    std::map<std::string, std::string> baseline_;
    std::map<std::string, std::set<std::string>> asset_references_;
    std::vector<InvalidSource> invalid_sources_;
    std::set<std::string> hinted_paths_;
    std::unique_ptr<NativeWatch> native_;
    bool initialized_ = false;
    bool uncertain_ = true;
};

} // namespace noveltea::authoring
