#include "noveltea/runtime/runtime_command_gateway.hpp"

#include "noveltea/core/runtime_diagnostic_context.hpp"

#include <algorithm>
#include <cmath>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {

RuntimeQueryCapabilities::RuntimeQueryCapabilities(const RuntimeCommandGateway& gateway,
                                                   std::uint64_t groups,
                                                   CapabilityGeneration generation) noexcept
    : m_gateway(&gateway), m_provider(&gateway), m_groups(groups), m_generation(generation)
{
}

RuntimeCapabilityIssuer::RuntimeCapabilityIssuer(RuntimeCommandGateway& gateway,
                                                 CapabilityGeneration generation) noexcept
    : m_queries(gateway), m_commands(&gateway), m_generation(generation)
{
}
namespace {

core::Diagnostics gateway_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

bool changes_item_stacks(const ItemStackMutation& mutation) noexcept
{
    return !mutation.changed.empty() || !mutation.created.empty() || !mutation.ended.empty();
}

template<class Definition>
core::ProjectDefinitionSummary summary(core::ProjectDefinitionKind kind,
                                       const Definition& definition)
{
    std::optional<std::string> display_name;
    if constexpr (requires { definition.display_name; })
        display_name = definition.display_name;
    return core::ProjectDefinitionSummary{kind, definition.identity.id.text(),
                                          std::move(display_name)};
}

bool has_dialogue_block(const core::compiled::DialogueDefinition& dialogue,
                        const core::DialogueBlockId& block) noexcept
{
    return std::any_of(
        dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
        [&block](const core::compiled::DialogueBlock& candidate) {
            return std::visit([&block](const auto& value) { return value.id == block; }, candidate);
        });
}

core::Diagnostics index_error(std::string operation)
{
    return gateway_error("runtime.script_index_out_of_range",
                         std::move(operation) +
                             " uses zero-based indices and the index is out of range");
}

core::Result<void, core::Diagnostics> require_gameplay_owner(const core::CompiledProject& project,
                                                             const core::SessionState& state,
                                                             const core::PresentationOwner& owner)
{
    if (core::presentation_authority(owner) == core::PresentationAuthority::Shell)
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.shell_presentation_forbidden",
            "Gameplay runtime commands cannot create or mutate shell-owned presentation"));
    return state.validate_presentation_owner(project, owner);
}

} // namespace

core::Result<void, core::Diagnostics>
RoomCompositionDraftAccess::set_character_visible(const core::CharacterId& character, bool visible)
{
    if (!m_active || m_draft == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "room_composition.draft_closed",
                              .message = "Room composition draft is no longer active"}});
    if (m_restricted && !m_character_ids.contains(character.text()))
        return core::Result<void, core::Diagnostics>::failure({core::Diagnostic{
            .code = "room_composition.character_unadmitted",
            .message = "Character is not admitted for Room composition mutation"}});
    const auto found = std::find_if(m_draft->actors.begin(), m_draft->actors.end(),
                                    [&character](const core::ResolvedRoomActor& actor) {
                                        return actor.character == character;
                                    });
    if (found == m_draft->actors.end())
        return core::Result<void, core::Diagnostics>::failure({core::Diagnostic{
            .code = "room_composition.unknown_character",
            .message = "Character is not present in the Room composition draft"}});
    found->visible = visible;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RoomCompositionDraftAccess::set_interactable_visible(const core::InteractableId& interactable,
                                                     bool visible)
{
    if (!m_active || m_draft == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            {core::Diagnostic{.code = "room_composition.draft_closed",
                              .message = "Room composition draft is no longer active"}});
    if (m_restricted && !m_interactable_ids.contains(interactable.text()))
        return core::Result<void, core::Diagnostics>::failure({core::Diagnostic{
            .code = "room_composition.interactable_unadmitted",
            .message = "Interactable is not admitted for Room composition mutation"}});
    const auto found = std::find_if(m_draft->interactables.begin(), m_draft->interactables.end(),
                                    [&interactable](const core::ResolvedRoomInteractable& value) {
                                        return value.interactable == interactable;
                                    });
    if (found == m_draft->interactables.end())
        return core::Result<void, core::Diagnostics>::failure({core::Diagnostic{
            .code = "room_composition.unknown_interactable",
            .message = "Interactable is not present in the Room composition draft"}});
    found->visible = visible;
    return core::Result<void, core::Diagnostics>::success();
}

RuntimeCommandGateway::RuntimeCommandGateway(const core::CompiledProject& project,
                                             core::SessionState& state, RuntimeWorld& world,
                                             CapabilityGeneration generation) noexcept
    : m_project(project), m_state(state), m_world(world), m_generation(generation)
{
}

