#include "source_authority.hpp"
#include "validation_work_instrumentation.hpp"

#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <system_error>
#include <utility>

#ifdef __linux__
#include <sys/inotify.h>
#include <unistd.h>
#endif

namespace noveltea::authoring {

void trace_exact_asset_proof(std::string_view phase, std::string_view relative_path,
                             std::size_t bytes) noexcept
{
    static const bool enabled = std::getenv("NOVELTEA_NATIVE_PROOF_TRACE") != nullptr;
    if (enabled)
        std::fprintf(stderr, "[native-proof] phase=%.*s asset=%.*s bytes=%zu hashes=1 reads=1\n",
                     static_cast<int>(phase.size()), phase.data(),
                     static_cast<int>(relative_path.size()), relative_path.data(), bytes);
}

void trace_source_proof_event(std::string_view phase, std::string_view event,
                              std::size_t count) noexcept
{
    static const bool enabled = std::getenv("NOVELTEA_NATIVE_PROOF_TRACE") != nullptr;
    if (enabled)
        std::fprintf(stderr, "[native-proof] phase=%.*s event=%.*s count=%zu\n",
                     static_cast<int>(phase.size()), phase.data(), static_cast<int>(event.size()),
                     event.data(), count);
}

namespace {
thread_local const SourceAuthority* current_project_sources = nullptr;
}

ScopedVerifiedProjectSources::ScopedVerifiedProjectSources(
    const SourceAuthority& authority) noexcept
    : previous_(std::exchange(current_project_sources, &authority))
{
}
ScopedVerifiedProjectSources::~ScopedVerifiedProjectSources()
{
    current_project_sources = previous_;
}

const VerifiedProjectSource* observed_project_source(const std::filesystem::path& path)
{
    if (!current_project_sources)
        return nullptr;
    const auto relative = std::filesystem::absolute(path).lexically_normal().lexically_relative(
        current_project_sources->root());
    if (relative.empty() || *relative.begin() == ".." || relative.is_absolute())
        return nullptr;
    return current_project_sources->verified_source(relative.generic_string());
}

std::vector<std::string> observed_project_yaml_paths(std::string_view directory)
{
    return current_project_sources ? current_project_sources->verified_yaml_paths(directory)
                                   : std::vector<std::string>{};
}

bool has_observed_project_sources() noexcept
{
    return current_project_sources != nullptr && !current_project_sources->uncertain();
}

namespace {
using Json = jsoncons::ojson;

constexpr std::array fixed_sources{
    "project.yaml",       "traits.yaml",           "editor.yaml",        "i18n/project.yaml",
    "i18n/messages.yaml", "i18n/usage-notes.yaml", "i18n/tracking.yaml", "i18n/orphans.yaml",
    "project.json",       "traits.json",           "editor.json",        "i18n/project.json",
    "i18n/messages.json", "i18n/usage-notes.json", "i18n/tracking.json", "i18n/orphans.json"};

bool is_source_extension(const std::filesystem::path& path)
{
    return path.extension() == ".yaml" || path.extension() == ".json" ||
           path.extension() == ".lua" || path.extension() == ".rml" || path.extension() == ".rcss";
}

std::string read_exact_bytes(const std::filesystem::path& path,
                             std::filesystem::file_time_type* observed_time = nullptr)
{
    count_validation_work<WorkCounter::FileByteReads>();
    const auto before_size = std::filesystem::file_size(path);
    const auto before_time = std::filesystem::last_write_time(path);
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read Project source: " + path.string());
    if (before_size > static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
        throw std::runtime_error("Project source is too large: " + path.string());
    std::string bytes(static_cast<std::size_t>(before_size), '\0');
    if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
        throw std::runtime_error("Project source changed during physical observation: " +
                                 path.string());
    if (input.bad() || bytes.size() != before_size ||
        std::filesystem::file_size(path) != before_size ||
        std::filesystem::last_write_time(path) != before_time)
        throw std::runtime_error("Project source changed during physical observation: " +
                                 path.string());
    count_validation_work<WorkCounter::FileBytesRead>(bytes.size());
    if (observed_time)
        *observed_time = before_time;
    return bytes;
}

bool contained(const std::filesystem::path& canonical_root, const std::filesystem::path& candidate)
{
    const auto relative =
        std::filesystem::weakly_canonical(candidate).lexically_relative(canonical_root);
    return !relative.empty() && relative != ".." && *relative.begin() != "..";
}

void referenced_paths(const Json& value, std::set<std::string>& referenced)
{
    if (!value.is_object())
        return;
    const auto& data =
        value.contains("data") && value.at("data").is_object() ? value.at("data") : value;
    if (data.contains("source") && data.at("source").is_object()) {
        const auto& source = data.at("source");
        if (source.contains("path") && source.at("path").is_string())
            referenced.insert(source.at("path").as<std::string>());
    }
    if (data.contains("attachments") && data.at("attachments").is_array())
        for (const auto& attachment : data.at("attachments").array_range())
            if (attachment.is_object() && attachment.contains("path") &&
                attachment.at("path").is_string())
                referenced.insert(attachment.at("path").as<std::string>());
}

} // namespace

struct SourceAuthority::NativeWatch {
#ifdef __linux__
    int fd = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
    std::map<std::string, int> descriptors;
    std::set<int> removed_watches;
    static constexpr auto mask = IN_CREATE | IN_DELETE | IN_MODIFY | IN_CLOSE_WRITE | IN_ATTRIB |
                                 IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE_SELF | IN_MOVE_SELF |
                                 IN_UNMOUNT;

