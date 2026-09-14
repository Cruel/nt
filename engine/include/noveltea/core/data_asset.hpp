#pragma once

#include <string_view>

namespace noveltea::core {

[[nodiscard]] inline bool is_json_data_asset_path(std::string_view path) noexcept
{
    if (path.size() < 5 || path[path.size() - 5] != '.')
        return false;
    constexpr std::string_view extension = "json";
    for (std::size_t index = 0; index < extension.size(); ++index) {
        char value = path[path.size() - 4 + index];
        if (value >= 'A' && value <= 'Z')
            value = static_cast<char>(value - 'A' + 'a');
        if (value != extension[index])
            return false;
    }
    return true;
}

} // namespace noveltea::core
