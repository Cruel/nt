#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/runtime/runtime_identity.hpp"

#include <compare>
#include <cstdint>
#include <optional>

namespace noveltea::script {
class RuntimeScriptApi;
}

namespace noveltea::core {
struct RoomPresentationDraft;
}

namespace noveltea::runtime {

class RuntimeCommandGateway;

class RoomCompositionDraftAccess {
public:
    RoomCompositionDraftAccess() = default;
    explicit RoomCompositionDraftAccess(core::RoomPresentationDraft& draft) noexcept
        : m_draft(&draft)
    {
    }
    RoomCompositionDraftAccess(const RoomCompositionDraftAccess&) = delete;
    RoomCompositionDraftAccess& operator=(const RoomCompositionDraftAccess&) = delete;

    [[nodiscard]] bool active() const noexcept { return m_active; }
    void close() noexcept
    {
        m_active = false;
        m_draft = nullptr;
    }
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_character_visible(const core::CharacterId& character, bool visible);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_interactable_visible(const core::InteractableId& interactable, bool visible);

private:
    core::RoomPresentationDraft* m_draft = nullptr;
    bool m_active = true;
};

enum class RuntimeCapabilityProfile : std::uint8_t {
    GameplayScript,
    SynchronousExpression,
    RoomComposition,
    GameplayLayoutEvent,
    ShellLayoutEvent,
    Tooling
};

enum class RuntimeCapabilityGroup : std::uint8_t {
    Definitions,
    Variables,
    Properties,
    Flow,
    Room,
    Character,
    Interactable,
    Presentation,
    Audio,
    Map,
    Save,
    Game,
    Random,
    TextLog,
    Tooling,
    Count
};

struct CapabilityGenerationTag;
using CapabilityGeneration = RuntimeMonotonicId<CapabilityGenerationTag>;

class RuntimeCapabilityIssuer;

class RuntimeQueryCapabilities {
public:
    [[nodiscard]] bool has(RuntimeCapabilityGroup group) const noexcept
    {
        return (m_groups & (std::uint64_t{1} << static_cast<std::uint8_t>(group))) != 0;
    }
    [[nodiscard]] CapabilityGeneration generation() const noexcept { return m_generation; }

private:
    friend class RuntimeCapabilitySet;
    friend class RuntimeCapabilityIssuer;
    RuntimeQueryCapabilities(const RuntimeCommandGateway& gateway, std::uint64_t groups,
                             CapabilityGeneration generation) noexcept
        : m_gateway(&gateway), m_groups(groups), m_generation(generation)
    {
    }

    const RuntimeCommandGateway* m_gateway = nullptr;
    std::uint64_t m_groups = 0;
    CapabilityGeneration m_generation;
};

class RuntimeCommandCapabilities {
public:
    [[nodiscard]] bool has(RuntimeCapabilityGroup group) const noexcept
    {
        return (m_groups & (std::uint64_t{1} << static_cast<std::uint8_t>(group))) != 0;
    }
    [[nodiscard]] CapabilityGeneration generation() const noexcept { return m_generation; }

private:
    friend class RuntimeCapabilitySet;
    friend class RuntimeCapabilityIssuer;
    RuntimeCommandCapabilities(RuntimeCommandGateway& gateway, std::uint64_t groups,
                               CapabilityGeneration generation) noexcept
        : m_gateway(&gateway), m_groups(groups), m_generation(generation)
    {
    }

    RuntimeCommandGateway* m_gateway = nullptr;
    std::uint64_t m_groups = 0;
    CapabilityGeneration m_generation;
};

class RuntimeCapabilitySet {
public:
    [[nodiscard]] RuntimeCapabilityProfile profile() const noexcept { return m_profile; }
    [[nodiscard]] bool can_query(RuntimeCapabilityGroup group) const noexcept
    {
        return m_queries.has(group);
    }
    [[nodiscard]] bool can_command(RuntimeCapabilityGroup group) const noexcept
    {
        return m_commands.has(group);
    }
    [[nodiscard]] CapabilityGeneration generation() const noexcept
    {
        return m_queries.generation();
    }
    [[nodiscard]] RoomCompositionDraftAccess* room_composition_draft() const noexcept
    {
        return m_room_composition_draft != nullptr && m_room_composition_draft->active()
                   ? m_room_composition_draft
                   : nullptr;
    }

private:
    friend class noveltea::script::RuntimeScriptApi;
    friend class RuntimeCapabilityIssuer;
    [[nodiscard]] const RuntimeCommandGateway*
    query_gateway(RuntimeCapabilityGroup group) const noexcept
    {
        return m_queries.has(group) ? m_queries.m_gateway : nullptr;
    }
    [[nodiscard]] RuntimeCommandGateway*
    command_gateway(RuntimeCapabilityGroup group) const noexcept
    {
        return m_commands.has(group) ? m_commands.m_gateway : nullptr;
    }
    [[nodiscard]] const RuntimeCommandGateway* gateway() const noexcept
    {
        return m_queries.m_gateway;
    }
    RuntimeCapabilitySet(RuntimeCapabilityProfile profile, RuntimeQueryCapabilities queries,
                         RuntimeCommandCapabilities commands,
                         RoomCompositionDraftAccess* room_composition_draft) noexcept
        : m_profile(profile), m_queries(queries), m_commands(commands),
          m_room_composition_draft(room_composition_draft)
    {
    }

