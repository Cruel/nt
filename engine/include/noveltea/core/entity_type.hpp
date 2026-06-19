#pragma once

#include <cstdint>
#include <optional>
#include <string_view>

namespace noveltea::core {

enum class EntityType : std::int32_t {
    Invalid = -1,
    CustomScript = 0,
    Cutscene = 1,
    Action = 2,
    Room = 3,
    Object = 4,
    Dialogue = 5,
    Script = 6,
    Verb = 7,
    Map = 8,
};

[[nodiscard]] constexpr std::int32_t to_integer(EntityType type) noexcept
{
    return static_cast<std::int32_t>(type);
}

[[nodiscard]] constexpr bool is_known_entity_type(EntityType type) noexcept
{
    return type == EntityType::CustomScript || type == EntityType::Cutscene ||
           type == EntityType::Action || type == EntityType::Room || type == EntityType::Object ||
           type == EntityType::Dialogue || type == EntityType::Script || type == EntityType::Verb ||
           type == EntityType::Map;
}

[[nodiscard]] constexpr bool is_project_entity_type(EntityType type) noexcept
{
    return type == EntityType::Cutscene || type == EntityType::Action || type == EntityType::Room ||
           type == EntityType::Object || type == EntityType::Dialogue ||
           type == EntityType::Script || type == EntityType::Verb || type == EntityType::Map;
}

[[nodiscard]] std::optional<EntityType> entity_type_from_integer(std::int32_t value) noexcept;
[[nodiscard]] std::optional<std::string_view> entity_type_collection_key(EntityType type) noexcept;

} // namespace noveltea::core
