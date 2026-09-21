#include "tooling_project_authority.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <sys/stat.h>
#if defined(__linux__)
#include <poll.h>
#include <sys/eventfd.h>
#include <sys/inotify.h>
#include <unistd.h>
#endif
#endif

namespace noveltea::tooling::daemon {
namespace {

namespace fs = std::filesystem;

constexpr std::uint64_t kJavaScriptSafeIntegerMax = 9007199254740991ULL;
constexpr std::size_t kObservationAttempts = 3;

std::string path_utf8(const fs::path& path)
{
    const auto value = path.generic_u8string();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
}

fs::path path_from_utf8(std::string_view value)
{
    const auto* first = reinterpret_cast<const char8_t*>(value.data());
    return fs::path(std::u8string(first, first + value.size()));
}

std::string slash_path(std::string value)
{
    std::replace(value.begin(), value.end(), '\\', '/');
    return value;
}

bool starts_with_path(std::string_view path, std::string_view prefix)
{
    return path == prefix ||
           (path.size() > prefix.size() && path.starts_with(prefix) && path[prefix.size()] == '/');
}

std::string normalize_relative_path(std::string value, bool allow_empty = false,
                                    bool preserve_trailing_slash = false)
{
    if (value.find('\0') != std::string::npos)
        throw std::invalid_argument("Project source path contains an embedded NUL");
    value = slash_path(std::move(value));
    const bool trailing_slash = preserve_trailing_slash && value.ends_with('/');
    if (value.starts_with('/') ||
        (value.size() >= 3 && std::isalpha(static_cast<unsigned char>(value[0])) != 0 &&
         value[1] == ':' && value[2] == '/'))
        throw std::invalid_argument("Project source path must be relative to the Project root");

    std::vector<std::string> segments;
    std::size_t offset = 0;
    while (offset <= value.size()) {
        const auto slash = value.find('/', offset);
        const auto end = slash == std::string::npos ? value.size() : slash;
        auto segment = value.substr(offset, end - offset);
        if (!segment.empty() && segment != ".") {
            if (segment == "..")
                throw std::invalid_argument("Project source path escapes the Project root");
            segments.push_back(std::move(segment));
        }
        if (slash == std::string::npos)
            break;
        offset = slash + 1;
    }

    std::string normalized;
    for (const auto& segment : segments) {
        if (!normalized.empty())
            normalized.push_back('/');
        normalized += segment;
    }
    if (normalized.empty() && !allow_empty)
        throw std::invalid_argument("Project source path must not be empty");
    if (trailing_slash && !normalized.empty())
        normalized.push_back('/');
    return normalized;
}

fs::path canonical_project_root(const fs::path& project_root)
{
    std::error_code error;
    auto canonical = fs::canonical(project_root, error);
    if (error || canonical.empty())
        throw std::runtime_error("Cannot resolve canonical Project root");
    if (!fs::is_directory(canonical, error) || error)
        throw std::runtime_error("Canonical Project root is not a directory");
    return canonical.lexically_normal();
}

bool path_within_root(const fs::path& path, const fs::path& root)
{
    auto path_it = path.begin();
    auto root_it = root.begin();
    for (; root_it != root.end(); ++root_it, ++path_it) {
        if (path_it == path.end() || *path_it != *root_it)
            return false;
    }
    return true;
}

struct NormalizedConfig {
    std::vector<std::string> authoritative_paths;
    std::vector<ProjectSourceDiscoveryScope> discovery_scopes;

