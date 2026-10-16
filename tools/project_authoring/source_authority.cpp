#include "source_authority.hpp"

#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <system_error>
#include <utility>

#ifdef __linux__
#include <sys/inotify.h>
#include <unistd.h>
#endif

namespace noveltea::authoring {
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

std::string read_exact_bytes(const std::filesystem::path& path)
{
    const auto before_size = std::filesystem::file_size(path);
    const auto before_time = std::filesystem::last_write_time(path);
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read Project source: " + path.string());
    std::string bytes{std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
    if (input.bad() || bytes.size() != before_size ||
        std::filesystem::file_size(path) != before_size ||
        std::filesystem::last_write_time(path) != before_time)
        throw std::runtime_error("Project source changed during physical observation: " +
                                 path.string());
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
        return fd >= 0;
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
                            break;
                        }
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
            inotify_rm_watch(fd, it->second);
            it = descriptors.erase(it);
        }
        constexpr auto mask = IN_CREATE | IN_DELETE | IN_CLOSE_WRITE | IN_ATTRIB | IN_MOVED_FROM |
                              IN_MOVED_TO | IN_DELETE_SELF | IN_MOVE_SELF | IN_UNMOUNT;
        bool covered = true;
        for (const auto& directory : directories) {
            if (descriptors.contains(directory))
                continue;
            const auto wd = inotify_add_watch(fd, (root / directory).c_str(), mask);
            if (wd < 0)
                covered = false;
            else
                descriptors.emplace(directory, wd);
        }
        return covered;
    }
#else
    bool reset() { return true; }
    bool drain(bool&, std::set<std::string>&) { return false; }
    bool refresh(const std::filesystem::path&, const std::set<std::string>&) { return true; }
#endif
};

SourceAuthority::SourceAuthority(std::filesystem::path root)
    : root_(std::filesystem::absolute(std::move(root))),
      canonical_root_(std::filesystem::canonical(root_)), native_(std::make_unique<NativeWatch>())
{
}

SourceAuthority::~SourceAuthority() = default;

