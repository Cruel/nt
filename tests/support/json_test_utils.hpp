#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace noveltea::test_support {

inline nlohmann::json* json_object_by_id(nlohmann::json& values, std::string_view id)
{
    if (!values.is_array())
        return nullptr;
    for (auto& value : values) {
        const auto id_member = value.find("id");
        if (id_member != value.end() && id_member->is_string() &&
            id_member->get_ref<const std::string&>() == id)
            return &value;
    }
    return nullptr;
}

} // namespace noveltea::test_support