    friend bool operator==(const NormalizedConfig&, const NormalizedConfig&) = default;
};

void sort_unique(std::vector<std::string>& values)
{
    std::sort(values.begin(), values.end());
    values.erase(std::unique(values.begin(), values.end()), values.end());
}

NormalizedConfig normalize_config(const ProjectAuthorityRequest& request)
{
    NormalizedConfig result;
    result.authoritative_paths.reserve(request.authoritative_paths.size());
    for (const auto& path : request.authoritative_paths)
        result.authoritative_paths.push_back(normalize_relative_path(path));
    sort_unique(result.authoritative_paths);

    result.discovery_scopes.reserve(request.discovery_scopes.size());
    for (const auto& scope : request.discovery_scopes) {
        ProjectSourceDiscoveryScope normalized;
        normalized.root = normalize_relative_path(scope.root);
        normalized.extensions = scope.extensions;
        if (normalized.extensions.empty())
            throw std::invalid_argument("Project source discovery scope requires an extension");
        for (auto& extension : normalized.extensions) {
            if (extension.empty() || extension.find('/') != std::string::npos ||
                extension.find('\\') != std::string::npos)
                throw std::invalid_argument("Project source discovery extension is invalid");
        }
        sort_unique(normalized.extensions);
        normalized.excluded_prefixes.reserve(scope.excluded_prefixes.size());
        for (const auto& prefix : scope.excluded_prefixes)
            normalized.excluded_prefixes.push_back(normalize_relative_path(prefix, false, true));
        sort_unique(normalized.excluded_prefixes);
        result.discovery_scopes.push_back(std::move(normalized));
    }
    std::sort(result.discovery_scopes.begin(), result.discovery_scopes.end(),
              [](const auto& left, const auto& right) {
                  if (left.root != right.root)
                      return left.root < right.root;
                  if (left.extensions != right.extensions)
                      return left.extensions < right.extensions;
                  return left.excluded_prefixes < right.excluded_prefixes;
              });
    result.discovery_scopes.erase(
        std::unique(result.discovery_scopes.begin(), result.discovery_scopes.end()),
        result.discovery_scopes.end());
    return result;
}

bool scope_excludes(const ProjectSourceDiscoveryScope& scope, std::string_view relative)
{
    for (const auto& prefix : scope.excluded_prefixes) {
        auto exact = std::string_view(prefix);
        if (exact.ends_with('/'))
            exact.remove_suffix(1);
        if (relative == exact || relative.starts_with(prefix))
            return true;
    }
    return false;
}

bool matches_extension(const ProjectSourceDiscoveryScope& scope, std::string_view relative)
{
    if (scope_excludes(scope, relative))
        return false;
    return std::any_of(
        scope.extensions.begin(), scope.extensions.end(),
        [relative](const std::string& extension) { return relative.ends_with(extension); });
}

bool event_relevant(const NormalizedConfig& config, std::string_view relative, bool directory)
{
    for (const auto& authoritative : config.authoritative_paths) {
        if (relative == authoritative || (directory && starts_with_path(authoritative, relative)))
            return true;
    }
    for (const auto& scope : config.discovery_scopes) {
        if (scope_excludes(scope, relative))
            continue;
        if (directory) {
            if (starts_with_path(relative, scope.root) || starts_with_path(scope.root, relative))
                return true;
            continue;
        }
        if (starts_with_path(relative, scope.root) && matches_extension(scope, relative))
            return true;
    }
    return false;
}

std::optional<std::uint64_t> native_mtime_nanoseconds(const fs::path& path)
{
#if defined(_WIN32)
    WIN32_FILE_ATTRIBUTE_DATA info{};
    if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &info) == 0)
        return std::nullopt;
    ULARGE_INTEGER file_time{};
    file_time.LowPart = info.ftLastWriteTime.dwLowDateTime;
    file_time.HighPart = info.ftLastWriteTime.dwHighDateTime;
    constexpr std::uint64_t kUnixEpochFileTimeTicks = 116444736000000000ULL;
    if (file_time.QuadPart < kUnixEpochFileTimeTicks)
        return std::nullopt;
    const auto unix_ticks = file_time.QuadPart - kUnixEpochFileTimeTicks;
    if (unix_ticks > std::numeric_limits<std::uint64_t>::max() / 100ULL)
        return std::nullopt;
    return unix_ticks * 100ULL;
#else
    struct stat info {};
    if (::lstat(path.c_str(), &info) != 0)
        return std::nullopt;
#if defined(__APPLE__)
    const auto seconds = info.st_mtimespec.tv_sec;
    const auto nanoseconds = info.st_mtimespec.tv_nsec;
#else
    const auto seconds = info.st_mtim.tv_sec;
    const auto nanoseconds = info.st_mtim.tv_nsec;
#endif
    if (seconds < 0 || nanoseconds < 0 || nanoseconds >= 1'000'000'000L)
        return std::nullopt;
    const auto seconds_u64 = static_cast<std::uint64_t>(seconds);
    constexpr std::uint64_t kNanosecondsPerSecond = 1'000'000'000ULL;
    if (seconds_u64 >
        (std::numeric_limits<std::uint64_t>::max() - static_cast<std::uint64_t>(nanoseconds)) /
            kNanosecondsPerSecond)
        return std::nullopt;
    return seconds_u64 * kNanosecondsPerSecond + static_cast<std::uint64_t>(nanoseconds);
#endif
}

std::string native_source_identity(const fs::path& path)
{
#if defined(_WIN32)
    const auto handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        throw std::runtime_error("Cannot inspect exact Project source identity");
    BY_HANDLE_FILE_INFORMATION info{};
    const bool inspected = GetFileInformationByHandle(handle, &info) != 0;
    CloseHandle(handle);
    if (!inspected)
        throw std::runtime_error("Cannot inspect exact Project source identity");
    const auto file_index = (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32U) |
                            static_cast<std::uint64_t>(info.nFileIndexLow);
    return "win:" + std::to_string(static_cast<std::uint64_t>(info.dwVolumeSerialNumber)) + ":" +
           std::to_string(file_index);
#else
    struct stat info {};
    if (::lstat(path.c_str(), &info) != 0)
        throw std::runtime_error("Cannot inspect exact Project source identity");
    return "posix:" + std::to_string(static_cast<unsigned long long>(info.st_dev)) + ":" +
           std::to_string(static_cast<unsigned long long>(info.st_ino));
#endif
}

std::string content_hash(const fs::path& path, std::uint64_t expected_size)
{
    if (expected_size > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()))
        throw std::runtime_error("Project source is too large for metadata fallback hashing");
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read Project source for metadata fallback hashing");
    std::vector<std::byte> bytes(static_cast<std::size_t>(expected_size));
    if (!bytes.empty()) {
        input.read(reinterpret_cast<char*>(bytes.data()),
                   static_cast<std::streamsize>(bytes.size()));
        if (input.gcount() != static_cast<std::streamsize>(bytes.size()))
            throw std::runtime_error("Project source changed while fallback hashing");
    }
    char extra = '\0';
    if (input.read(&extra, 1))
        throw std::runtime_error("Project source changed while fallback hashing");
    return noveltea::core::sha256_hex(bytes);
}

