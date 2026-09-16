#include "tooling_native_c.h"

#include <nlohmann/json.hpp>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <string_view>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <sys/stat.h>
#endif

namespace {

constexpr std::uint64_t kJavaScriptSafeIntegerMax = 9007199254740991ULL;

std::uint64_t write_json_response(const nlohmann::json& result, std::uint8_t* response,
                                  std::uint64_t response_capacity)
{
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required)
        std::memcpy(response, text.data(), static_cast<std::size_t>(required));
    return required;
}

#if defined(_WIN32)
std::wstring utf8_to_wide(std::string_view value)
{
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), wide.data(), required);
    if (written != required)
        return {};
    return wide;
}

nlohmann::json inspect_path_metadata(std::string_view path)
{
    if (path.find('\0') != std::string_view::npos)
        return {{"ok", false}, {"error", "Path metadata request contains an embedded NUL."}};
    const auto wide = utf8_to_wide(path);
    if (wide.empty() && !path.empty())
        return {{"ok", false}, {"error", "Path metadata request contains invalid UTF-8."}};

    WIN32_FILE_ATTRIBUTE_DATA info{};
    if (GetFileAttributesExW(wide.c_str(), GetFileExInfoStandard, &info) == 0) {
        const auto error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
            return {{"ok", true}, {"kind", "missing"}};
        return {{"ok", false}, {"error", "Cannot inspect exact path metadata."}};
    }

    const std::uint64_t byte_size = (static_cast<std::uint64_t>(info.nFileSizeHigh) << 32U) |
                                    static_cast<std::uint64_t>(info.nFileSizeLow);
    if (byte_size > kJavaScriptSafeIntegerMax)
        return {{"ok", false}, {"error", "Path byte size exceeds the exact JavaScript range."}};

    ULARGE_INTEGER file_time{};
    file_time.LowPart = info.ftLastWriteTime.dwLowDateTime;
    file_time.HighPart = info.ftLastWriteTime.dwHighDateTime;
    constexpr std::uint64_t kUnixEpochFileTimeTicks = 116444736000000000ULL;
    if (file_time.QuadPart < kUnixEpochFileTimeTicks)
        return {{"ok", false}, {"error", "Path modification time predates the Unix epoch."}};
    const auto unix_ticks = file_time.QuadPart - kUnixEpochFileTimeTicks;
    if (unix_ticks > std::numeric_limits<std::uint64_t>::max() / 100ULL)
        return {{"ok", false}, {"error", "Path modification time is out of range."}};
    const auto mtime_nanoseconds = unix_ticks * 100ULL;

    const bool reparse_point = (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    const bool directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const char* kind = reparse_point ? "symlink" : directory ? "directory" : "file";
    return {{"ok", true},
            {"kind", kind},
            {"byteSize", byte_size},
            {"mtimeNanoseconds", std::to_string(mtime_nanoseconds)}};
}
#else
nlohmann::json inspect_path_metadata(std::string_view path)
{
    if (path.find('\0') != std::string_view::npos)
        return {{"ok", false}, {"error", "Path metadata request contains an embedded NUL."}};
    struct stat info {};
    const std::string owned_path(path);
    if (::lstat(owned_path.c_str(), &info) != 0) {
        if (errno == ENOENT || errno == ENOTDIR)
            return {{"ok", true}, {"kind", "missing"}};
        return {{"ok", false}, {"error", "Cannot inspect exact path metadata."}};
    }

    if (info.st_size < 0 || static_cast<std::uint64_t>(info.st_size) > kJavaScriptSafeIntegerMax)
        return {{"ok", false}, {"error", "Path byte size exceeds the exact JavaScript range."}};

#if defined(__APPLE__)
    const auto seconds = info.st_mtimespec.tv_sec;
    const auto nanoseconds = info.st_mtimespec.tv_nsec;
#else
    const auto seconds = info.st_mtim.tv_sec;
    const auto nanoseconds = info.st_mtim.tv_nsec;
#endif
    if (seconds < 0 || nanoseconds < 0 || nanoseconds >= 1'000'000'000L)
        return {{"ok", false}, {"error", "Path modification time is out of range."}};
    const auto seconds_u64 = static_cast<std::uint64_t>(seconds);
    constexpr std::uint64_t kNanosecondsPerSecond = 1'000'000'000ULL;
    if (seconds_u64 >
        (std::numeric_limits<std::uint64_t>::max() - static_cast<std::uint64_t>(nanoseconds)) /
            kNanosecondsPerSecond)
        return {{"ok", false}, {"error", "Path modification time is out of range."}};
    const auto mtime_nanoseconds =
        seconds_u64 * kNanosecondsPerSecond + static_cast<std::uint64_t>(nanoseconds);

    const char* kind = S_ISREG(info.st_mode)   ? "file"
                       : S_ISDIR(info.st_mode) ? "directory"
                       : S_ISLNK(info.st_mode) ? "symlink"
                                               : "other";
    return {{"ok", true},
            {"kind", kind},
            {"byteSize", static_cast<std::uint64_t>(info.st_size)},
            {"mtimeNanoseconds", std::to_string(mtime_nanoseconds)}};
}
#endif

} // namespace

extern "C" std::uint64_t noveltea_tooling_path_metadata_json(const std::uint8_t* request,
                                                             std::uint64_t request_size,
                                                             std::uint8_t* response,
                                                             std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = nlohmann::json::parse(input, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object() || !parsed.contains("path") ||
        !parsed["path"].is_string())
        return write_json_response(
            {{"ok", false}, {"error", "Path metadata request requires path."}}, response,
            response_capacity);

    return write_json_response(inspect_path_metadata(parsed["path"].get<std::string>()), response,
                               response_capacity);
}
