#pragma once

#include <filesystem>
#include <string>
#include <string_view>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

namespace noveltea::cli {

// std::filesystem::u8path is deprecated in recent libstdc++ releases. Construct
// from char8_t explicitly so Windows still decodes CLI paths as UTF-8.
inline std::filesystem::path native_path_from_utf8(std::string_view text)
{
    return std::filesystem::path(std::u8string(text.begin(), text.end()));
}

// MinGW's std::filesystem::symlink_status does not reliably classify every
// Windows directory/file reparse point as a symlink. Publication paths must
// reject the underlying reparse attribute, including junctions, directly.
inline bool native_path_is_link(const std::filesystem::path& path)
{
#if defined(_WIN32)
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
        return true;
#endif
    std::error_code error;
    return std::filesystem::is_symlink(std::filesystem::symlink_status(path, error));
}

} // namespace noveltea::cli
