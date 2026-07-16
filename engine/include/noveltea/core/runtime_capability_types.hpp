#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace noveltea::core {

enum class ProjectDefinitionKind : std::uint8_t {
    Room,
    Scene,
    Dialogue,
    Character,
    Interactable,
    Verb,
    Interaction,
    Map
};

struct ProjectDefinitionSummary {
    ProjectDefinitionKind kind;
    std::string id;
    std::optional<std::string> display_name;
    bool operator==(const ProjectDefinitionSummary&) const = default;
};

} // namespace noveltea::core
