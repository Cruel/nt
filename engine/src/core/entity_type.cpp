#include <noveltea/core/entity_type.hpp>

#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {

std::optional<EntityType> entity_type_from_integer(std::int32_t value) noexcept
{
    auto type = static_cast<EntityType>(value);
    if (!is_known_entity_type(type)) {
        return std::nullopt;
    }
    return type;
}

std::string_view entity_type_collection_key(EntityType type) noexcept
{
    switch (type) {
    case EntityType::Action:
        return project_ids::action;
    case EntityType::Cutscene:
        return project_ids::cutscene;
    case EntityType::Dialogue:
        return project_ids::dialogue;
    case EntityType::Map:
        return project_ids::map;
    case EntityType::Object:
        return project_ids::object;
    case EntityType::Room:
        return project_ids::room;
    case EntityType::Script:
    case EntityType::CustomScript:
        return project_ids::script;
    case EntityType::Verb:
        return project_ids::verb;
    case EntityType::Invalid:
        return {};
    }
    return {};
}

} // namespace noveltea::core