core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
RuntimeCommandGateway::definition(core::ProjectDefinitionKind kind, std::string id) const
{
    using Result = core::Result<core::ProjectDefinitionSummary, core::Diagnostics>;
    switch (kind) {
    case core::ProjectDefinitionKind::Room: {
        auto parsed = core::RoomId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_world.resolved_configuration(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_room",
                                                     "Room definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Scene: {
        auto parsed = core::SceneId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_scene(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_scene",
                                                     "Scene definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Dialogue: {
        auto parsed = core::DialogueId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_dialogue(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_dialogue",
                                                     "Dialogue definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Character: {
        auto parsed = core::CharacterId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_world.resolved_configuration(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_character",
                                                     "Character definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Interactable: {
        auto parsed = core::InteractableId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_world.resolved_configuration(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(
                           gateway_error("runtime.unknown_interactable",
                                         "Interactable definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Verb: {
        auto parsed = core::VerbId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_verb(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_verb",
                                                     "Verb definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Interaction: {
        auto parsed = core::InteractionId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_interaction(*parsed_id) : nullptr;
        return value
                   ? Result::success(summary(kind, *value))
                   : Result::failure(gateway_error("runtime.unknown_interaction",
                                                   "Interaction definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Map: {
        auto parsed = core::MapId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_map(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_map",
                                                     "Map definition is missing or invalid"));
    }
    }
    return Result::failure(
        gateway_error("runtime.invalid_definition_kind", "Definition kind is invalid"));
}

core::Result<core::RuntimeValue, core::Diagnostics>
RuntimeCommandGateway::global_property(const core::PropertyId& id) const
{
    core::PropertyResolver resolver(m_project, m_state);
    auto resolved = resolver.get_global(id);
    const auto* lookup = resolved.value_if();
    if (lookup == nullptr)
        return core::Result<core::RuntimeValue, core::Diagnostics>::failure(resolved.error());
    const auto* value = std::get_if<core::RuntimeValue>(lookup);
    if (value == nullptr)
        return core::Result<core::RuntimeValue, core::Diagnostics>::failure(gateway_error(
            "runtime.missing_global_property", "Global Property resolved without a value"));
    return core::Result<core::RuntimeValue, core::Diagnostics>::success(*value);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::set_global_property(const core::PropertyId& id, core::RuntimeValue value)
{
    const auto before = global_property(id);
    core::PropertyResolver resolver(m_project, m_state);
    auto changed = resolver.set_global(id, std::move(value));
    if (!changed)
        return changed;
    const auto after = global_property(id);
    const auto* before_value = before.value_if();
    const auto* after_value = after.value_if();
    if (before_value == nullptr || after_value == nullptr || *before_value != *after_value)
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::unset_global_property(const core::PropertyId& id)
{
    const auto before = global_property(id);
    core::PropertyResolver resolver(m_project, m_state);
    auto changed = resolver.unset_global(id);
    if (!changed)
        return changed;
    const auto after = global_property(id);
    const auto* before_value = before.value_if();
    const auto* after_value = after.value_if();
    if (before_value == nullptr || after_value == nullptr || *before_value != *after_value)
        record_structural_mutation();
    return changed;
}

core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeCommandGateway::property(const core::PropertyOwnerRef& owner,
                                const core::PropertyId& property_id) const
{
    return std::visit(
        [this, &property_id](
            const auto& id) -> core::Result<core::PropertyLookupResult, core::Diagnostics> {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, core::RoomId> || std::is_same_v<T, core::CharacterId> ||
                          std::is_same_v<T, core::InteractableId>) {
                return m_world.resolve_property(id, property_id);
            } else {
                core::PropertyResolver resolver(m_project, m_state);
                return resolver.get(core::PropertyOwnerRef{id}, property_id);
            }
        },
        owner);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::set_property(core::PropertyOwnerRef owner, core::PropertyId property_id,
                                    core::RuntimeValue value)
{
    const auto target = core::property_target(owner);
    const auto* before = m_state.property_override(target, property_id);
    const auto before_value = before ? std::optional<core::RuntimeValue>{*before} : std::nullopt;
    core::PropertyResolver resolver(m_project, m_state);
    auto changed = resolver.set(owner, property_id, std::move(value));
    if (!changed)
        return changed;
    const auto* after = m_state.property_override(target, property_id);
    if (before_value != (after ? std::optional<core::RuntimeValue>{*after} : std::nullopt))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::unset_property(const core::PropertyOwnerRef& owner,
                                      const core::PropertyId& property_id)
{
    const bool existed =
        m_state.property_override(core::property_target(owner), property_id) != nullptr;
    core::PropertyResolver resolver(m_project, m_state);
    auto changed = resolver.unset(owner, property_id);
    if (changed && existed)
        record_structural_mutation();
    return changed;
}

core::Result<core::RoomId, core::Diagnostics>
RuntimeCommandGateway::create_room(RuntimeInstanceConfigurationRequest source)
{
    auto created = m_world.create_room(std::move(source));
    if (created)
        record_structural_mutation();
    return created;
}

core::Result<core::CharacterId, core::Diagnostics>
RuntimeCommandGateway::create_character(RuntimeInstanceConfigurationRequest source,
                                        core::CharacterWorldLocation location, bool enabled,
                                        bool visible)
{
    auto created =
        m_world.create_character(std::move(source), std::move(location), enabled, visible);
    if (created)
        record_structural_mutation();
    return created;
}

core::Result<core::InteractableId, core::Diagnostics>
RuntimeCommandGateway::create_interactable(RuntimeInstanceConfigurationRequest source,
                                           core::compiled::InteractableLocation location,
                                           bool enabled, bool visible)
{
    auto created =
        m_world.create_interactable(std::move(source), std::move(location), enabled, visible);
    if (created)
        record_structural_mutation();
    return created;
}

core::Result<core::ItemStackState, core::Diagnostics>
RuntimeCommandGateway::item_stack(const core::ItemStackId& id) const
{
    const auto* value = m_world.item_stack(id);
    return value != nullptr
               ? core::Result<core::ItemStackState, core::Diagnostics>::success(*value)
               : core::Result<core::ItemStackState, core::Diagnostics>::failure(
                     gateway_error("runtime.stale_item_stack", "Item Stack identity is not live"));
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeCommandGateway::split_item_stack(core::ItemStackId source, std::uint64_t quantity)
{
    auto result = m_world.split_item_stack(source, quantity);
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeCommandGateway::merge_item_stacks(core::ItemStackId receiver, core::ItemStackId donor)
{
    auto result = m_world.merge_item_stacks(receiver, donor);
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeCommandGateway::transfer_item_quantity(core::ItemStackId source, std::uint64_t quantity,
                                              core::compiled::ItemStackLocation location,
                                              ItemStackPlacementPolicy policy)
{
    auto result = m_world.transfer_item_quantity(source, quantity, std::move(location), policy);
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<ItemStackMutation, core::Diagnostics> RuntimeCommandGateway::grant_item_quantity(
    core::ItemDefinitionId definition, std::uint64_t quantity,
    core::compiled::ItemStackLocation location, ItemStackPlacementPolicy policy)
{
    auto result = m_world.grant_item_quantity(definition, quantity, std::move(location), policy);
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeCommandGateway::consume_item_quantity(core::ItemStackId stack, std::uint64_t quantity)
{
    auto result = m_world.consume_item_quantity(stack, quantity);
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeCommandGateway::consume_item_quantity(ItemStackFilter filter, std::uint64_t quantity)
{
    auto result = m_world.consume_item_quantity(filter, quantity);
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<std::uint64_t, core::Diagnostics>
RuntimeCommandGateway::aggregate_item_quantity(const ItemStackFilter& filter) const
{
    return m_world.aggregate_item_quantity(filter);
}

core::Result<ItemStackMutation, core::Diagnostics>
RuntimeCommandGateway::set_item_stack_traits(core::ItemStackId stack,
                                             std::vector<core::TraitId> traits)
{
    auto result = m_world.set_item_stack_traits(stack, std::move(traits));
    if (const auto* mutation = result.value_if();
        mutation != nullptr && changes_item_stacks(*mutation))
        record_structural_mutation();
    return result;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::replace_instance_configuration(core::GameplayInstanceRef instance,
                                                      RuntimeInstanceConfigurationRequest source)
{
    auto result = std::visit(
        [&](const auto& id) {
            return m_world.replace_structural_configuration(id, std::move(source));
        },
        instance);
    if (result)
        record_structural_mutation();
    return result;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::clear_instance_configuration(core::GameplayInstanceRef instance)
{
    auto result = std::visit(
        [&](const auto& id) { return m_world.clear_structural_configuration(id); }, instance);
    if (result)
        record_structural_mutation();
    return result;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::retarget_room_exit(core::RoomId room, core::RoomExitId exit,
                                          core::RoomId target)
{
    auto result = m_world.retarget_room_exit(room, exit, target);
    if (result)
        record_structural_mutation();
    return result;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::destroy_instance(core::GameplayInstanceRef instance)
{
    auto result = m_world.destroy(instance);
    if (result)
        record_structural_mutation();
    return result;
}

core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>
RuntimeCommandGateway::instance_provenance(const core::GameplayInstanceRef& instance) const
{
    const auto* value = m_world.provenance(instance);
    return value != nullptr
               ? core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>::success(*value)
               : core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>::failure(
                     gateway_error("runtime.unknown_gameplay_instance",
                                   "Gameplay Instance is not live"));
}

core::Result<core::compiled::InteractableLocation, core::Diagnostics>
RuntimeCommandGateway::interactable_location(const core::InteractableId& interactable) const
{
    const auto* state = m_world.interactable_state(interactable);
    if (state == nullptr) {
        return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_interactable",
                          "Interactable definition or live state is missing"));
    }
    return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::success(
        state->location);
}

core::Result<core::InteractableState, core::Diagnostics>
RuntimeCommandGateway::interactable_state(const core::InteractableId& interactable) const
{
    const auto* state = m_world.interactable_state(interactable);
    return state != nullptr
               ? core::Result<core::InteractableState, core::Diagnostics>::success(*state)
               : core::Result<core::InteractableState, core::Diagnostics>::failure(
                     gateway_error("runtime.unknown_interactable",
                                   "Interactable definition or live state is missing"));
}

core::Result<core::CharacterWorldLocation, core::Diagnostics>
RuntimeCommandGateway::character_location(const core::CharacterId& character) const
{
    const auto* state = m_world.character_state(character);
    return state != nullptr
               ? core::Result<core::CharacterWorldLocation, core::Diagnostics>::success(
                     state->location)
               : core::Result<core::CharacterWorldLocation, core::Diagnostics>::failure(
                     gateway_error("runtime.unknown_character",
                                   "Character definition or live world state is missing"));
}

core::Result<core::CharacterWorldState, core::Diagnostics>
RuntimeCommandGateway::character_world_state(const core::CharacterId& character) const
{
    const auto* state = m_world.character_state(character);
    return state != nullptr
               ? core::Result<core::CharacterWorldState, core::Diagnostics>::success(*state)
               : core::Result<core::CharacterWorldState, core::Diagnostics>::failure(
                     gateway_error("runtime.unknown_character",
                                   "Character definition or live world state is missing"));
}

RuntimeSourceContext RuntimeCommandGateway::source_context() const
{
    if (m_state.flow_stack().empty())
        return {};
    const auto frame = core::flow_frame_id(m_state.flow_stack().back());
    return RuntimeSourceContext{
        .frame = frame,
        .diagnostic = core::RuntimeDiagnosticContext{
            core::RuntimeDiagnosticContextValue{core::FlowFrameRuntimeContext{frame}}}};
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::enqueue(DeferredRuntimeCommandPayload payload)
{
    auto queued = m_commands.enqueue(
        DeferredRuntimeCommandRequest{.source = source_context(), .payload = std::move(payload)});
    return queued ? core::Result<void, core::Diagnostics>::success()
                  : core::Result<void, core::Diagnostics>::failure(std::move(queued).error());
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::request_interactable_location(core::InteractableId interactable,
                                                     core::compiled::InteractableLocation target)
{
    if (m_world.resolved_configuration(interactable) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_interactable", "Interactable definition is missing"));
    if (const auto* room = std::get_if<core::compiled::RoomLocation>(&target);
        room && m_world.resolved_configuration(room->room) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_interactable_location", "Room Location is unresolved"));
    if (const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&target);
        inventory && !m_world.has_inventory(inventory->inventory))
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_interactable_location", "Inventory Location is unresolved"));
    return enqueue(SetInteractableWorldStateCommand{std::move(interactable), std::move(target),
                                                    std::nullopt, std::nullopt});
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::request_interactable_state(
    core::InteractableId interactable, std::optional<core::compiled::InteractableLocation> location,
    std::optional<bool> enabled, std::optional<bool> visible)
{
    if (m_world.resolved_configuration(interactable) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_interactable", "Interactable definition is missing"));
    if (location) {
        if (const auto* room = std::get_if<core::compiled::RoomLocation>(&*location);
            room && m_world.resolved_configuration(room->room) == nullptr)
            return core::Result<void, core::Diagnostics>::failure(gateway_error(
                "runtime.invalid_interactable_location", "Room Location is unresolved"));
        if (const auto* inventory = std::get_if<core::compiled::InventoryLocation>(&*location);
            inventory && !m_world.has_inventory(inventory->inventory))
            return core::Result<void, core::Diagnostics>::failure(gateway_error(
                "runtime.invalid_interactable_location", "Inventory Location is unresolved"));
    }
    return enqueue(SetInteractableWorldStateCommand{std::move(interactable), std::move(location),
                                                    enabled, visible});
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::request_character_world_state(
    core::CharacterId character, std::optional<core::CharacterWorldLocation> location,
    std::optional<bool> enabled, std::optional<bool> visible)
{
    if (m_world.resolved_configuration(character) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_character", "Character definition is missing"));
    if (location) {
        if (const auto* room = std::get_if<core::compiled::RoomLocation>(&*location);
            room && m_world.resolved_configuration(room->room) == nullptr)
            return core::Result<void, core::Diagnostics>::failure(
                gateway_error("runtime.invalid_character_location", "Room Location is unresolved"));
    }
    return enqueue(
        SetCharacterWorldStateCommand{std::move(character), std::move(location), enabled, visible});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::require_room_mode(std::string operation) const
{
    if (!std::holds_alternative<core::RoomMode>(m_state.mode()) || !m_state.flow_stack().empty()) {
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_room_mode", std::move(operation) + " requires Room mode"));
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::require_flow_mode(std::string operation) const
{
    if (!std::holds_alternative<core::FlowMode>(m_state.mode()) || m_state.flow_stack().empty()) {
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_flow_mode", std::move(operation) + " requires an active frame"));
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::request_navigation(core::compiled::RoomExitRef exit)
{
    auto mode = require_room_mode("Navigation");
    if (!mode)
        return mode;
    const auto* active = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* room = active == nullptr ? nullptr : m_world.resolved_configuration(active->room);
    if (room == nullptr || exit.room != active->room) {
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_navigation", "Navigation exit is not in the active Room"));
    }
    const auto found = std::find_if(room->exits.begin(), room->exits.end(),
                                    [&exit](const core::compiled::RoomExit& candidate) {
                                        return candidate.id == exit.exit_id;
                                    });
    if (found == room->exits.end()) {
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_navigation", "Navigation exit is missing"));
    }
    return enqueue(NavigateRoomCommand{std::move(exit), found->target});
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::request_transient(core::SceneId scene)
{
    auto mode = require_room_mode("Transient Scene start");
    if (!mode)
        return mode;
    if (m_project.find_scene(scene) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_scene", "Scene definition is missing"));
    return enqueue(StartTransientSceneCommand{std::move(scene)});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::request_transient(core::DialogueId dialogue)
{
    auto mode = require_room_mode("Transient Dialogue start");
    if (!mode)
        return mode;
    if (m_project.find_dialogue(dialogue) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_dialogue", "Dialogue definition is missing"));
    return enqueue(StartTransientDialogueCommand{std::move(dialogue)});
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::request_child(core::SceneId scene)
{
    auto mode = require_flow_mode("Child Scene call");
    if (!mode)
        return mode;
    if (m_project.find_scene(scene) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_scene", "Scene definition is missing"));
    return enqueue(CallChildSceneCommand{std::move(scene)});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::request_child(core::DialogueId dialogue,
                                     std::optional<core::DialogueBlockId> start_block)
{
    auto mode = require_flow_mode("Child Dialogue call");
    if (!mode)
        return mode;
    const auto* definition = m_project.find_dialogue(dialogue);
    if (definition == nullptr || (start_block && !has_dialogue_block(*definition, *start_block))) {
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_dialogue_target",
                          "Dialogue definition or requested start block is missing"));
    }
    return enqueue(CallChildDialogueCommand{std::move(dialogue), std::move(start_block)});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::request_tail_replacement(core::FlowTarget target)
{
    auto mode = require_flow_mode("Tail replacement");
    if (!mode)
        return mode;
    const bool valid = std::visit(
        [this](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::SceneId>)
                return m_project.find_scene(value) != nullptr;
            else if constexpr (std::is_same_v<T, core::DialogueId>)
                return m_project.find_dialogue(value) != nullptr;
            else if constexpr (std::is_same_v<T, core::RoomId>)
                return m_world.resolved_configuration(value) != nullptr;
            else
                return true;
        },
        target);
    if (!valid) {
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_flow_target", "Flow target definition is missing"));
    }
    return enqueue(TailReplaceFlowCommand{std::move(target)});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::request_notification(std::string message)
{
    if (message.empty()) {
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_notification", "Notification cannot be empty"));
    }
    m_events.emplace_back(NotificationEvent{std::move(message)});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::seed_random(std::uint64_t seed)
{
    const auto before = m_state.random_state();
    m_state.seed_random(seed);
    if (before != seed)
        record_structural_mutation();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<std::int64_t, core::Diagnostics>
RuntimeCommandGateway::random_integer(std::int64_t minimum, std::int64_t maximum)
{
    auto result = m_state.next_random_integer(minimum, maximum);
    if (result)
        record_structural_mutation();
    return result;
}

core::Result<double, core::Diagnostics> RuntimeCommandGateway::random_unit()
{
    const auto value = m_state.next_random_unit();
    record_structural_mutation();
    return core::Result<double, core::Diagnostics>::success(value);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::require_services(std::string operation) const
{
    if (m_services != nullptr)
        return core::Result<void, core::Diagnostics>::success();
    return core::Result<void, core::Diagnostics>::failure(
        gateway_error("runtime.capability_service_unavailable",
                      std::move(operation) + " requires a live runtime session service"));
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::activate_map_connection(core::MapId map, core::MapConnectionId connection)
{
    const auto* definition = m_project.find_map(map);
    if (definition == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_map", "Map definition is missing"));
    const auto found = std::find_if(definition->connections.begin(), definition->connections.end(),
                                    [&connection](const auto& candidate) {
                                        return candidate.id == connection;
                                    });
    if (found == definition->connections.end())
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_map_connection", "Map connection is missing"));
    const auto* active = std::get_if<core::RoomMode>(&m_state.mode());
    if (active == nullptr || !m_state.flow_stack().empty())
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_navigation", "Map activation requires the active Room"));
    const core::compiled::RoomExitRef* selected = nullptr;
    for (const auto& exit : found->exits) {
        if (exit.room != active->room)
            continue;
        if (selected != nullptr)
            return core::Result<void, core::Diagnostics>::failure(gateway_error(
                "runtime.invalid_map_connection", "Map connection has ambiguous outgoing Exits"));
        selected = &exit;
    }
    if (selected == nullptr)
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.map_connection_unavailable",
            "Map connection has no outgoing Exit from the active Room"));
    return request_navigation(*selected);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::upsert_background_override(core::DesiredBackgroundOverride value)
{
    auto owner = require_gameplay_owner(m_project, m_state, value.owner);
    return owner ? enqueue(UpsertBackgroundOverrideCommand{std::move(value)}) : owner;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::remove_background_override(core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(RemoveBackgroundOverrideCommand{std::move(owner)}) : valid;
}

core::Result<std::optional<core::DesiredBackgroundOverride>, core::Diagnostics>
RuntimeCommandGateway::background_override(const core::PresentationOwner& owner) const
{
    const auto found = std::find_if(
        m_state.background_overrides().begin(), m_state.background_overrides().end(),
        [&owner](const core::DesiredBackgroundOverride& value) { return value.owner == owner; });
    return core::Result<std::optional<core::DesiredBackgroundOverride>, core::Diagnostics>::success(
        found == m_state.background_overrides().end()
            ? std::nullopt
            : std::optional<core::DesiredBackgroundOverride>{*found});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::upsert_actor_presentation(core::DesiredActorPresentation value)
{
    auto owner = require_gameplay_owner(m_project, m_state, value.owner);
    return owner ? enqueue(UpsertActorPresentationCommand{std::move(value)}) : owner;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::remove_actor_presentation(core::ActorPresentationKey key,
                                                 core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(RemoveActorPresentationCommand{std::move(key), std::move(owner)})
                 : valid;
}

core::Result<std::optional<core::DesiredActorPresentation>, core::Diagnostics>
RuntimeCommandGateway::actor_presentation(const core::ActorPresentationKey& key,
                                          const core::PresentationOwner& owner) const
{
    const auto* value = m_state.actor(key, owner);
    return core::Result<std::optional<core::DesiredActorPresentation>, core::Diagnostics>::success(
        value == nullptr ? std::nullopt : std::optional<core::DesiredActorPresentation>{*value});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::upsert_presentation_prop(core::DesiredPresentationProp value)
{
    auto owner = require_gameplay_owner(m_project, m_state, value.owner);
    return owner ? enqueue(UpsertPresentationPropCommand{std::move(value)}) : owner;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::remove_presentation_prop(core::PresentationPropInstanceId instance,
                                                core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(RemovePresentationPropCommand{std::move(instance), std::move(owner)})
                 : valid;
}

core::Result<std::optional<core::DesiredPresentationProp>, core::Diagnostics>
RuntimeCommandGateway::presentation_prop(const core::PresentationPropInstanceId& instance,
                                         const core::PresentationOwner& owner) const
{
    const auto found =
        std::find_if(m_state.presentation_props().begin(), m_state.presentation_props().end(),
                     [&instance, &owner](const core::DesiredPresentationProp& value) {
                         return value.instance == instance && value.owner == owner;
                     });
    return core::Result<std::optional<core::DesiredPresentationProp>, core::Diagnostics>::success(
        found == m_state.presentation_props().end()
            ? std::nullopt
            : std::optional<core::DesiredPresentationProp>{*found});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::upsert_presentation_environment(core::DesiredPresentationEnvironment value)
{
    auto owner = require_gameplay_owner(m_project, m_state, value.owner);
    return owner ? enqueue(UpsertPresentationEnvironmentCommand{std::move(value)}) : owner;
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::remove_presentation_environment(
    core::PresentationEnvironmentInstanceId instance, core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(
                       RemovePresentationEnvironmentCommand{std::move(instance), std::move(owner)})
                 : valid;
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::remove_presentation_environments(
    core::PresentationEnvironmentStopKey stop_key, core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(RemovePresentationEnvironmentsByStopKeyCommand{std::move(stop_key),
                                                                          std::move(owner)})
                 : valid;
}

core::Result<std::optional<core::DesiredPresentationEnvironment>, core::Diagnostics>
RuntimeCommandGateway::presentation_environment(
    const core::PresentationEnvironmentInstanceId& instance,
    const core::PresentationOwner& owner) const
{
    const auto found = std::find_if(
        m_state.presentation_environments().begin(), m_state.presentation_environments().end(),
        [&instance, &owner](const core::DesiredPresentationEnvironment& value) {
            return value.instance == instance && value.owner == owner;
        });
    return core::Result<std::optional<core::DesiredPresentationEnvironment>, core::Diagnostics>::
        success(found == m_state.presentation_environments().end()
                    ? std::nullopt
                    : std::optional<core::DesiredPresentationEnvironment>{*found});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::upsert_desired_audio(core::DesiredAudioInstance value)
{
    auto owner = require_gameplay_owner(m_project, m_state, value.owner);
    return owner ? enqueue(UpsertDesiredAudioCommand{std::move(value)}) : owner;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::remove_desired_audio(core::DesiredAudioInstanceId instance,
                                            core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(RemoveDesiredAudioCommand{std::move(instance), std::move(owner)})
                 : valid;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::remove_desired_audio_bus(core::compiled::AudioChannel bus,
                                                core::PresentationOwner owner)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    return valid ? enqueue(RemoveDesiredAudioBusCommand{bus, std::move(owner)}) : valid;
}

core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>
RuntimeCommandGateway::desired_audio(const core::DesiredAudioInstanceId& instance,
                                     const core::PresentationOwner& owner) const
{
    const auto* value = m_state.desired_audio(instance, owner);
    return core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>::success(
        value == nullptr ? std::nullopt : std::optional<core::DesiredAudioInstance>{*value});
}

core::Result<core::PresentationOwner, core::Diagnostics>
RuntimeCommandGateway::presentation_owner(RuntimePresentationOwnerScope scope,
                                          std::optional<core::RoomId> room) const
{
    switch (scope) {
    case RuntimePresentationOwnerScope::Scene:
        for (auto frame = m_state.flow_stack().rbegin(); frame != m_state.flow_stack().rend();
             ++frame) {
            if (const auto* scene = std::get_if<core::SceneFrame>(&*frame)) {
                return core::Result<core::PresentationOwner, core::Diagnostics>::success(
                    core::ScenePresentationOwner{scene->frame_id, scene->scene});
            }
        }
        return core::Result<core::PresentationOwner, core::Diagnostics>::failure(
            gateway_error("runtime.scene_owner_unavailable",
                          "A Scene presentation owner requires an active Scene frame"));
    case RuntimePresentationOwnerScope::Session:
        return core::Result<core::PresentationOwner, core::Diagnostics>::success(
            m_state.session_presentation_owner());
    case RuntimePresentationOwnerScope::CurrentRoom: {
        const auto owner = m_state.current_room_presentation_owner();
        if (!owner)
            return core::Result<core::PresentationOwner, core::Diagnostics>::failure(
                gateway_error("runtime.current_room_owner_unavailable",
                              "A current-Room presentation owner requires an active Room visit"));
        return core::Result<core::PresentationOwner, core::Diagnostics>::success(*owner);
    }
    case RuntimePresentationOwnerScope::Room:
        if (!room && m_state.room_visit())
            room = m_state.room_visit()->room;
        if (!room || m_world.resolved_configuration(*room) == nullptr)
            return core::Result<core::PresentationOwner, core::Diagnostics>::failure(
                gateway_error("runtime.room_owner_unavailable",
                              "A Room presentation owner requires a valid Room"));
        return core::Result<core::PresentationOwner, core::Diagnostics>::success(
            core::RoomPresentationOwner{std::move(*room)});
    }
    return core::Result<core::PresentationOwner, core::Diagnostics>::failure(gateway_error(
        "runtime.invalid_presentation_owner_scope", "Presentation owner scope is invalid"));
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::upsert_mounted_layout(core::DesiredMountedLayout value,
                                             std::optional<LayoutFadeRequest> entrance)
{
    auto owner = require_gameplay_owner(m_project, m_state, value.owner);
    if (!owner)
        return owner;
    if (entrance && entrance->duration.count() <= 0)
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_layout_transition", "Layout fade duration must be greater than zero"));
    if (entrance && m_commands.has_pending_layout_fade())
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.presentation_operation_already_pending",
            "Only one finite Layout fade may be requested in one runtime command batch"));
    return enqueue(UpsertMountedLayoutCommand{std::move(value), entrance});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::remove_mounted_layout(core::MountedLayoutPresentationKey key,
                                             core::PresentationOwner owner,
                                             std::optional<LayoutFadeRequest> exit)
{
    auto valid = require_gameplay_owner(m_project, m_state, owner);
    if (!valid)
        return valid;
    if (exit && exit->duration.count() <= 0)
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_layout_transition", "Layout fade duration must be greater than zero"));
    if (exit && m_commands.has_pending_layout_fade())
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.presentation_operation_already_pending",
            "Only one finite Layout fade may be requested in one runtime command batch"));
    return enqueue(RemoveMountedLayoutCommand{std::move(key), std::move(owner), exit});
}

core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>
RuntimeCommandGateway::mounted_layout(const core::MountedLayoutPresentationKey& key,
                                      const core::PresentationOwner& owner) const
{
    const auto found =
        std::find_if(m_state.mounted_layouts().begin(), m_state.mounted_layouts().end(),
                     [&key, &owner](const core::DesiredMountedLayout& value) {
                         return value.key == key && value.owner == owner;
                     });
    return core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>::success(
        found == m_state.mounted_layouts().end()
            ? std::nullopt
            : std::optional<core::DesiredMountedLayout>{*found});
}

core::Result<std::optional<core::LayoutId>, core::Diagnostics>
RuntimeCommandGateway::layout(core::compiled::LayoutSlot slot) const
{
    return m_state.layout(slot);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::set_layout(core::compiled::LayoutSlot slot, core::LayoutId layout_id)
{
    if (slot > core::compiled::LayoutSlot::Custom || m_project.find_layout(layout_id) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(gateway_error(
            "runtime.invalid_layout", "Layout command references an invalid slot or Layout"));
    return enqueue(
        SetReservedLayoutCommand{m_state.session_presentation_owner(), slot, std::move(layout_id)});
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::clear_layout(core::compiled::LayoutSlot slot)
{
    if (slot > core::compiled::LayoutSlot::Custom)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_layout_slot", "Layout slot is invalid"));
    return enqueue(RemoveMountedLayoutCommand{core::ReservedLayoutMountKey{slot},
                                              m_state.session_presentation_owner(), std::nullopt});
}

core::Result<bool, core::Diagnostics> RuntimeCommandGateway::gameplay_paused() const
{
    return core::Result<bool, core::Diagnostics>::success(m_state.gameplay_paused());
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::set_gameplay_paused(bool paused)
{
    const bool before = m_state.gameplay_paused();
    m_state.set_gameplay_paused(paused);
    if (before != paused)
        record_structural_mutation();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::request_audio(
    core::compiled::AudioAction action, core::compiled::AudioChannel channel,
    std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop, double volume,
    bool await_completion, core::AudioOperationPurpose purpose)
{
    auto available = require_services("Audio command");
    if (!available)
        return available;
    return m_services->request_audio(action, channel, std::move(asset), fade, loop, volume,
                                     await_completion, purpose);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::append_text_log(core::TextLogEntry entry)
{
    auto changed = m_state.append_text_log(m_project, std::move(entry));
    if (changed)
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::clear_text_log()
{
    const bool changed = !m_state.text_log().empty();
    m_state.clear_text_log();
    if (changed)
        record_structural_mutation();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::continue_game()
{
    auto available = require_services("Game.continue");
    if (!available)
        return available;
    m_services->queue_input(core::ContinueInput{});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::choose(std::size_t index)
{
    auto available = require_services("Game.choose");
    if (!available)
        return available;
    const auto& view = m_services->current_view();
    if (view.scene && view.scene->choice) {
        if (index >= view.scene->choice->options.size())
            return core::Result<void, core::Diagnostics>::failure(index_error("Game.choose"));
        m_services->queue_input(
            core::SelectSceneChoiceInput{view.scene->choice->options[index].option});
        return core::Result<void, core::Diagnostics>::success();
    }
    if (view.dialogue && view.dialogue->choice) {
        if (index >= view.dialogue->choice->options.size())
            return core::Result<void, core::Diagnostics>::failure(index_error("Game.choose"));
        m_services->queue_input(
            core::SelectDialogueChoiceInput{view.dialogue->choice->options[index].edge});
        return core::Result<void, core::Diagnostics>::success();
    }
    return core::Result<void, core::Diagnostics>::failure(index_error("Game.choose"));
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::navigate(std::size_t index)
{
    auto available = require_services("Game.navigate");
    if (!available)
        return available;
    const auto& view = m_services->current_view();
    if (!view.room || index >= view.room->exits.size())
        return core::Result<void, core::Diagnostics>::failure(index_error("Game.navigate"));
    m_services->queue_input(core::NavigateRoomInput{view.room->exits[index].exit});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::select_interactable(core::InteractableId interactable)
{
    auto available = require_services("Game.select_interactable");
    if (!available)
        return available;
    if (m_world.resolved_configuration(interactable) == nullptr) {
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_interactable", "Interactable definition is missing"));
    }
    m_services->queue_input(core::SelectInteractionSubjectsInput{
        {core::compiled::InteractableInteractionSubject{std::move(interactable)}}});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::clear_selection()
{
    auto available = require_services("Game.clear_selection");
    if (!available)
        return available;
    m_services->queue_input(core::ClearInteractionSubjectSelectionInput{});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::run_interaction(core::VerbId verb,
                                       std::vector<core::compiled::InteractionSubject> operands)
{
    auto available = require_services("Game.run_interaction");
    if (!available)
        return available;
    if (m_project.find_verb(verb) == nullptr) {
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_verb", "Verb definition is missing"));
    }
    for (const auto& operand : operands)
        if (!std::visit(
                [this](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                        return m_world.resolved_configuration(value.character) != nullptr;
                    else if constexpr (std::is_same_v<
                                           T, core::compiled::InteractableInteractionSubject>)
                        return m_world.resolved_configuration(value.interactable) != nullptr;
                    else if constexpr (std::is_same_v<T, core::compiled::FeatureInteractionSubject>)
                        return m_project.find_feature(value.feature) != nullptr;
                    else
                        return m_world.item_stack(value.item_stack) != nullptr;
                },
                operand))
            return core::Result<void, core::Diagnostics>::failure(
                gateway_error("runtime.unknown_interaction_subject",
                              "Interaction subject definition is missing"));
    m_services->queue_input(core::InvokeInteractionInput{std::move(verb), std::move(operands)});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::save(core::TypedSaveSlotId slot)
{
    auto available = require_services("Game.save");
    if (!available)
        return available;
    m_services->queue_input(core::SaveRuntimeInput{slot});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::load(core::TypedSaveSlotId slot)
{
    auto available = require_services("Game.load");
    if (!available)
        return available;
    m_services->queue_input(core::LoadRuntimeInput{slot});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::autosave()
{
    return save(core::TypedSaveSlotId::autosave());
}

void RuntimeCommandGateway::request_autosave_safe_point()
{
    (void)enqueue(RequestAutosaveCommand{});
}

std::vector<RuntimeEvent> RuntimeCommandGateway::take_events() noexcept
{
    std::vector<RuntimeEvent> result;
    result.swap(m_events);
    return result;
}

MutationImpactJournal RuntimeCommandGateway::take_mutation_impacts() noexcept
{
    auto result = m_mutations;
    m_mutations.clear();
    return result;
}

bool RuntimeCommandGateway::has_frame_sensitive_command() const noexcept
{
    // Autosave is the only command that can safely remain queued while a frame-sensitive command
    // changes or destroys the active Flow owner.
    auto copy = m_commands;
    while (auto command = copy.pop_front()) {
        if (!std::holds_alternative<RequestAutosaveCommand>(command->payload))
            return true;
    }
    return false;
}

void RuntimeCommandGateway::clear_transient_state() noexcept
{
    m_commands.clear();
    m_events.clear();
    m_mutations.clear();
}

void RuntimeCommandGateway::record_structural_mutation() noexcept
{
    m_mutations.record(MutationImpact::StructuralStateChanged);
    m_mutations.record(MutationImpact::GameplayUiInvalidated);
    m_mutations.record(MutationImpact::PresentationInvalidated);
    m_mutations.record(MutationImpact::CheckpointReadinessInvalidated);
    m_mutations.record(MutationImpact::RoomPresentationInvalidated);
}

} // namespace noveltea::runtime