std::optional<ProjectSourceManifestEntry> capture_regular_file(
    const fs::path& canonical_root, std::string_view relative,
    const std::function<std::optional<std::uint64_t>(const fs::path&)>& mtime_reader)
{
    const auto absolute = canonical_root / path_from_utf8(relative);
    std::error_code error;
    const auto link_status = fs::symlink_status(absolute, error);
    if (link_status.type() == fs::file_type::not_found ||
        error == std::errc::no_such_file_or_directory || error == std::errc::not_a_directory)
        return std::nullopt;
    if (error)
        throw std::runtime_error("Cannot inspect Project source: " + std::string(relative));
    if (fs::is_symlink(link_status))
        throw std::runtime_error("Project sources must not be symbolic links: " +
                                 std::string(relative));
    if (!fs::is_regular_file(link_status))
        throw std::runtime_error("Project source is not a regular file: " + std::string(relative));

    const auto real = fs::canonical(absolute, error);
    if (error || !path_within_root(real, canonical_root))
        throw std::runtime_error("Project source escapes the canonical Project root: " +
                                 std::string(relative));
    const auto size = fs::file_size(absolute, error);
    if (error)
        throw std::runtime_error("Cannot inspect Project source byte size: " +
                                 std::string(relative));
    if (size > kJavaScriptSafeIntegerMax)
        throw std::runtime_error("Project source byte size exceeds the exact JavaScript range");

    ProjectSourceManifestEntry result{
        .path = std::string(relative),
        .source_identity = native_source_identity(absolute),
        .byte_size = size,
        .mtime_nanoseconds = std::nullopt,
        .content_hash = std::nullopt,
    };
    result.mtime_nanoseconds = mtime_reader(absolute);
    if (!result.mtime_nanoseconds)
        result.content_hash = content_hash(absolute, size);
    return result;
}

void discover_scope(const fs::path& canonical_root, const ProjectSourceDiscoveryScope& scope,
                    std::set<std::string>& paths)
{
    const auto walk = [&](const auto& self, const std::string& relative_directory) -> void {
        if (scope_excludes(scope, relative_directory + "/"))
            return;
        const auto absolute_directory = canonical_root / path_from_utf8(relative_directory);
        std::error_code error;
        const auto directory_status = fs::symlink_status(absolute_directory, error);
        if (error || directory_status.type() == fs::file_type::not_found)
            return;
        if (fs::is_symlink(directory_status))
            throw std::runtime_error("Project discovery directory must not be a symbolic link: " +
                                     relative_directory);
        if (!fs::is_directory(directory_status))
            throw std::runtime_error("Project discovery root is not a directory: " +
                                     relative_directory);

        std::vector<std::string> names;
        fs::directory_iterator iterator(absolute_directory, error);
        if (error)
            throw std::runtime_error("Cannot read Project discovery directory: " +
                                     relative_directory);
        const fs::directory_iterator end;
        for (; iterator != end; iterator.increment(error)) {
            if (error)
                throw std::runtime_error("Cannot read Project discovery directory: " +
                                         relative_directory);
            names.push_back(path_utf8(iterator->path().filename()));
        }
        if (error)
            throw std::runtime_error("Cannot read Project discovery directory: " +
                                     relative_directory);
        std::sort(names.begin(), names.end());

        for (const auto& name : names) {
            const auto relative = relative_directory + "/" + name;
            if (scope_excludes(scope, relative))
                continue;
            const auto absolute = canonical_root / path_from_utf8(relative);
            const auto entry_status = fs::symlink_status(absolute, error);
            if (error)
                throw std::runtime_error("Cannot inspect Project discovery candidate: " + relative);
            const bool candidate = matches_extension(scope, relative);
            if (candidate && !fs::is_regular_file(entry_status)) {
                if (fs::is_symlink(entry_status))
                    throw std::runtime_error(
                        "Project discovery candidate must not be a symbolic link: " + relative);
                throw std::runtime_error("Project discovery candidate is not a regular file: " +
                                         relative);
            }
            if (fs::is_directory(entry_status)) {
                self(self, relative);
                continue;
            }
            if (fs::is_symlink(entry_status)) {
                const auto followed = fs::status(absolute, error);
                if (!error && fs::is_directory(followed))
                    throw std::runtime_error(
                        "Project discovery directory must not be a symbolic link: " + relative);
                error.clear();
                continue;
            }
            if (candidate)
                paths.insert(relative);
        }
    };
    walk(walk, scope.root);
}

