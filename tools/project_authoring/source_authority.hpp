#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>
#include "yaml_codec.hpp"

namespace noveltea::authoring {

// Common physical-byte identity used by the YAML session and source observer.
std::string exact_source_revision(std::string_view bytes);

// Opt-in, per-physical-read diagnostics. The caller supplies the proof phase;
// this never authorizes digest reuse across separate observations.
void trace_exact_asset_proof(std::string_view phase, std::string_view relative_path,
                             std::size_t bytes) noexcept;
void trace_source_proof_event(std::string_view phase, std::string_view event,
                              std::size_t count = 1) noexcept;

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

// Physical evidence from one SourceAuthority capture. The bytes, parsed
// source, and exact revision always describe the same read. Binary media is
// excluded; its physical change identity stays in SourceAuthority revisions.
struct VerifiedProjectSource {
    std::string revision;
    std::string bytes;
    std::optional<YamlSourceResult> yaml;
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
    // Synchronous callers may inspect the immutable observed map without
    // copying it. Never retain this pointer across observe()/writes.
    const std::map<std::string, std::string>* verified_revisions_view() const noexcept;
    // Counts full physical scans (including retries) by this resident authority.
    std::uint64_t source_capture_count() const noexcept { return source_capture_count_; }
    // Physical Asset media changes do not change the Asset's YAML revision.
    // Return the owning YAML records whose local membership checks must be
    // repeated after a proven physical observation.
    std::set<std::string> affected_asset_records(const SourceDelta& delta) const;
    const VerifiedProjectSource* verified_source(std::string_view relative_path) const;
    std::vector<std::string> verified_yaml_paths(std::string_view directory) const;
    const std::filesystem::path& root() const { return root_; }

private:
    struct NativeWatch;
    struct Capture {
        std::map<std::string, std::string> revisions;
        std::set<std::string> directories;
        std::map<std::string, std::set<std::string>> asset_references;
        std::vector<InvalidSource> invalid_sources;
        std::map<std::string, std::shared_ptr<const VerifiedProjectSource>, std::less<>> sources;
    };
    Capture capture() const;
    void arm(const std::set<std::string>& directories);

    std::filesystem::path root_;
    std::filesystem::path canonical_root_;
    std::map<std::string, std::string> baseline_;
    std::map<std::string, std::set<std::string>> asset_references_;
    std::vector<InvalidSource> invalid_sources_;
    std::map<std::string, std::shared_ptr<const VerifiedProjectSource>, std::less<>> sources_;
    std::set<std::string> hinted_paths_;
    std::unique_ptr<NativeWatch> native_;
    bool initialized_ = false;
    bool uncertain_ = true;
    mutable std::uint64_t source_capture_count_ = 0;
};

// Temporarily makes the current verified generation available to native
// Project admission and localization. Never changes filesystem authority.
// Nesting restores the previous context, including across independent Projects.
class ScopedVerifiedProjectSources {
public:
    explicit ScopedVerifiedProjectSources(const SourceAuthority& authority) noexcept;
    ~ScopedVerifiedProjectSources();
    ScopedVerifiedProjectSources(const ScopedVerifiedProjectSources&) = delete;
    ScopedVerifiedProjectSources& operator=(const ScopedVerifiedProjectSources&) = delete;

private:
    const SourceAuthority* previous_;
};

const VerifiedProjectSource* observed_project_source(const std::filesystem::path& path);
std::vector<std::string> observed_project_yaml_paths(std::string_view directory);
bool has_observed_project_sources() noexcept;

} // namespace noveltea::authoring