SourceAuthority::Capture SourceAuthority::capture() const
{
    Capture result;
    result.directories.insert(".");
    std::set<std::string> assets;
    const auto secure = [&](std::string_view path) {
        const std::filesystem::path relative{path};
        if (relative.empty() || relative.is_absolute() || relative != relative.lexically_normal() ||
            *relative.begin() == ".." || !contained(canonical_root_, root_ / relative))
            throw std::runtime_error("Project source path escapes root: " + std::string(path));
        return root_ / relative;
    };
    const auto read = [&](const std::string& relative) -> std::string {
        const auto absolute = secure(relative);
        std::error_code ec;
        const auto status = std::filesystem::status(absolute, ec);
        if (status.type() == std::filesystem::file_type::not_found ||
            ec == std::errc::no_such_file_or_directory)
            return {};
        if (ec || !std::filesystem::is_regular_file(status))
            throw std::runtime_error("Cannot observe Project source: " + relative);
        return read_exact_bytes(absolute);
    };
    const auto add = [&](const std::string& relative) {
        const auto absolute = secure(relative);
        const auto parent = std::filesystem::path(relative).parent_path();
        if (!parent.empty() && std::filesystem::is_directory(root_ / parent))
            result.directories.insert(parent.generic_string());
        std::error_code ec;
        const auto status = std::filesystem::status(absolute, ec);
        if (status.type() == std::filesystem::file_type::not_found ||
            ec == std::errc::no_such_file_or_directory) {
            result.revisions.emplace(relative, "absent");
            return;
        }
        if (ec || !std::filesystem::is_regular_file(status))
            throw std::runtime_error("Cannot observe Project source: " + relative);
        result.revisions.emplace(relative, exact_source_revision(read_exact_bytes(absolute)));
    };
    const auto scan = [&](const std::string& directory, auto&& accept) {
        const auto absolute = secure(directory);
        if (!std::filesystem::exists(absolute))
            return;
        if (!std::filesystem::is_directory(absolute))
            throw std::runtime_error("Replaced Project source directory: " + directory);
        result.directories.insert(directory);
        for (const auto& entry : std::filesystem::directory_iterator(absolute)) {
            const auto relative = entry.path().lexically_relative(root_).generic_string();
            secure(relative);
            accept(entry, relative);
        }
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
            const auto source = read(relative);
            const auto opened = open_yaml_source(source);
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
            if (entry.is_regular_file() &&
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
                scan(record, [&](const auto& leaf, const std::string& file) {
                    if (leaf.is_regular_file() && is_source_extension(leaf.path()))
                        add(file);
                });
            } else if (entry.is_regular_file() && is_source_extension(entry.path())) {
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
                        const auto bytes = read(record);
                        if (exact_source_revision(bytes) != revision)
                            throw std::runtime_error("Record changed during observation: " +
                                                     record);
                        const auto opened = open_yaml_source(bytes);
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
                    const auto bytes = read(record);
                    if (exact_source_revision(bytes) != result.revisions.at(record))
                        throw std::runtime_error(
                            "Asset source changed during physical observation: " + record);
                    const auto decoded = open_yaml_source(bytes);
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
        const auto absolute = secure(directory);
        if (!std::filesystem::exists(absolute))
            return;
        if (!std::filesystem::is_directory(absolute))
            throw std::runtime_error("Replaced Project source directory: " + directory);
        for (std::filesystem::recursive_directory_iterator
                 it(absolute, std::filesystem::directory_options::follow_directory_symlink),
             end;
             it != end; ++it) {
            const auto relative = it->path().lexically_relative(root_).generic_string();
            secure(relative);
            if (it.depth() > 16)
                throw std::runtime_error("Project source directory traversal is cyclic or deep: " +
                                         relative);
            if (it->is_directory())
                result.directories.insert(relative);
            else if (it->is_regular_file() && it->path().extension() == extension)
                add(relative);
        }
    };
    scan_tree("scripts", ".lua");
    scan_tree("shaders", ".sc");

    const auto manifest = read("project.yaml");
    if (result.revisions.at("project.yaml") != "absent") {
        const auto opened = open_yaml_source(manifest);
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
    for (const auto& path : assets)
        add(path);
    return result;
}

void SourceAuthority::arm(const std::set<std::string>& directories)
{
    if (!native_->refresh(root_, directories))
        uncertain_ = true;
}

bool SourceAuthority::initialize(std::string& error)
{
    try {
        auto captured = capture();
        baseline_ = std::move(captured.revisions);
        asset_references_ = std::move(captured.asset_references);
        invalid_sources_ = std::move(captured.invalid_sources);
        if (!invalid_sources_.empty()) {
            error = "Project contains an invalid Asset source: " + invalid_sources_.front().path;
            return false;
        }
        initialized_ = true;
        uncertain_ = false;
        arm(captured.directories);
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
    if (!initialized_ || !baseline_.contains(path))
        return false;
    try {
        const std::filesystem::path relative(path);
        if (relative.is_absolute() || relative != relative.lexically_normal() ||
            !contained(canonical_root_, root_ / relative))
            return false;
        if (exact_source_revision(read_exact_bytes(root_ / relative)) != revision)
            return false;
        baseline_[path] = revision;
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
    observation.full_rescan = uncertain_;
    try {
        // If native notifications arrive during a scan, the scanned set is not
        // necessarily a single stable physical generation. Retry instead of
        // publishing an unprovable snapshot as current.
        Capture captured;
        bool stable = false;
        for (int attempt = 0; attempt < 3; ++attempt) {
            captured = capture();
            bool during_scan = false;
            if (native_->drain(during_scan, hinted_paths_)) {
                uncertain_ = true;
                observation.full_rescan = true;
            }
            if (!during_scan) {
                stable = true;
                break;
            }
        }
        if (!stable)
            throw std::runtime_error("Project changed continuously during physical observation.");
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
        asset_references_ = std::move(captured.asset_references);
        invalid_sources_ = observation.invalid_sources;
        if (uncertain_ && !native_->reset())
            observation.full_rescan = true;
        uncertain_ = false;
        arm(captured.directories);
        observation.watch_paths.assign(hinted_paths_.begin(), hinted_paths_.end());
        hinted_paths_.clear();
    } catch (const std::exception& e) {
        uncertain_ = true;
        observation.full_rescan = true;
        observation.error = e.what();
    }
    return observation;
}

} // namespace noveltea::authoring