ProjectSourceManifest
scan_manifest(const fs::path& canonical_root, const NormalizedConfig& config,
              const std::function<std::optional<std::uint64_t>(const fs::path&)>& mtime_reader)
{
    std::set<std::string> paths(config.authoritative_paths.begin(),
                                config.authoritative_paths.end());
    for (const auto& scope : config.discovery_scopes)
        discover_scope(canonical_root, scope, paths);

    ProjectSourceManifest manifest{
        .canonical_root = path_utf8(canonical_root),
        .entries = {},
    };
    manifest.entries.reserve(paths.size());
    for (const auto& relative : paths)
        if (auto entry = capture_regular_file(canonical_root, relative, mtime_reader))
            manifest.entries.push_back(std::move(*entry));
    return manifest;
}

ProjectSourceDelta calculate_delta(const std::optional<ProjectSourceManifest>& previous,
                                   const ProjectSourceManifest& current)
{
    ProjectSourceDelta result;
    if (!previous) {
        for (const auto& entry : current.entries)
            result.added.push_back(entry.path);
        return result;
    }

    std::map<std::string, ProjectSourceManifestEntry> before;
    for (const auto& entry : previous->entries)
        before.emplace(entry.path, entry);
    std::map<std::string, ProjectSourceManifestEntry> after;
    for (const auto& entry : current.entries)
        after.emplace(entry.path, entry);

    for (const auto& [path, entry] : after) {
        const auto found = before.find(path);
        if (found == before.end())
            result.added.push_back(path);
        else if (found->second != entry)
            result.changed.push_back(path);
    }
    for (const auto& [path, entry] : before) {
        (void)entry;
        if (!after.contains(path))
            result.removed.push_back(path);
    }
    return result;
}

class NativeProjectWatcher {
public:
    using PathCallback = std::function<void(std::string, bool)>;
    using UnknownCallback = std::function<void()>;

    virtual ~NativeProjectWatcher() = default;
};

#if defined(__linux__)
class InotifyProjectWatcher final : public NativeProjectWatcher {
public:
    InotifyProjectWatcher(fs::path root, PathCallback path_callback,
                          UnknownCallback unknown_callback)
        : root_(std::move(root)), path_callback_(std::move(path_callback)),
          unknown_callback_(std::move(unknown_callback))
    {
        descriptor_ = ::inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
        if (descriptor_ < 0)
            throw std::runtime_error("Cannot initialize native Project watcher");
        stop_descriptor_ = ::eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
        if (stop_descriptor_ < 0) {
            ::close(descriptor_);
            descriptor_ = -1;
            throw std::runtime_error("Cannot initialize native Project watcher stop signal");
        }
        try {
            add_directory_tree(root_, "");
            thread_ = std::thread([this] { run(); });
        } catch (...) {
            ::close(stop_descriptor_);
            ::close(descriptor_);
            stop_descriptor_ = -1;
            descriptor_ = -1;
            throw;
        }
    }

    ~InotifyProjectWatcher() override
    {
        stopping_.store(true);
        if (stop_descriptor_ >= 0) {
            const std::uint64_t value = 1;
            (void)::write(stop_descriptor_, &value, sizeof(value));
        }
        if (thread_.joinable())
            thread_.join();
        if (stop_descriptor_ >= 0)
            ::close(stop_descriptor_);
        if (descriptor_ >= 0)
            ::close(descriptor_);
    }

private:
    static constexpr std::uint32_t kWatchMask = IN_CREATE | IN_DELETE | IN_MODIFY | IN_ATTRIB |
                                                IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO |
                                                IN_DELETE_SELF | IN_MOVE_SELF | IN_ONLYDIR;

