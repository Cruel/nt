#include "noveltea/runtime/runtime_command_gateway.hpp"

#include "noveltea/core/runtime_diagnostic_context.hpp"

#include <algorithm>
#include <cmath>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics gateway_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
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

bool map_state_equal(const std::optional<core::MapPresentationState>& left,
                     const std::optional<core::MapPresentationState>& right)
{
    if (left.has_value() != right.has_value())
        return false;
    return !left ||
           (left->map == right->map && left->mode == right->mode &&
            left->visible == right->visible && left->focused_location == right->focused_location);
}

bool audio_state_equal(const std::optional<core::AudioChannelState>& left,
                       const std::optional<core::AudioChannelState>& right)
{
    if (left.has_value() != right.has_value())
        return false;
    return !left || (left->channel == right->channel && left->asset == right->asset &&
                     left->volume == right->volume && left->loop == right->loop &&
                     left->playing == right->playing);
}

} // namespace

RuntimeCommandGateway::RuntimeCommandGateway(const core::CompiledProject& project,
                                             core::SessionState& state,
                                             CapabilityGeneration generation) noexcept
    : m_project(project), m_state(state), m_generation(generation)
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
        const auto* value = parsed_id ? m_project.find_room(*parsed_id) : nullptr;
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
        const auto* value = parsed_id ? m_project.find_character(*parsed_id) : nullptr;
        return value ? Result::success(summary(kind, *value))
                     : Result::failure(gateway_error("runtime.unknown_character",
                                                     "Character definition is missing or invalid"));
    }
    case core::ProjectDefinitionKind::Interactable: {
        auto parsed = core::InteractableId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_interactable(*parsed_id) : nullptr;
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
RuntimeCommandGateway::variable(const core::VariableId& id) const
{
    return m_state.variable(m_project, id);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::set_variable(const core::VariableId& id, core::RuntimeValue value)
{
    const auto before = m_state.variable(m_project, id);
    auto changed = m_state.set_variable(m_project, id, std::move(value));
    if (!changed)
        return changed;
    const auto after = m_state.variable(m_project, id);
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
    core::PropertyResolver resolver(m_project, m_state);
    return resolver.get(owner, property_id);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::set_property(core::PropertyOwnerRef owner, core::PropertyId property_id,
                                    core::RuntimeValue value)
{
    const auto* before = m_state.property_override(owner, property_id);
    const auto before_value = before ? std::optional<core::RuntimeValue>{*before} : std::nullopt;
    core::PropertyResolver resolver(m_project, m_state);
    auto changed = resolver.set(owner, property_id, std::move(value));
    if (!changed)
        return changed;
    const auto* after = m_state.property_override(owner, property_id);
    if (before_value != (after ? std::optional<core::RuntimeValue>{*after} : std::nullopt))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::unset_property(const core::PropertyOwnerRef& owner,
                                      const core::PropertyId& property_id)
{
    const bool existed = m_state.property_override(owner, property_id) != nullptr;
    core::PropertyResolver resolver(m_project, m_state);
    auto changed = resolver.unset(owner, property_id);
    if (changed && existed)
        record_structural_mutation();
    return changed;
}

core::Result<core::compiled::InteractableLocation, core::Diagnostics>
RuntimeCommandGateway::interactable_location(const core::InteractableId& interactable) const
{
    const auto* state = m_state.interactable(interactable);
    if (m_project.find_interactable(interactable) == nullptr || state == nullptr) {
        return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_interactable",
                          "Interactable definition or live state is missing"));
    }
    return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::success(
        state->location);
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
    if (m_project.find_interactable(interactable) == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            gateway_error("runtime.unknown_interactable", "Interactable definition is missing"));
    if (const auto* placement = std::get_if<core::compiled::RoomPlacementRef>(&target)) {
        const auto* room = m_project.find_room(placement->room);
        const bool valid =
            room != nullptr && std::any_of(room->placements.begin(), room->placements.end(),
                                           [placement](const core::compiled::RoomPlacement& item) {
                                               return item.id == placement->placement_id;
                                           });
        if (!valid) {
            return core::Result<void, core::Diagnostics>::failure(
                gateway_error("runtime.invalid_interactable_location",
                              "Room placement does not exist in the named Room"));
        }
    }
    return enqueue(MoveInteractableCommand{std::move(interactable), std::move(target)});
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
    const auto* room = active == nullptr ? nullptr : m_project.find_room(active->room);
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
                return m_project.find_room(value) != nullptr;
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
RuntimeCommandGateway::present_map(core::MapId map,
                                   std::optional<core::compiled::InitialMapMode> mode, bool visible,
                                   std::optional<core::MapLocationId> focused_location)
{
    auto available = require_services("Map presentation");
    if (!available)
        return available;
    const auto before = m_state.map_presentation();
    auto changed =
        m_services->present_map(std::move(map), mode, visible, std::move(focused_location));
    if (changed && !map_state_equal(before, m_state.map_presentation()))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics> RuntimeCommandGateway::hide_map()
{
    auto available = require_services("Map hiding");
    if (!available)
        return available;
    const auto before = m_state.map_presentation();
    auto changed = m_services->hide_map();
    if (changed && !map_state_equal(before, m_state.map_presentation()))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::select_map_location(core::MapLocationId location)
{
    auto available = require_services("Map selection");
    if (!available)
        return available;
    const auto before = m_state.map_presentation();
    auto changed = m_services->select_map_location(std::move(location));
    if (changed && !map_state_equal(before, m_state.map_presentation()))
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::activate_map_connection(core::MapConnectionId connection)
{
    auto available = require_services("Map activation");
    if (!available)
        return available;
    return m_services->activate_map_connection(std::move(connection));
}

core::Result<core::MapPresentationState, core::Diagnostics> RuntimeCommandGateway::map_state() const
{
    if (!m_state.map_presentation()) {
        return core::Result<core::MapPresentationState, core::Diagnostics>::failure(
            gateway_error("runtime.map_not_presented", "No typed Map presentation is active"));
    }
    return core::Result<core::MapPresentationState, core::Diagnostics>::success(
        *m_state.map_presentation());
}

core::Result<std::optional<core::LayoutId>, core::Diagnostics>
RuntimeCommandGateway::layout(core::compiled::LayoutSlot slot) const
{
    return m_state.layout(slot);
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::set_layout(core::compiled::LayoutSlot slot, core::LayoutId layout_id)
{
    const auto before = m_state.layout(slot);
    auto changed = m_state.set_layout(m_project, slot, std::move(layout_id));
    const auto after = m_state.layout(slot);
    if (changed && before && after && *before.value_if() != *after.value_if())
        record_structural_mutation();
    return changed;
}

core::Result<void, core::Diagnostics>
RuntimeCommandGateway::clear_layout(core::compiled::LayoutSlot slot)
{
    const auto before = m_state.layout(slot);
    auto changed = m_state.clear_layout(slot);
    if (changed && before && before.value_if()->has_value())
        record_structural_mutation();
    return changed;
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
    bool await_completion)
{
    auto available = require_services("Audio command");
    if (!available)
        return available;
    const auto before = audio_channel(channel);
    auto changed = m_services->request_audio(action, channel, std::move(asset), fade, loop, volume,
                                             await_completion);
    const auto after = audio_channel(channel);
    if (changed && before && after && !audio_state_equal(*before.value_if(), *after.value_if()))
        record_structural_mutation();
    return changed;
}

core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
RuntimeCommandGateway::audio_channel(core::compiled::AudioChannel channel) const
{
    if (channel > core::compiled::AudioChannel::Ambient) {
        return core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>::failure(
            gateway_error("runtime.invalid_audio_channel", "Typed audio channel is invalid"));
    }
    const auto& channels = m_state.audio_channels();
    const auto found = std::find_if(
        channels.begin(), channels.end(),
        [channel](const core::AudioChannelState& value) { return value.channel == channel; });
    return core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>::success(
        found == channels.end() ? std::nullopt : std::optional<core::AudioChannelState>{*found});
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
    if (m_project.find_interactable(interactable) == nullptr) {
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
                        return m_project.find_character(value.character) != nullptr;
                    else
                        return m_project.find_interactable(value.interactable) != nullptr;
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
}

} // namespace noveltea::runtime
