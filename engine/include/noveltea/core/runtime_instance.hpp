#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <optional>
#include <variant>

namespace noveltea::core {

struct CompiledRoomConfigurationSource {
    RoomId room;
    auto operator<=>(const CompiledRoomConfigurationSource&) const = default;
};
struct CompiledCharacterConfigurationSource {
    CharacterId character;
    auto operator<=>(const CompiledCharacterConfigurationSource&) const = default;
};
struct CompiledInteractableConfigurationSource {
    InteractableId interactable;
    auto operator<=>(const CompiledInteractableConfigurationSource&) const = default;
};
struct ArchetypeConfigurationSource {
    ArchetypeId archetype;
    auto operator<=>(const ArchetypeConfigurationSource&) const = default;
};
using RuntimeConfigurationSource =
    std::variant<CompiledRoomConfigurationSource, CompiledCharacterConfigurationSource,
                 CompiledInteractableConfigurationSource, ArchetypeConfigurationSource>;

using GameplayInstanceRef = std::variant<RoomId, CharacterId, InteractableId>;

enum class RuntimeInstanceProvenanceKind : std::uint8_t {
    Declared,
    Archetype,
    CompiledDefinition,
    Clone,
};

struct RuntimeInstanceProvenance {
    RuntimeInstanceProvenanceKind kind = RuntimeInstanceProvenanceKind::Declared;
    std::optional<ArchetypeId> archetype;
    std::optional<GameplayInstanceRef> source_instance;
    bool operator==(const RuntimeInstanceProvenance&) const = default;
};

template<class Id, class Definition> struct RuntimeInstanceConfiguration {
    Id id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
    Definition birth_configuration;
    std::optional<Definition> structural_override;

    [[nodiscard]] const Definition& effective_configuration() const noexcept
    {
        return structural_override ? *structural_override : birth_configuration;
    }
};

struct RuntimeRoomExitTargetOverride {
    RoomExitId exit;
    RoomId target;
    bool operator==(const RuntimeRoomExitTargetOverride&) const = default;
};

struct RuntimeRoomConfiguration {
    RoomId id;
    bool declared = false;
    RuntimeConfigurationSource birth_source;
    std::optional<RuntimeConfigurationSource> structural_override_source;
    RuntimeInstanceProvenance provenance;
    compiled::RoomDefinition birth_configuration;
    std::optional<compiled::RoomDefinition> structural_override;
    std::vector<RuntimeRoomExitTargetOverride> birth_exit_target_overrides;
    std::vector<RuntimeRoomExitTargetOverride> structural_override_exit_target_overrides;
    std::vector<RuntimeRoomExitTargetOverride> exit_target_overrides;

    [[nodiscard]] const compiled::RoomDefinition& effective_configuration() const noexcept
    {
        return structural_override ? *structural_override : birth_configuration;
    }
};
using RuntimeCharacterConfiguration =
    RuntimeInstanceConfiguration<CharacterId, compiled::CharacterDefinition>;
using RuntimeInteractableConfiguration =
    RuntimeInstanceConfiguration<InteractableId, compiled::InteractableDefinition>;

} // namespace noveltea::core