    void add_directory(const fs::path& absolute, const std::string& relative)
    {
        const auto watch = ::inotify_add_watch(descriptor_, absolute.c_str(), kWatchMask);
        if (watch < 0)
            throw std::runtime_error("Cannot watch Project directory");
        directories_[watch] = relative;
    }

    void add_directory_tree(const fs::path& absolute, const std::string& relative)
    {
        add_directory(absolute, relative);
        std::error_code error;
        fs::directory_iterator iterator(absolute, error);
        if (error)
            throw std::runtime_error("Cannot enumerate Project directories for native watching");
        const fs::directory_iterator end;
        for (; iterator != end; iterator.increment(error)) {
            if (error)
                throw std::runtime_error(
                    "Cannot enumerate Project directories for native watching");
            const auto status = iterator->symlink_status(error);
            if (error)
                throw std::runtime_error("Cannot inspect Project directory for native watching");
            if (fs::is_symlink(status) || !fs::is_directory(status))
                continue;
            const auto name = path_utf8(iterator->path().filename());
            const auto child_relative = relative.empty() ? name : relative + "/" + name;
            add_directory_tree(iterator->path(), child_relative);
        }
        if (error)
            throw std::runtime_error("Cannot enumerate Project directories for native watching");
    }

    void remove_directory_tree(std::string_view relative)
    {
        std::vector<int> watches;
        for (const auto& [watch, watched_relative] : directories_)
            if (starts_with_path(watched_relative, relative))
                watches.push_back(watch);
        for (const auto watch : watches) {
            directories_.erase(watch);
            (void)::inotify_rm_watch(descriptor_, watch);
        }
    }

    void handle_event(const inotify_event& event)
    {
        if ((event.mask & IN_Q_OVERFLOW) != 0) {
            unknown_callback_();
            return;
        }
        const auto found = directories_.find(event.wd);
        if (found == directories_.end())
            return;
        const auto directory = found->second;
        if ((event.mask & IN_IGNORED) != 0) {
            if (!stopping_.load())
                unknown_callback_();
            directories_.erase(found);
            return;
        }
        if ((event.mask & (IN_DELETE_SELF | IN_MOVE_SELF)) != 0) {
            unknown_callback_();
            return;
        }
        if (event.len == 0)
            return;
        const std::string name(event.name, strnlen(event.name, event.len));
        const auto relative = directory.empty() ? name : directory + "/" + name;
        const bool is_directory = (event.mask & IN_ISDIR) != 0;
        path_callback_(relative, is_directory);

        if (is_directory && (event.mask & (IN_DELETE | IN_MOVED_FROM)) != 0)
            remove_directory_tree(relative);
        if (is_directory && (event.mask & (IN_CREATE | IN_MOVED_TO)) != 0) {
            try {
                add_directory_tree(root_ / path_from_utf8(relative), relative);
            } catch (...) {
                unknown_callback_();
            }
        }
    }

    void run()
    {
        std::array<std::byte, 64 * 1024> buffer{};
        while (!stopping_.load()) {
            std::array<pollfd, 2> descriptors = {pollfd{descriptor_, POLLIN, 0},
                                                 pollfd{stop_descriptor_, POLLIN, 0}};
            const auto ready = ::poll(descriptors.data(), descriptors.size(), -1);
            if (ready < 0) {
                if (errno == EINTR)
                    continue;
                unknown_callback_();
                return;
            }
            if ((descriptors[1].revents & POLLIN) != 0)
                return;
            if ((descriptors[0].revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
                unknown_callback_();
                return;
            }
            if ((descriptors[0].revents & POLLIN) == 0)
                continue;
            for (;;) {
                const auto count = ::read(descriptor_, buffer.data(), buffer.size());
                if (count < 0) {
                    if (errno == EAGAIN || errno == EWOULDBLOCK)
                        break;
                    if (errno == EINTR)
                        continue;
                    unknown_callback_();
                    return;
                }
                if (count == 0)
                    break;
                std::size_t offset = 0;
                while (offset + sizeof(inotify_event) <= static_cast<std::size_t>(count)) {
                    const auto* event =
                        reinterpret_cast<const inotify_event*>(buffer.data() + offset);
                    handle_event(*event);
                    offset += sizeof(inotify_event) + event->len;
                }
            }
        }
    }

    fs::path root_;
    PathCallback path_callback_;
    UnknownCallback unknown_callback_;
    int descriptor_ = -1;
    int stop_descriptor_ = -1;
    std::unordered_map<int, std::string> directories_;
    std::atomic<bool> stopping_{false};
    std::thread thread_;
};
#elif defined(_WIN32)
std::string wide_to_utf8(std::wstring_view value)
{
    if (value.empty())
        return {};
    const int required =
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0)
        throw std::runtime_error("Native Project watcher received an invalid path");
    std::string output(static_cast<std::size_t>(required), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), output.data(), required, nullptr,
                            nullptr) != required)
        throw std::runtime_error("Native Project watcher could not convert a path");
    return output;
}

