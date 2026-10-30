#pragma once

#include <filesystem>
#include <string>
#include <string_view>

namespace noveltea::cli {

// std::filesystem::u8path is deprecated in recent libstdc++ releases. Construct
// from char8_t explicitly so Windows still decodes CLI paths as UTF-8.
inline std::filesystem::path native_path_from_utf8(std::string_view text)
{
    return std::filesystem::path(std::u8string(text.begin(), text.end()));
}

} // namespace noveltea::cli
