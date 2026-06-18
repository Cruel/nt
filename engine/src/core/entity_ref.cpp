#include <noveltea/core/entity_ref.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {

nlohmann::json EntityRef::to_json() const
{
    return nlohmann::json::array({to_integer(type), id});
}

std::optional<EntityRef> EntityRef::from_json(const nlohmann::json& value)
{
    if (!value.is_array() || value.size() != 2) {
        return std::nullopt;
    }

    const auto& type_json = value[project_ids::select_entity_type];
    const auto& id_json = value[project_ids::select_entity_id];
    if (!type_json.is_number_integer() || !id_json.is_string()) {
        return std::nullopt;
    }

    const auto type_value = type_json.get<std::int32_t>();
    const auto type = entity_type_from_integer(static_cast<std::int32_t>(type_value));
    if (!type.has_value()) {
        return std::nullopt;
    }

    return EntityRef {*type, id_json.get<std::string>()};
}

} // namespace noveltea::core