class WindowsProjectWatcher final : public NativeProjectWatcher {
public:
    WindowsProjectWatcher(fs::path root, PathCallback path_callback,
                          UnknownCallback unknown_callback)
        : root_(std::move(root)), path_callback_(std::move(path_callback)),
          unknown_callback_(std::move(unknown_callback))
    {
        directory_ = CreateFileW(root_.c_str(), FILE_LIST_DIRECTORY,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                                 OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
        if (directory_ == INVALID_HANDLE_VALUE)
            throw std::runtime_error("Cannot initialize native Project watcher");
        enumerate_directories();
        thread_ = std::thread([this] { run(); });
    }

    ~WindowsProjectWatcher() override
    {
        stopping_.store(true);
        if (thread_.joinable()) {
            (void)CancelSynchronousIo(thread_.native_handle());
            thread_.join();
        }
        if (directory_ != INVALID_HANDLE_VALUE)
            CloseHandle(directory_);
    }

private:
    void enumerate_directories()
    {
        known_directories_.insert("");
        std::error_code error;
        fs::recursive_directory_iterator iterator(root_, error);
        const fs::recursive_directory_iterator end;
        for (; !error && iterator != end; iterator.increment(error)) {
            const auto status = iterator->symlink_status(error);
            if (error)
                break;
            if (fs::is_symlink(status)) {
                iterator.disable_recursion_pending();
                continue;
            }
            if (!fs::is_directory(status))
                continue;
            const auto relative = fs::relative(iterator->path(), root_, error);
            if (error)
                break;
            known_directories_.insert(path_utf8(relative));
        }
        if (error)
            throw std::runtime_error("Cannot enumerate Project directories for native watching");
    }

    bool current_directory(std::string_view relative) const
    {
        const auto absolute = root_ / path_from_utf8(relative);
        const auto attributes = GetFileAttributesW(absolute.c_str());
        return attributes != INVALID_FILE_ATTRIBUTES &&
               (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    }

    void erase_directory_tree(std::string_view relative)
    {
        for (auto it = known_directories_.begin(); it != known_directories_.end();) {
            if (starts_with_path(*it, relative))
                it = known_directories_.erase(it);
            else
                ++it;
        }
    }

    void handle_event(const FILE_NOTIFY_INFORMATION& event)
    {
        const auto characters = event.FileNameLength / sizeof(wchar_t);
        auto relative = slash_path(wide_to_utf8(std::wstring_view(event.FileName, characters)));
        if (relative.empty())
            return;
        bool directory = known_directories_.contains(relative);
        if (event.Action == FILE_ACTION_ADDED || event.Action == FILE_ACTION_RENAMED_NEW_NAME) {
            directory = current_directory(relative);
            if (directory)
                known_directories_.insert(relative);
        }
        path_callback_(relative, directory);
        if (directory &&
            (event.Action == FILE_ACTION_REMOVED || event.Action == FILE_ACTION_RENAMED_OLD_NAME))
            erase_directory_tree(relative);
    }

    void run()
    {
        std::array<std::byte, 64 * 1024> buffer{};
        constexpr DWORD filters = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
                                  FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE |
                                  FILE_NOTIFY_CHANGE_CREATION;
        while (!stopping_.load()) {
            DWORD bytes = 0;
            const BOOL read =
                ReadDirectoryChangesW(directory_, buffer.data(), static_cast<DWORD>(buffer.size()),
                                      TRUE, filters, &bytes, nullptr, nullptr);
            if (!read) {
                const auto error = GetLastError();
                if (stopping_.load() && error == ERROR_OPERATION_ABORTED)
                    return;
                unknown_callback_();
                if (error == ERROR_NOTIFY_ENUM_DIR)
                    continue;
                return;
            }
            if (bytes == 0) {
                unknown_callback_();
                continue;
            }
            std::size_t offset = 0;
            while (offset + sizeof(FILE_NOTIFY_INFORMATION) <= bytes) {
                const auto* event =
                    reinterpret_cast<const FILE_NOTIFY_INFORMATION*>(buffer.data() + offset);
                try {
                    handle_event(*event);
                } catch (...) {
                    unknown_callback_();
                }
                if (event->NextEntryOffset == 0)
                    break;
                offset += event->NextEntryOffset;
            }
        }
    }

    fs::path root_;
    PathCallback path_callback_;
    UnknownCallback unknown_callback_;
    HANDLE directory_ = INVALID_HANDLE_VALUE;
    std::set<std::string> known_directories_;
    std::atomic<bool> stopping_{false};
    std::thread thread_;
};
#endif

std::unique_ptr<NativeProjectWatcher>
make_native_watcher(const fs::path& root, NativeProjectWatcher::PathCallback path_callback,
                    NativeProjectWatcher::UnknownCallback unknown_callback)
{
#if defined(__linux__)
    return std::make_unique<InotifyProjectWatcher>(root, std::move(path_callback),
                                                   std::move(unknown_callback));
#elif defined(_WIN32)
    return std::make_unique<WindowsProjectWatcher>(root, std::move(path_callback),
                                                   std::move(unknown_callback));
#else
    (void)root;
    (void)path_callback;
    (void)unknown_callback;
    return nullptr;
#endif
}

} // namespace

const char* project_authority_state_name(ProjectAuthorityState state) noexcept
{
    switch (state) {
    case ProjectAuthorityState::untracked:
        return "untracked";
    case ProjectAuthorityState::proven:
        return "proven";
    case ProjectAuthorityState::dirty:
        return "dirty";
    case ProjectAuthorityState::unknown:
        return "unknown";
    }
    return "unknown";
}

struct ProjectAuthorityManager::Impl {
    struct Entry {
        explicit Entry(fs::path canonical) : canonical_root(std::move(canonical)) {}