    ~NativeWatch()
    {
        if (fd >= 0)
            close(fd);
    }

    bool reset()
    {
        if (fd >= 0)
            close(fd);
        fd = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
        descriptors.clear();
        removed_watches.clear();
        return fd >= 0;
    }

    bool watch(const std::filesystem::path& root, const std::string& directory)
    {
        if (fd < 0)
            return false;
        if (descriptors.contains(directory))
            return true;
        const auto wd = inotify_add_watch(fd, (root / directory).c_str(), mask);
        if (wd < 0)
            return false;
        // A recycled descriptor with a pending IN_IGNORED has ambiguous
        // ownership; force coverage recovery rather than swallowing its loss.
        if (removed_watches.contains(wd))
            return false;
        descriptors.emplace(directory, wd);
        return true;
    }

    bool drain(bool& observed, std::set<std::string>& hinted_paths)
    {
        if (fd < 0)
            return true;
        alignas(inotify_event) std::array<char, 32768> buffer{};
        while (true) {
            const auto count = read(fd, buffer.data(), buffer.size());
            if (count < 0) {
                if (errno == EAGAIN)
                    return false;
                if (errno == EINTR)
                    continue;
                return true;
            }
            if (count == 0)
                return true;
            for (std::size_t pos = 0; pos < static_cast<std::size_t>(count);) {
                const auto* event = reinterpret_cast<const inotify_event*>(buffer.data() + pos);
                observed = true;
                if (event->len) {
                    for (const auto& [directory, wd] : descriptors)
                        if (event->wd == wd) {
                            const std::string name(event->name, strnlen(event->name, event->len));
                            hinted_paths.insert(directory == "." ? name : directory + "/" + name);
                        }
                }
                if ((event->mask & IN_IGNORED) && removed_watches.erase(event->wd)) {
                    pos += sizeof(inotify_event) + event->len;
                    continue;
                }
                if (event->mask &
                    (IN_Q_OVERFLOW | IN_IGNORED | IN_UNMOUNT | IN_DELETE_SELF | IN_MOVE_SELF))
                    return true;
                pos += sizeof(inotify_event) + event->len;
            }
        }
    }