    RuntimeCapabilityProfile m_profile;
    RuntimeQueryCapabilities m_queries;
    RuntimeCommandCapabilities m_commands;
    RoomCompositionDraftAccess* m_room_composition_draft = nullptr;
};

struct RuntimeCapabilityProfileDescriptor {
    RuntimeCapabilityProfile profile;
    std::uint64_t query_groups = 0;
    std::uint64_t command_groups = 0;
    bool may_yield = false;
    bool admits_room_composition_draft = false;
    auto operator<=>(const RuntimeCapabilityProfileDescriptor&) const = default;
};

[[nodiscard]] constexpr std::uint64_t capability_bit(RuntimeCapabilityGroup group) noexcept
{
    return std::uint64_t{1} << static_cast<std::uint8_t>(group);
}

static_assert(static_cast<std::uint8_t>(RuntimeCapabilityGroup::Count) <= 64);

[[nodiscard]] constexpr RuntimeCapabilityProfileDescriptor
describe(RuntimeCapabilityProfile profile) noexcept
{
    using G = RuntimeCapabilityGroup;
    const auto all_gameplay_queries =
        capability_bit(G::Definitions) | capability_bit(G::Variables) |
        capability_bit(G::Properties) | capability_bit(G::Flow) | capability_bit(G::Room) |
        capability_bit(G::Character) | capability_bit(G::Interactable) |
        capability_bit(G::Presentation) | capability_bit(G::Audio) | capability_bit(G::Map) |
        capability_bit(G::Save) | capability_bit(G::Game) | capability_bit(G::Random) |
        capability_bit(G::TextLog);
    const auto gameplay_commands = all_gameplay_queries & ~capability_bit(G::Definitions);
    const auto expression_queries = capability_bit(G::Definitions) | capability_bit(G::Variables) |
                                    capability_bit(G::Properties) | capability_bit(G::Room) |
                                    capability_bit(G::Character) | capability_bit(G::Interactable) |
                                    capability_bit(G::Game) | capability_bit(G::TextLog);

    switch (profile) {
    case RuntimeCapabilityProfile::GameplayScript:
        return {profile, all_gameplay_queries, gameplay_commands, true, false};
    case RuntimeCapabilityProfile::SynchronousExpression:
        return {profile, expression_queries, 0, false, false};
    case RuntimeCapabilityProfile::RoomComposition:
        return {profile, expression_queries, 0, false, true};
    case RuntimeCapabilityProfile::GameplayLayoutEvent:
        return {profile, all_gameplay_queries, gameplay_commands, false, false};
    case RuntimeCapabilityProfile::ShellLayoutEvent:
        return {profile, capability_bit(G::Save) | capability_bit(G::Game),
                capability_bit(G::Save) | capability_bit(G::Game), false, false};
    case RuntimeCapabilityProfile::Tooling:
        return {profile, all_gameplay_queries | capability_bit(G::Tooling),
                gameplay_commands | capability_bit(G::Tooling), false, false};
    }
    return {profile, 0, 0, false, false};
}

[[nodiscard]] constexpr bool is_valid(RuntimeCapabilityProfile profile) noexcept
{
    switch (profile) {
    case RuntimeCapabilityProfile::GameplayScript:
    case RuntimeCapabilityProfile::SynchronousExpression:
    case RuntimeCapabilityProfile::RoomComposition:
    case RuntimeCapabilityProfile::GameplayLayoutEvent:
    case RuntimeCapabilityProfile::ShellLayoutEvent:
    case RuntimeCapabilityProfile::Tooling:
        return true;
    }
    return false;
}

class RuntimeCapabilityIssuer {
public:
    RuntimeCapabilityIssuer(RuntimeCommandGateway& gateway,
                            CapabilityGeneration generation) noexcept
        : m_gateway(gateway), m_generation(generation)
    {
    }

    [[nodiscard]] std::optional<RuntimeCapabilitySet>
    issue(RuntimeCapabilityProfile profile) const noexcept
    {
        if (!is_valid(profile)) {
            return std::nullopt;
        }
        const auto descriptor = describe(profile);
        if (descriptor.admits_room_composition_draft) {
            return std::nullopt;
        }
        return make(profile, descriptor, nullptr);
    }

    [[nodiscard]] RuntimeCapabilitySet
    issue_room_composition(RoomCompositionDraftAccess& draft) const noexcept
    {
        const auto profile = RuntimeCapabilityProfile::RoomComposition;
        return make(profile, describe(profile), &draft);
    }

private:
    [[nodiscard]] RuntimeCapabilitySet make(RuntimeCapabilityProfile profile,
                                            const RuntimeCapabilityProfileDescriptor& descriptor,
                                            RoomCompositionDraftAccess* draft) const noexcept
    {
        return RuntimeCapabilitySet(
            profile, RuntimeQueryCapabilities(m_gateway, descriptor.query_groups, m_generation),
            RuntimeCommandCapabilities(m_gateway, descriptor.command_groups, m_generation), draft);
    }

    RuntimeCommandGateway& m_gateway;
    CapabilityGeneration m_generation;
};

} // namespace noveltea::runtime
