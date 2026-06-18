#pragma once

#include <optional>
#include <string>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/entity_type.hpp>

namespace noveltea::core {

struct EntityRef {
    EntityType type = EntityType::Invalid;
    std::string id;

    [[nodiscard]] bool has_id() const noexcept { return !id.empty(); }
    [[nodiscard]] nlohmann::json to_json() const;
    [[nodiscard]] static std::optional<EntityRef> from_json(const nlohmann::json& value);
};

} // namespace noveltea::core