    bool refresh(const std::filesystem::path& root, const std::set<std::string>& directories)
    {
        if (fd < 0)
            return false;
        for (auto it = descriptors.begin(); it != descriptors.end();) {
            if (directories.contains(it->first)) {
                ++it;
                continue;
            }
            const auto wd = it->second;
            it = descriptors.erase(it);
            // Two in-root aliases may resolve to one inotify watch descriptor.
            // Dropping one alias must not silently unwatch the other.
            const auto still_used =
                std::any_of(descriptors.begin(), descriptors.end(),
                            [&](const auto& item) { return item.second == wd; });
            if (!still_used && inotify_rm_watch(fd, wd) == 0)
                removed_watches.insert(wd);
        }
        bool covered = true;
        for (const auto& directory : directories) {
            if (!watch(root, directory))
                covered = false;
        }
        return covered;
    }
#else
    bool reset() { return true; }
    bool drain(bool&, std::set<std::string>&) { return false; }
    bool watch(const std::filesystem::path&, const std::string&) { return true; }
    bool refresh(const std::filesystem::path&, const std::set<std::string>&) { return true; }
#endif
};

SourceAuthority::SourceAuthority(std::filesystem::path root)
    : root_(std::filesystem::absolute(std::move(root))),
      canonical_root_(std::filesystem::canonical(root_)), native_(std::make_unique<NativeWatch>())
{
}

SourceAuthority::~SourceAuthority() = default;

SourceAuthority::Capture SourceAuthority::capture(const std::set<std::string>* hints) const
{
    ++source_capture_count_;
    count_validation_work<WorkCounter::SourceCaptures>();
    Capture result;
    result.directories.insert(".");
    if (hints) {
        result.members = directory_members_;
        result.symlink_revisions = symlink_revisions_;
    } else if (!native_->watch(root_, "."))
        throw std::runtime_error("Cannot watch Project root during source admission.");
    if (hints) {
        // Watch events are invalidations, not a claim about what the leaf now
        // contains. Refresh only the affected cached membership entry; a new
        // directory is enumerated below with its watch armed first.
        for (const auto& path : *hints) {
            const auto relative = std::filesystem::path(path);
            const auto parent = relative.parent_path().empty()
                                    ? std::string(".")
                                    : relative.parent_path().generic_string();
            auto directory = result.members.find(parent);
            const bool was_directory = result.members.contains(path);
            if (directory == result.members.end() && !was_directory)
                continue; // Fixed sources and referenced media need no directory inventory.
            std::error_code error;
            count_validation_work<WorkCounter::StatReadlinkCalls>();
            const auto status = std::filesystem::symlink_status(root_ / relative, error);
            if (error && error != std::errc::no_such_file_or_directory)
                throw std::filesystem::filesystem_error("Cannot inspect changed Project path",
                                                        root_ / relative, error);
            if (status.type() == std::filesystem::file_type::symlink &&
                !symlink_revisions_.contains(path))
                throw std::runtime_error("Changed Project symlink needs full source readmission: " +
                                         path);
            if (was_directory || status.type() == std::filesystem::file_type::directory) {
                // A replacement may retain the same name but different children.
                for (auto it = result.members.lower_bound(path); it != result.members.end();) {
                    if (it->first == path || it->first.starts_with(path + "/"))
                        it = result.members.erase(it);
                    else
                        break;
                }
            }
            if (directory != result.members.end()) {
                if (status.type() == std::filesystem::file_type::not_found) {
                    directory->second.erase(path);
                } else {
                    directory->second[path] =
                        Capture::Member{status.type() == std::filesystem::file_type::directory,
                                        status.type() == std::filesystem::file_type::regular ||
                                            (status.type() == std::filesystem::file_type::symlink &&
                                             std::filesystem::is_regular_file(root_ / relative)),
                                        status.type() == std::filesystem::file_type::symlink};
                }
            }
        }
    }
    std::set<std::string> assets;
    // Resolve each component of an observed parent once per capture. On POSIX,
    // a normal directory extends its already-resolved parent; only symlinks
    // need canonicalization. Rebuild this evidence at the publication fence.
    // Windows retains full canonicalization for junction/reparse semantics.
    struct PrefixEvidence {
        std::filesystem::path resolved;
        std::filesystem::file_type type;
    };
    std::map<std::filesystem::path, PrefixEvidence> verified_parents;
    const auto resolve_parent = [&](auto&& self, const std::filesystem::path& prefix,
                                    auto& evidence) -> const PrefixEvidence& {
        if (const auto existing = evidence.find(prefix); existing != evidence.end())
            return existing->second;
        const auto parent = prefix.parent_path();
        [[maybe_unused]] const auto& resolved_parent =
            parent.empty() ? canonical_root_ : self(self, parent, evidence).resolved;
        std::error_code error;
        count_validation_work<WorkCounter::StatReadlinkCalls>();
        const auto type = std::filesystem::symlink_status(root_ / prefix, error).type();
        if (error && error != std::errc::no_such_file_or_directory)
            throw std::filesystem::filesystem_error("Cannot inspect Project source directory",
                                                    root_ / prefix, error);
        if (type != std::filesystem::file_type::directory &&
            type != std::filesystem::file_type::not_found &&
            type != std::filesystem::file_type::symlink)
            throw std::runtime_error("Replaced Project source directory: " +
                                     prefix.generic_string());
#ifdef _WIN32
        const auto resolved = std::filesystem::weakly_canonical(root_ / prefix);
#else
        const auto resolved = type == std::filesystem::file_type::symlink
                                  ? std::filesystem::weakly_canonical(root_ / prefix)
                                  : resolved_parent / prefix.filename();
#endif
        const auto within = resolved.lexically_relative(canonical_root_);
        if (within.empty() || within == ".." || *within.begin() == "..")
            throw std::runtime_error("Project source path escapes root: " +
                                     prefix.generic_string());
        return evidence.emplace(prefix, PrefixEvidence{resolved, type}).first->second;
    };
    const auto secure = [&](std::string_view path, std::filesystem::file_status* leaf = nullptr) {
        const std::filesystem::path relative{path};
        if (relative.empty() || relative.is_absolute() || relative != relative.lexically_normal() ||
            *relative.begin() == "..")
            throw std::runtime_error("Project source path escapes root: " + std::string(path));
        const auto parent = relative.parent_path();
        if (!parent.empty())
            resolve_parent(resolve_parent, parent, verified_parents);
        const auto absolute = root_ / relative;
        count_validation_work<WorkCounter::StatReadlinkCalls>();
        const auto status = std::filesystem::symlink_status(absolute);
        if (status.type() == std::filesystem::file_type::symlink &&
            !contained(canonical_root_, absolute))
            throw std::runtime_error("Project source path escapes root: " + std::string(path));
        if (leaf)
            *leaf = status;
        return absolute;
    };
    const auto add = [&](const std::string& relative, bool physical_asset = false) {
        const auto dirty = [&] {
            if (!hints)
                return true;
            for (const auto& hint : *hints)
                if (relative == hint || relative.starts_with(hint + "/"))
                    return true;
            return false;
        }();
        if (!dirty) {
            if (const auto prior = baseline_.find(relative); prior != baseline_.end()) {
                const auto parent = std::filesystem::path(relative).parent_path().generic_string();
                if (watched_directories_.contains(parent))
                    result.directories.insert(parent);
                if (physical_asset || prior->second == "absent") {
                    result.revisions.emplace(relative, prior->second);
                    return;
                }
                if (const auto source = sources_.find(relative);
                    source != sources_.end() && source->second->revision == prior->second) {
                    result.revisions.emplace(relative, prior->second);
                    result.sources.emplace(relative, source->second);
                    return;
                }
            }
        }
        result.symlink_revisions.erase(relative);
        std::filesystem::file_status leaf;
        const auto absolute = secure(relative, &leaf);
        const auto parent = std::filesystem::path(relative).parent_path();
        if (!parent.empty()) {
            const auto type = verified_parents.at(parent).type;
            if (type == std::filesystem::file_type::directory ||
                (type == std::filesystem::file_type::symlink &&
                 std::filesystem::is_directory(root_ / parent))) {
                result.directories.insert(parent.generic_string());
                if (!native_->watch(root_, parent.generic_string()))
                    throw std::runtime_error("Cannot watch Project source parent: " +
                                             parent.generic_string());
            }
        }
        std::error_code ec;
        // symlink_status already proves ordinary leaf type. Only a contained
        // symlink needs a second, following status lookup.
        if (leaf.type() == std::filesystem::file_type::symlink)
            count_validation_work<WorkCounter::StatReadlinkCalls>();
        const auto status = leaf.type() == std::filesystem::file_type::symlink
                                ? std::filesystem::status(absolute, ec)
                                : leaf;
        if (status.type() == std::filesystem::file_type::not_found ||
            ec == std::errc::no_such_file_or_directory) {
            result.revisions.emplace(relative, "absent");
            if (leaf.type() == std::filesystem::file_type::symlink)
                result.symlink_revisions.emplace(relative, "absent");
            return;
        }
        if (ec || !std::filesystem::is_regular_file(status))
            throw std::runtime_error("Cannot observe Project source: " + relative);
        if (physical_asset) {
            // Binary Asset authority is distinct from tracked authoring YAML. A
            // general watch/admission scan must not read potentially huge media.
            // Physical identity is a change hint, not an Asset content hash.
            const auto size = std::filesystem::file_size(absolute);
            const auto modified = std::filesystem::last_write_time(absolute);
            // file_clock's native count can be wider than long long on macOS.
            const auto modified_ns =
                std::chrono::duration_cast<std::chrono::nanoseconds>(modified.time_since_epoch())
                    .count();
            auto physical_revision =
                "physical:" + std::to_string(size) + ":" + std::to_string(modified_ns);
            if (hints && dirty && baseline_.contains(relative)) {
                // An observed write is a new physical generation even when
                // the writer restores size and mtime. A metadata-only hint
                // cannot otherwise distinguish it from the cached proof.
                physical_revision += ":event:" + std::to_string(source_capture_count_);
            }
            result.revisions.emplace(relative, std::move(physical_revision));
            if (leaf.type() == std::filesystem::file_type::symlink)
                result.symlink_revisions.emplace(relative,
                                                 exact_source_revision(read_exact_bytes(absolute)));
        } else {
            std::filesystem::file_time_type modified;
            auto bytes = read_exact_bytes(absolute, &modified);
            auto revision = exact_source_revision(bytes);
            if (leaf.type() == std::filesystem::file_type::symlink)
                result.symlink_revisions.emplace(relative, revision);
            result.revisions.emplace(relative, revision);
            if (const auto prior = sources_.find(relative); prior != sources_.end() &&
                                                            prior->second->revision == revision &&
                                                            prior->second->bytes == bytes) {
                if (prior->second->size == bytes.size() && prior->second->modified == modified) {
                    result.sources.emplace(relative, prior->second);
                } else {
                    // Timestamp-only notifications keep parsed evidence, but
                    // must advance metadata without mutating pinned snapshots.
                    auto updated = std::make_shared<VerifiedProjectSource>(*prior->second);
                    updated->size = bytes.size();
                    updated->modified = modified;
                    result.sources.emplace(relative, std::move(updated));
                }
            } else {
                auto source = std::make_shared<VerifiedProjectSource>();
                source->revision = std::move(revision);
                source->bytes = std::move(bytes);
                source->size = source->bytes.size();
                source->modified = modified;
                if (relative.ends_with(".yaml"))
                    source->yaml = open_yaml_source(source->bytes);
                result.sources.emplace(relative, std::move(source));
            }
        }
    };
    struct InventoryEntry {
        std::filesystem::path filename;
        Capture::Member member;
        const std::filesystem::path& path() const { return filename; }
        bool is_directory() const { return member.directory; }
        bool is_regular_file() const { return member.regular; }
        bool is_symlink() const { return member.symlink; }
    };
    const auto scan = [&](const std::string& directory, auto&& accept) {
        auto current = result.members.find(directory);
        if (current == result.members.end()) {
            std::filesystem::file_status leaf;
            const auto absolute = secure(directory, &leaf);
            const auto status = leaf.type() == std::filesystem::file_type::symlink
                                    ? std::filesystem::status(absolute)
                                    : leaf;
            if (status.type() == std::filesystem::file_type::not_found)
                return;
            if (!std::filesystem::is_directory(status))
                throw std::runtime_error("Replaced Project source directory: " + directory);
            if (!native_->watch(root_, directory))
                throw std::runtime_error("Cannot watch Project source directory: " + directory);
            count_validation_work<WorkCounter::DirectoryEnumerations>();
            auto& membership = result.members[directory];
            for (const auto& entry : std::filesystem::directory_iterator(absolute)) {
                const auto relative = entry.path().lexically_relative(root_).generic_string();
                secure(relative);
                membership.emplace(relative,
                                   Capture::Member{entry.is_directory(), entry.is_regular_file(),
                                                   entry.is_symlink()});
            }
            current = result.members.find(directory);
        }
        result.directories.insert(directory);
        // Copy the direct children because a nested scan may insert into the
        // same membership index. No physical enumeration occurs on warm paths.
        const auto entries = current->second;
        for (const auto& [relative, member] : entries)
            accept(InventoryEntry{root_ / relative, member}, relative);
    };
    for (const auto* path : fixed_sources) {
        add(path);
        const std::string relative(path);
        if (!relative.ends_with(".yaml") || relative == "project.yaml")
            continue; // the manifest controls global source ownership
        const auto revision = result.revisions.at(relative);
        if (const auto prior = baseline_.find(relative);
            prior != baseline_.end() && prior->second == revision) {
            if (const auto invalid = std::find_if(
                    invalid_sources_.begin(), invalid_sources_.end(),
                    [&](const InvalidSource& source) { return source.path == relative; });
                invalid != invalid_sources_.end())
                result.invalid_sources.push_back(*invalid);
            continue;
        }
        std::string error;
        if (revision == "absent") {
            error = "Required tracked YAML source is absent.";
        } else {
            const auto& opened = result.sources.at(relative)->yaml.value();
            if (!opened.accepted) {
                error = opened.error;
            } else if (!Json::parse(opened.source_json).is_object()) {
                error = "Tracked YAML source must be a mapping.";
            }
        }
        if (!error.empty())
            result.invalid_sources.push_back({relative, std::move(error)});
    }
    for (const auto* directory : {"i18n/locales", "i18n/assets"})
        scan(directory, [&](const auto& entry, const std::string& relative) {
            if ((entry.is_regular_file() || entry.is_symlink()) &&
                (entry.path().extension() == ".yaml" || entry.path().extension() == ".json"))
                add(relative);
        });
    scan("records", [&](const auto& collection, const std::string& relative) {
        if (!collection.is_directory())
            throw std::runtime_error("Invalid records collection: " + relative);
        scan(relative, [&](const auto& entry, const std::string& record) {
            if (entry.is_directory()) {
                if (relative != "records/layouts")
                    throw std::runtime_error("Unexpected nested record directory: " + record);
                // A grouped Layout deletion can momentarily leave its empty
                // parent before the writer prunes it. Empty directories have
                // no source identity; any orphan companion remains invalid.
                if (std::filesystem::is_empty(entry.path()))
                    return;
                scan(record, [&](const auto& leaf, const std::string& file) {
                    if ((leaf.is_regular_file() || leaf.is_symlink()) &&
                        is_source_extension(leaf.path()))
                        add(file);
                });
                const auto metadata = record + "/layout.yaml";
                const auto revision = result.revisions.contains(metadata)
                                          ? result.revisions.at(metadata)
                                          : std::string("absent");
                const auto prior = baseline_.find(metadata);
                if (prior != baseline_.end() && prior->second == revision) {
                    if (const auto invalid = std::find_if(
                            invalid_sources_.begin(), invalid_sources_.end(),
                            [&](const InvalidSource& source) { return source.path == metadata; });
                        invalid != invalid_sources_.end())
                        result.invalid_sources.push_back(*invalid);
                } else if (revision == "absent") {
                    result.invalid_sources.push_back(
                        {metadata, "Layout is missing its canonical layout.yaml metadata."});
                } else {
                    const auto& opened = result.sources.at(metadata)->yaml.value();
                    if (!opened.accepted)
                        result.invalid_sources.push_back({metadata, opened.error});
                }
            } else if ((entry.is_regular_file() || entry.is_symlink()) &&
                       is_source_extension(entry.path())) {
                add(record);
                if (relative != "records/assets" && entry.path().extension() == ".yaml") {
                    // Validate the changed physical owner only. Preserve an
                    // already-known invalid owner across unchanged scans, but
                    // never reparse all records on each warm watcher poll.
                    const auto revision = result.revisions.at(record);
                    const auto prior = baseline_.find(record);
                    if (prior != baseline_.end() && prior->second == revision) {
                        if (const auto invalid = std::find_if(
                                invalid_sources_.begin(), invalid_sources_.end(),
                                [&](const InvalidSource& source) { return source.path == record; });
                            invalid != invalid_sources_.end())
                            result.invalid_sources.push_back(*invalid);
                    } else {
                        const auto& opened = result.sources.at(record)->yaml.value();
                        std::string error;
                        if (!opened.accepted)
                            error = opened.error;
                        // Source authority tracks physical syntax failures.
                        // Semantic mismatches (including a changed record ID)
                        // are reported by record validation, not by turning
                        // a valid physical observation non-authoritative.
                        if (!error.empty())
                            result.invalid_sources.push_back({record, std::move(error)});
                    }
                }
                if (relative == "records/assets" && entry.path().extension() == ".yaml") {
                    // A malformed Asset YAML is attributable to this exact physical owner.
                    // Keep previously verified references watched until it is repaired, but
                    // do not treat its invalid source as an admitted semantic generation.
                    const auto& decoded = result.sources.at(record)->yaml.value();
                    const auto revision = result.revisions.at(record);
                    if (const auto prior = baseline_.find(record);
                        prior != baseline_.end() && prior->second == revision) {
                        if (const auto known = asset_references_.find(record);
                            known != asset_references_.end())
                            result.asset_references.emplace(record, known->second);
                        if (const auto invalid = std::find_if(
                                invalid_sources_.begin(), invalid_sources_.end(),
                                [&](const InvalidSource& source) { return source.path == record; });
                            invalid != invalid_sources_.end())
                            result.invalid_sources.push_back(*invalid);
                        return;
                    }
                    std::string error;
                    if (!decoded.accepted) {
                        error = decoded.error;
                    } else {
                        try {
                            const auto value = Json::parse(decoded.source_json);
                            if (!value.is_object() || !value.contains("id") ||
                                !value.at("id").is_string() ||
                                value.at("id").as<std::string>() != entry.path().stem().string()) {
                                error = "Asset record ID must match its physical filename.";
                            } else {
                                std::set<std::string> references;
                                referenced_paths(value, references);
                                result.asset_references.emplace(record, std::move(references));
                            }
                        } catch (const jsoncons::json_exception& e) {
                            error = e.what();
                        }
                    }
                    if (!error.empty()) {
                        result.invalid_sources.push_back({record, std::move(error)});
                        if (const auto known = asset_references_.find(record);
                            known != asset_references_.end())
                            result.asset_references.emplace(record, known->second);
                    }
                }
            }
        });
    });
    const auto scan_tree = [&](const std::string& directory, std::string_view extension) {
        const auto visit = [&](auto&& self, const std::string& parent, int depth) -> void {
            scan(parent, [&](const auto& entry, const std::string& relative) {
                if (depth > 16)
                    throw std::runtime_error(
                        "Project source directory traversal is cyclic or deep: " + relative);
                if (entry.is_directory())
                    self(self, relative, depth + 1);
                else if ((entry.is_regular_file() || entry.is_symlink()) &&
                         (directory == "shaders" || entry.path().extension() == extension))
                    add(relative);
            });
        };
        visit(visit, directory, 0);
    };
    scan_tree("scripts", ".lua");
    scan_tree("shaders", ".sc");

    // Portable workflow members are external validation inputs too. Keep their
    // directory membership under the same watcher as Asset sources, without
    // reading or hashing their binary contents during ordinary observation.
    const auto excluded_workflow = [](std::string_view path) {
        if (path.find('\\') != std::string_view::npos || path.find(':') != std::string_view::npos ||
            path.find('\0') != std::string_view::npos)
            return true;
        for (std::size_t at = 0; at < path.size();) {
            const auto end = path.find('/', at);
            std::string segment(path.substr(at, end == std::string_view::npos ? end : end - at));
            std::transform(segment.begin(), segment.end(), segment.begin(),
                           [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
            if (segment == ".git" || segment == ".hg" || segment == ".svn" ||
                segment == ".noveltea")
                return true;
            if (end == std::string_view::npos)
                break;
            at = end + 1;
        }
        return false;
    };
    const auto scan_workflows = [&](auto&& self, const std::string& parent, int depth) -> void {
        scan(parent, [&](const auto& entry, const std::string& relative) {
            if (excluded_workflow(relative))
                return;
            if (depth > 16)
                throw std::runtime_error("Project workflow directory is too deep: " + relative);
            // A directory symlink is not traversed by the portable bundle's
            // default recursive_directory_iterator either.
            if (entry.is_directory() && !entry.is_symlink())
                self(self, relative, depth + 1);
            else if (entry.is_regular_file())
                add(relative, true);
            else if (!entry.is_directory())
                throw std::runtime_error("Portable Project workflow contains an unsafe entry.");
        });
    };
    scan_workflows(scan_workflows, "workflows", 0);

    if (result.revisions.at("project.yaml") != "absent") {
        const auto& opened = result.sources.at("project.yaml")->yaml.value();
        if (!opened.accepted)
            throw std::runtime_error("Cannot discover Project references: " + opened.error);
        const auto root = Json::parse(opened.source_json);
        if (root.is_object() && root.contains("settings") && root.at("settings").is_object()) {
            const auto& settings = root.at("settings");
            if (settings.contains("distributionNotices") &&
                settings.at("distributionNotices").is_array())
                for (const auto& notice : settings.at("distributionNotices").array_range())
                    if (notice.is_object() && notice.contains("path") &&
                        notice.at("path").is_string())
                        assets.insert(notice.at("path").as<std::string>());
        }
    }
    for (const auto& [record, paths] : result.asset_references) {
        (void)record;
        assets.insert(paths.begin(), paths.end());
    }
    for (const auto& path : assets) {
        try {
            add(path, true);
        } catch (const std::exception&) {
            // An invalid reference is attributable to the owning YAML source,
            // not a reason to abandon observation of unrelated Project sources.
            bool attributed = false;
            for (const auto& [record, references] : result.asset_references)
                if (references.contains(path)) {
                    result.invalid_sources.push_back(
                        {record, "Referenced Asset path is not contained in the Project."});
                    attributed = true;
                }
            if (!attributed)
                result.invalid_sources.push_back(
                    {"project.yaml", "Distribution notice path is not contained in the Project."});
        }
    }
    // A deleted lexical symlink need not appear in an inventory walk. Revoke
    // its previous target proof rather than carrying a stale alias forward.
    for (auto it = result.symlink_revisions.begin(); it != result.symlink_revisions.end();) {
        if (!result.revisions.contains(it->first))
            it = result.symlink_revisions.erase(it);
        else
            ++it;
    }
    if (std::filesystem::canonical(root_) != canonical_root_)
        throw std::runtime_error("Project root changed during physical observation.");
    std::map<std::filesystem::path, PrefixEvidence> final_parents;
    for (const auto& [parent, evidence] : verified_parents) {
        const auto& final = resolve_parent(resolve_parent, parent, final_parents);
        if (final.resolved != evidence.resolved || final.type != evidence.type)
            throw std::runtime_error("Project source directory changed during observation.");
    }
    trace_source_proof_event("source-observation", "complete-capture");
    return result;
}

void SourceAuthority::arm(const std::set<std::string>& directories)
{
    if (!native_->refresh(root_, directories))
        uncertain_ = true;
}

bool SourceAuthority::initialize(std::string& error, bool allow_invalid_sources)
{
    try {
        Capture captured;
        bool stable = false;
        for (int attempt = 0; attempt < 3; ++attempt) {
            captured = capture();
            bool changed_during_admission = false;
            if (native_->drain(changed_during_admission, hinted_paths_))
                throw std::runtime_error("Project watcher lost coverage during admission.");
            if (!changed_during_admission) {
                stable = true;
                break;
            }
        }
        if (!stable)
            throw std::runtime_error("Project changed continuously during source admission.");
        baseline_ = std::move(captured.revisions);
        watched_directories_ = captured.directories;
        directory_members_ = std::move(captured.members);
        sources_ = std::move(captured.sources);
        asset_references_ = std::move(captured.asset_references);
        symlink_revisions_ = std::move(captured.symlink_revisions);
        invalid_sources_ = std::move(captured.invalid_sources);
        if (!allow_invalid_sources && !invalid_sources_.empty()) {
            error = "Project contains an invalid Asset source: " + invalid_sources_.front().path;
            return false;
        }
        initialized_ = true;
        uncertain_ = false;
        arm(captured.directories);
        if (uncertain_)
            throw std::runtime_error("Project watcher could not cover all source directories.");
        hinted_paths_.clear();
        error.clear();
        return true;
    } catch (const std::exception& e) {
        error = e.what();
        return false;
    }
}

bool SourceAuthority::acknowledge_own_write(std::string_view relative_path,
                                            std::string_view revision)
{
    const std::string path(relative_path);
    if (!initialized_)
        return false;
    try {
        const std::filesystem::path relative(path);
        if (relative.is_absolute() || relative != relative.lexically_normal() ||
            !contained(canonical_root_, root_ / relative))
            return false;
        const auto absolute = root_ / relative;
        std::error_code error;
        count_validation_work<WorkCounter::StatReadlinkCalls>();
        const auto status = std::filesystem::symlink_status(absolute, error);
        std::string resident_revision;
        if (revision == "absent") {
            if ((error && error != std::errc::no_such_file_or_directory) ||
                (status.type() != std::filesystem::file_type::not_found &&
                 status.type() != std::filesystem::file_type::none))
                return false;
            resident_revision = "absent";
        } else {
            if (error || !std::filesystem::is_regular_file(status))
                return false;
            const auto bytes = read_exact_bytes(absolute);
            if (!source_revision_matches(bytes, revision))
                return false;
            resident_revision = exact_source_revision(bytes);
        }
        // A journal can create or erase tracked records as well as update an
        // existing source. Own-write evidence pins their exact new physical
        // identity; the next observation must not mistake it for an external
        // addition or leave authority permanently uncertain.
        baseline_.insert_or_assign(path, std::move(resident_revision));
        hinted_paths_.insert(path);
        return true;
    } catch (...) {
        return false;
    }
}

void SourceAuthority::hint(std::string_view relative_path)
{
    const std::filesystem::path relative(relative_path);
    if (relative.empty() || relative.is_absolute() || relative != relative.lexically_normal() ||
        *relative.begin() == "..") {
        coverage_lost();
        return;
    }
    hinted_paths_.insert(relative.generic_string());
}

void SourceAuthority::coverage_lost() { uncertain_ = true; }

std::vector<std::string> SourceAuthority::invalid_source_paths() const
{
    std::vector<std::string> paths;
    paths.reserve(invalid_sources_.size());
    for (const auto& source : invalid_sources_)
        paths.push_back(source.path);
    return paths;
}

std::optional<std::map<std::string, std::string>> SourceAuthority::verified_revisions() const
{
    if (const auto* view = verified_revisions_view())
        return *view;
    return std::nullopt;
}

const std::map<std::string, std::string>* SourceAuthority::verified_revisions_view() const noexcept
{
    return initialized_ && !uncertain_ && invalid_sources_.empty() ? &baseline_ : nullptr;
}

const VerifiedProjectSource* SourceAuthority::verified_source(std::string_view relative) const
{
    if (!initialized_ || uncertain_)
        return nullptr;
    const auto found = sources_.find(relative);
    if (found == sources_.end())
        return nullptr;
    const auto revision = baseline_.find(std::string(relative));
    return revision != baseline_.end() && revision->second == found->second->revision
               ? found->second.get()
               : nullptr;
}

std::vector<std::string> SourceAuthority::verified_yaml_paths(std::string_view directory) const
{
    std::vector<std::string> result;
    if (!initialized_ || uncertain_)
        return result;
    const auto prefix = std::string(directory) + "/";
    for (const auto& [path, source] : sources_)
        if (path.starts_with(prefix) && path.ends_with(".yaml") && verified_source(path))
            result.push_back(path);
    return result;
}

std::set<std::string> SourceAuthority::affected_asset_records(const SourceDelta& delta) const
{
    std::set<std::string> changed;
    changed.insert(delta.added.begin(), delta.added.end());
    changed.insert(delta.changed.begin(), delta.changed.end());
    changed.insert(delta.removed.begin(), delta.removed.end());
    std::set<std::string> records;
    for (const auto& [owner, references] : asset_references_)
        for (const auto& source : references)
            if (changed.contains(source)) {
                records.insert(owner);
                break;
            }
    return records;
}

bool SourceAuthority::fence()
{
    if (!initialized_ || uncertain_)
        return false;
    bool observed = false;
    if (native_->drain(observed, hinted_paths_)) {
        coverage_lost();
        return false;
    }
    // A lexical watch on the source parent cannot observe writes made via an
    // in-root symlink target in an otherwise untracked directory. Reprove only
    // those target bytes, including contained binary aliases, before accepting
    // this pinned generation. A mismatch is a targeted invalidation, not proof
    // of the previous generation.
    for (const auto& [relative, revision] : symlink_revisions_) {
        try {
            const auto path = root_ / relative;
            if (std::filesystem::symlink_status(path).type() !=
                    std::filesystem::file_type::symlink ||
                !contained(canonical_root_, path)) {
                hinted_paths_.insert(relative);
                return false;
            }
            if (revision == "absent") {
                if (std::filesystem::status(path).type() == std::filesystem::file_type::not_found)
                    continue;
            } else if (exact_source_revision(read_exact_bytes(path)) == revision) {
                continue;
            }
            hinted_paths_.insert(relative);
            return false;
        } catch (...) {
            coverage_lost();
            return false;
        }
    }
#ifndef __linux__
    // Without native watcher guarantees, a pinned generation cannot be
    // certified by a cheap fence. Callers must use full physical observation.
    return false;
#else
    // Root-level unrelated files and local editor/cache state are outside
    // source authority. An event without a path is not attributable and
    // requires conservative readmission.
    if (observed && hinted_paths_.empty()) {
        coverage_lost();
        return false;
    }
    for (const auto& path : hinted_paths_) {
        if (path == ".noveltea" || path.starts_with(".noveltea/"))
            continue;
        const bool tracked =
            baseline_.contains(path) || watched_directories_.contains(path) ||
            directory_members_.contains(path) || path == "records" ||
            path.starts_with("records/") || path == "scripts" || path.starts_with("scripts/") ||
            path == "shaders" || path.starts_with("shaders/") || path == "workflows" ||
            path.starts_with("workflows/") || path == "i18n" || path.starts_with("i18n/");
        if (tracked) {
            coverage_lost();
            return false;
        }
    }
    try {
        if (std::filesystem::canonical(root_) != canonical_root_)
            throw std::runtime_error("Project root changed during validation.");
    } catch (...) {
        coverage_lost();
        return false;
    }
    return true;
#endif
}

SourceObservation SourceAuthority::observe()
{
    SourceObservation observation;
    if (!initialized_) {
        observation.error = "Project source authority was not initialized.";
        return observation;
    }
    bool observed = false;
    if (native_->drain(observed, hinted_paths_))
        uncertain_ = true;
    // Unwatched resolved targets must never be silently reused on a warm
    // observation, even when no event reached the lexical source directory.
    for (const auto& [relative, _] : symlink_revisions_)
        hinted_paths_.insert(relative);
    observation.full_rescan = uncertain_;
    try {
        // Arm the replacement watcher *before* a recovery capture. Resetting
        // after the capture would leave a blind window between proof and watch.
        if (uncertain_ && !native_->reset())
            throw std::runtime_error("Cannot restore Project watcher coverage.");
        // If native notifications arrive during a scan, the scanned set is not
        // necessarily a single stable physical generation. Retry instead of
        // publishing an unprovable snapshot as current.
        Capture captured;
        bool stable = false;
        for (int attempt = 0; attempt < 3; ++attempt) {
#ifdef __linux__
            captured = capture(uncertain_ ? nullptr : &hinted_paths_);
#else
            captured = capture(); // No native watcher: re-prove every physical generation.
#endif
            bool during_scan = false;
            if (native_->drain(during_scan, hinted_paths_)) {
                uncertain_ = true;
                observation.full_rescan = true;
                if (!native_->reset())
                    throw std::runtime_error("Cannot restore Project watcher coverage.");
                during_scan = true;
            }
            if (!during_scan) {
                stable = true;
                break;
            }
        }
        if (!stable)
            throw std::runtime_error("Project changed continuously during physical observation.");
        if (observation.full_rescan)
            trace_source_proof_event("source-observation", "watcher-recovery");
        for (const auto& [path, revision] : captured.revisions) {
            const auto previous = baseline_.find(path);
            const auto prior = previous == baseline_.end() ? "absent" : previous->second;
            if (revision == prior)
                continue;
            if (revision == "absent")
                observation.delta.removed.push_back(path);
            else if (prior == "absent")
                observation.delta.added.push_back(path);
            else
                observation.delta.changed.push_back(path);
        }
        for (const auto& [path, revision] : baseline_)
            if (!captured.revisions.contains(path) && revision != "absent")
                observation.delta.removed.push_back(path);
        for (const auto& path : observation.delta.added)
            observation.delta_revisions[path] = captured.revisions.at(path);
        for (const auto& path : observation.delta.changed)
            observation.delta_revisions[path] = captured.revisions.at(path);
        for (const auto& path : observation.delta.removed)
            observation.delta_revisions[path] = "absent";
        observation.invalid_sources = std::move(captured.invalid_sources);
        observation.scoped_authority = true;
        observation.authoritative = observation.invalid_sources.empty();
        observation.unchanged = observation.authoritative && observation.delta.added.empty() &&
                                observation.delta.changed.empty() &&
                                observation.delta.removed.empty();
        baseline_ = std::move(captured.revisions);
        watched_directories_ = captured.directories;
        directory_members_ = std::move(captured.members);
        sources_ = std::move(captured.sources);
        asset_references_ = std::move(captured.asset_references);
        symlink_revisions_ = std::move(captured.symlink_revisions);
        invalid_sources_ = observation.invalid_sources;
        uncertain_ = false;
        arm(captured.directories);
        if (uncertain_)
            throw std::runtime_error("Project watcher could not cover all source directories.");
        observation.watch_paths.assign(hinted_paths_.begin(), hinted_paths_.end());
        hinted_paths_.clear();
    } catch (const std::exception& e) {
        trace_source_proof_event("source-observation", "conflict");
        uncertain_ = true;
        observation.full_rescan = true;
        observation.error = e.what();
    }
    return observation;
}

} // namespace noveltea::authoring