        fs::path canonical_root;
        mutable std::mutex mutex;
        NormalizedConfig config;
        bool configured = false;
        ProjectAuthorityState state = ProjectAuthorityState::untracked;
        std::optional<ProjectSourceManifest> manifest;
        std::set<std::string> pending_paths;
        std::uint64_t watcher_epoch = 0;
        std::uint64_t manifest_revision = 0;
        bool watcher_attempted = false;
        std::unique_ptr<NativeProjectWatcher> watcher;
    };

    explicit Impl(ProjectAuthorityOptions requested_options) : options(std::move(requested_options))
    {
        if (!options.mtime_reader)
            options.mtime_reader = native_mtime_nanoseconds;
    }

    static void mark_path(const std::shared_ptr<Entry>& entry, std::string relative_path,
                          bool directory)
    {
        try {
            relative_path = normalize_relative_path(std::move(relative_path));
        } catch (...) {
            mark_unknown(entry);
            return;
        }
        std::scoped_lock lock(entry->mutex);
        if (!entry->configured || !event_relevant(entry->config, relative_path, directory))
            return;
        entry->pending_paths.insert(std::move(relative_path));
        if (entry->state != ProjectAuthorityState::unknown)
            entry->state = ProjectAuthorityState::dirty;
        ++entry->watcher_epoch;
    }

    static void mark_unknown(const std::shared_ptr<Entry>& entry)
    {
        std::scoped_lock lock(entry->mutex);
        entry->state = ProjectAuthorityState::unknown;
        ++entry->watcher_epoch;
    }

    std::shared_ptr<Entry> entry_for_observation(const fs::path& canonical_root,
                                                 const NormalizedConfig& config)
    {
        const auto key = path_utf8(canonical_root);
        std::shared_ptr<Entry> entry;
        {
            std::scoped_lock lock(entries_mutex);
            auto [found, inserted] =
                entries.try_emplace(key, std::make_shared<Entry>(canonical_root));
            (void)inserted;
            entry = found->second;
        }

        bool start_watcher = false;
        {
            std::scoped_lock lock(entry->mutex);
            if (!entry->configured) {
                entry->config = config;
                entry->configured = true;
            } else if (entry->config != config) {
                entry->config = config;
                entry->state = ProjectAuthorityState::unknown;
                ++entry->watcher_epoch;
            }
            if (options.enable_native_watcher && !entry->watcher_attempted) {
                entry->watcher_attempted = true;
                start_watcher = true;
            }
        }
        if (start_watcher) {
            const std::weak_ptr<Entry> weak = entry;
            try {
                auto watcher = make_native_watcher(
                    canonical_root,
                    [weak](std::string relative, bool directory) {
                        if (const auto locked = weak.lock())
                            mark_path(locked, std::move(relative), directory);
                    },
                    [weak] {
                        if (const auto locked = weak.lock())
                            mark_unknown(locked);
                    });
                std::scoped_lock lock(entry->mutex);
                entry->watcher = std::move(watcher);
            } catch (...) {
                mark_unknown(entry);
            }
        }
        return entry;
    }

    std::shared_ptr<Entry> find_entry(const fs::path& project_root) const
    {
        fs::path canonical;
        try {
            canonical = canonical_project_root(project_root);
        } catch (...) {
            return {};
        }
        std::scoped_lock lock(entries_mutex);
        const auto found = entries.find(path_utf8(canonical));
        return found == entries.end() ? std::shared_ptr<Entry>{} : found->second;
    }

    ProjectAuthorityOptions options;
    mutable std::mutex entries_mutex;
    std::unordered_map<std::string, std::shared_ptr<Entry>> entries;
};

ProjectAuthorityManager::ProjectAuthorityManager(ProjectAuthorityOptions options)
    : impl_(std::make_unique<Impl>(std::move(options)))
{
}

ProjectAuthorityManager::~ProjectAuthorityManager() = default;

ProjectObservation ProjectAuthorityManager::observe(const ProjectAuthorityRequest& request)
{
    const auto canonical_root = canonical_project_root(request.project_root);
    const auto config = normalize_config(request);
    const auto entry = impl_->entry_for_observation(canonical_root, config);

    for (std::size_t attempt = 0; attempt < kObservationAttempts; ++attempt) {
        ProjectAuthorityState previous_state = ProjectAuthorityState::untracked;
        std::uint64_t watcher_epoch = 0;
        std::uint64_t manifest_revision = 0;
        std::vector<std::string> pending_paths;
        std::optional<ProjectSourceManifest> previous_manifest;
        NormalizedConfig current_config;
        {
            std::scoped_lock lock(entry->mutex);
            previous_state = entry->state;
            watcher_epoch = entry->watcher_epoch;
            manifest_revision = entry->manifest_revision;
            pending_paths.assign(entry->pending_paths.begin(), entry->pending_paths.end());
            previous_manifest = entry->manifest;
            current_config = entry->config;
        }

        auto manifest = scan_manifest(canonical_root, current_config, impl_->options.mtime_reader);
        auto delta = calculate_delta(previous_manifest, manifest);
        {
            std::scoped_lock lock(entry->mutex);
            if (entry->watcher_epoch != watcher_epoch ||
                entry->manifest_revision != manifest_revision || entry->config != current_config)
                continue;
            const bool full_rescan =
                !entry->manifest || previous_state == ProjectAuthorityState::unknown;
            entry->manifest = manifest;
            entry->pending_paths.clear();
            entry->state = ProjectAuthorityState::proven;
            ++entry->manifest_revision;
            return ProjectObservation{
                .previous_state = previous_state,
                .unchanged = delta.empty() && previous_manifest.has_value(),
                .full_rescan = full_rescan,
                .watcher_paths = std::move(pending_paths),
                .delta = std::move(delta),
                .manifest = std::move(manifest),
            };
        }
    }

    throw std::runtime_error(
        "Project sources changed continuously during native authority observation");
}

std::optional<ProjectAuthorityStatus>
ProjectAuthorityManager::status(const std::filesystem::path& project_root) const
{
    const auto entry = impl_->find_entry(project_root);
    if (!entry)
        return std::nullopt;
    std::scoped_lock lock(entry->mutex);
    return ProjectAuthorityStatus{
        .state = entry->state,
        .has_manifest = entry->manifest.has_value(),
        .pending_paths = {entry->pending_paths.begin(), entry->pending_paths.end()},
    };
}

void ProjectAuthorityManager::notify_path_changed(const std::filesystem::path& project_root,
                                                  std::string relative_path, bool directory)
{
    if (const auto entry = impl_->find_entry(project_root))
        Impl::mark_path(entry, std::move(relative_path), directory);
}

void ProjectAuthorityManager::notify_watcher_unknown(const std::filesystem::path& project_root)
{
    if (const auto entry = impl_->find_entry(project_root))
        Impl::mark_unknown(entry);
}

bool ProjectAuthorityManager::release(const std::filesystem::path& project_root)
{
    fs::path canonical;
    try {
        canonical = canonical_project_root(project_root);
    } catch (...) {
        return false;
    }
    std::shared_ptr<Impl::Entry> removed;
    {
        std::scoped_lock lock(impl_->entries_mutex);
        const auto found = impl_->entries.find(path_utf8(canonical));
        if (found == impl_->entries.end())
            return false;
        removed = std::move(found->second);
        impl_->entries.erase(found);
    }
    removed.reset();
    return true;
}

std::size_t ProjectAuthorityManager::tracked_project_count() const
{
    std::scoped_lock lock(impl_->entries_mutex);
    return impl_->entries.size();
}

} // namespace noveltea::tooling::daemon
