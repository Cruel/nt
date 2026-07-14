#include "noveltea/core/script_host_services.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics host_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

template<class Definition>
ProjectDefinitionSummary summary(ProjectDefinitionKind kind, const Definition& definition)
{
    std::optional<std::string> display_name;
    if constexpr (requires { definition.display_name; })
        display_name = definition.display_name;
    return ProjectDefinitionSummary{kind, definition.identity.id.text(), std::move(display_name)};
}

bool has_dialogue_block(const compiled::DialogueDefinition& dialogue,
                        const DialogueBlockId& block) noexcept
{
    return std::any_of(
        dialogue.program.blocks.begin(), dialogue.program.blocks.end(),
        [&block](const compiled::DialogueBlock& candidate) {
            return std::visit([&block](const auto& value) { return value.id == block; }, candidate);
        });
}

} // namespace

Result<ProjectDefinitionSummary, Diagnostics>
ScriptHostServices::definition(ProjectDefinitionKind kind, std::string id) const
{
    using ResultType = Result<ProjectDefinitionSummary, Diagnostics>;
    switch (kind) {
    case ProjectDefinitionKind::Room: {
        auto parsed = RoomId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_room(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(host_error("script_host.unknown_room",
                                                      "Room definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Scene: {
        auto parsed = SceneId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_scene(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(host_error("script_host.unknown_scene",
                                                      "Scene definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Dialogue: {
        auto parsed = DialogueId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_dialogue(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(host_error("script_host.unknown_dialogue",
                                                      "Dialogue definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Character: {
        auto parsed = CharacterId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_character(*parsed_id) : nullptr;
        return value
                   ? ResultType::success(summary(kind, *value))
                   : ResultType::failure(host_error("script_host.unknown_character",
                                                    "Character definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Interactable: {
        auto parsed = InteractableId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_interactable(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(
                           host_error("script_host.unknown_interactable",
                                      "Interactable definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Verb: {
        auto parsed = VerbId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_verb(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(host_error("script_host.unknown_verb",
                                                      "Verb definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Interaction: {
        auto parsed = InteractionId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_interaction(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(
                           host_error("script_host.unknown_interaction",
                                      "Interaction definition is missing or invalid"));
    }
    case ProjectDefinitionKind::Map: {
        auto parsed = MapId::create(std::move(id));
        const auto* parsed_id = parsed.value_if();
        const auto* value = parsed_id ? m_project.find_map(*parsed_id) : nullptr;
        return value ? ResultType::success(summary(kind, *value))
                     : ResultType::failure(host_error("script_host.unknown_map",
                                                      "Map definition is missing or invalid"));
    }
    }
    return ResultType::failure(
        host_error("script_host.invalid_definition_kind", "Definition kind is invalid"));
}

Result<RuntimeValue, Diagnostics> ScriptHostServices::variable(const VariableId& id) const
{
    return m_state.variable(m_project, id);
}

Result<void, Diagnostics> ScriptHostServices::set_variable(const VariableId& id, RuntimeValue value)
{
    return m_state.set_variable(m_project, id, std::move(value));
}

Result<PropertyLookupResult, Diagnostics>
ScriptHostServices::property(const PropertyOwnerRef& owner, const PropertyId& property) const
{
    PropertyResolver resolver(m_project, m_state);
    return resolver.get(owner, property);
}

Result<void, Diagnostics> ScriptHostServices::set_property(PropertyOwnerRef owner,
                                                           const PropertyId& property,
                                                           RuntimeValue value)
{
    PropertyResolver resolver(m_project, m_state);
    return resolver.set(std::move(owner), property, std::move(value));
}

Result<void, Diagnostics> ScriptHostServices::unset_property(const PropertyOwnerRef& owner,
                                                             const PropertyId& property)
{
    PropertyResolver resolver(m_project, m_state);
    return resolver.unset(owner, property);
}

Result<compiled::InteractableLocation, Diagnostics>
ScriptHostServices::interactable_location(const InteractableId& interactable) const
{
    const auto* state = m_state.interactable(interactable);
    if (m_project.find_interactable(interactable) == nullptr || state == nullptr)
        return Result<compiled::InteractableLocation, Diagnostics>::failure(
            host_error("script_host.unknown_interactable",
                       "Interactable definition or live state is missing"));
    return Result<compiled::InteractableLocation, Diagnostics>::success(state->location);
}

Result<void, Diagnostics>
ScriptHostServices::request_interactable_location(InteractableId interactable,
                                                  compiled::InteractableLocation target)
{
    if (m_project.find_interactable(interactable) == nullptr)
        return Result<void, Diagnostics>::failure(
            host_error("script_host.unknown_interactable", "Interactable definition is missing"));
    if (const auto* placement = std::get_if<compiled::RoomPlacementRef>(&target)) {
        const auto* room = m_project.find_room(placement->room);
        const bool valid =
            room != nullptr &&
            std::any_of(room->placements.begin(), room->placements.end(),
                        [&interactable, placement](const compiled::RoomPlacement& item) {
                            return item.id == placement->placement_id &&
                                   item.interactable == interactable;
                        });
        if (!valid)
            return Result<void, Diagnostics>::failure(
                host_error("script_host.invalid_interactable_location",
                           "Room placement does not exist or belongs to another Interactable"));
    }
    m_requests.emplace_back(MoveInteractableRequest{std::move(interactable), std::move(target)});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::require_room_mode(std::string operation) const
{
    if (!std::holds_alternative<RoomMode>(m_state.mode()) || !m_state.flow_stack().empty())
        return Result<void, Diagnostics>::failure(host_error(
            "script_host.invalid_room_mode", std::move(operation) + " requires Room mode"));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::require_flow_mode(std::string operation) const
{
    if (!std::holds_alternative<FlowMode>(m_state.mode()) || m_state.flow_stack().empty())
        return Result<void, Diagnostics>::failure(host_error(
            "script_host.invalid_flow_mode", std::move(operation) + " requires an active frame"));
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::request_navigation(compiled::RoomExitRef exit)
{
    auto mode = require_room_mode("Navigation");
    if (!mode)
        return mode;
    const auto* active = std::get_if<RoomMode>(&m_state.mode());
    const auto* room = active == nullptr ? nullptr : m_project.find_room(active->room);
    if (room == nullptr || exit.room != active->room)
        return Result<void, Diagnostics>::failure(host_error(
            "script_host.invalid_navigation", "Navigation exit is not in the active Room"));
    const auto found = std::find_if(
        room->exits.begin(), room->exits.end(),
        [&exit](const compiled::RoomExit& candidate) { return candidate.id == exit.exit_id; });
    if (found == room->exits.end())
        return Result<void, Diagnostics>::failure(
            host_error("script_host.invalid_navigation", "Navigation exit is missing"));
    m_requests.emplace_back(NavigationRequest{std::move(exit), found->target});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::request_transient(SceneId scene)
{
    auto mode = require_room_mode("Transient Scene start");
    if (!mode)
        return mode;
    if (m_project.find_scene(scene) == nullptr)
        return Result<void, Diagnostics>::failure(
            host_error("script_host.unknown_scene", "Scene definition is missing"));
    m_requests.emplace_back(StartTransientSceneRequest{std::move(scene)});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::request_transient(DialogueId dialogue)
{
    auto mode = require_room_mode("Transient Dialogue start");
    if (!mode)
        return mode;
    if (m_project.find_dialogue(dialogue) == nullptr)
        return Result<void, Diagnostics>::failure(
            host_error("script_host.unknown_dialogue", "Dialogue definition is missing"));
    m_requests.emplace_back(StartTransientDialogueRequest{std::move(dialogue)});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::request_child(SceneId scene)
{
    auto mode = require_flow_mode("Child Scene call");
    if (!mode)
        return mode;
    if (m_project.find_scene(scene) == nullptr)
        return Result<void, Diagnostics>::failure(
            host_error("script_host.unknown_scene", "Scene definition is missing"));
    m_requests.emplace_back(CallChildSceneRequest{std::move(scene)});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
ScriptHostServices::request_child(DialogueId dialogue, std::optional<DialogueBlockId> start_block)
{
    auto mode = require_flow_mode("Child Dialogue call");
    if (!mode)
        return mode;
    const auto* definition = m_project.find_dialogue(dialogue);
    if (definition == nullptr || (start_block && !has_dialogue_block(*definition, *start_block)))
        return Result<void, Diagnostics>::failure(
            host_error("script_host.invalid_dialogue_target",
                       "Dialogue definition or requested start block is missing"));
    m_requests.emplace_back(CallChildDialogueRequest{std::move(dialogue), std::move(start_block)});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::request_tail_replacement(FlowTarget target)
{
    auto mode = require_flow_mode("Tail replacement");
    if (!mode)
        return mode;
    const bool valid = std::visit(
        [this](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneId>)
                return m_project.find_scene(value) != nullptr;
            else if constexpr (std::is_same_v<T, DialogueId>)
                return m_project.find_dialogue(value) != nullptr;
            else if constexpr (std::is_same_v<T, RoomId>)
                return m_project.find_room(value) != nullptr;
            else
                return true;
        },
        target);
    if (!valid)
        return Result<void, Diagnostics>::failure(
            host_error("script_host.invalid_flow_target", "Flow target definition is missing"));
    m_requests.emplace_back(TailReplaceFlowRequest{std::move(target)});
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> ScriptHostServices::request_notification(std::string message)
{
    if (message.empty())
        return Result<void, Diagnostics>::failure(
            host_error("script_host.invalid_notification", "Notification cannot be empty"));
    m_requests.emplace_back(NotificationRequest{std::move(message)});
    return Result<void, Diagnostics>::success();
}

void ScriptHostServices::request_autosave_safe_point(SceneId scene, SceneStepId step)
{
    m_requests.emplace_back(AutosaveSafePointRequest{std::move(scene), std::move(step)});
}

void ScriptHostServices::request_autosave_safe_point(DialogueId dialogue, DialogueSegmentId segment)
{
    m_requests.emplace_back(
        DialogueLineAutosaveSafePointRequest{std::move(dialogue), std::move(segment)});
}

void ScriptHostServices::request_autosave_safe_point(DialogueId dialogue, DialogueEdgeId edge)
{
    m_requests.emplace_back(
        DialogueChoiceAutosaveSafePointRequest{std::move(dialogue), std::move(edge)});
}

std::vector<ScriptHostRequest> ScriptHostServices::take_requests() noexcept
{
    std::vector<ScriptHostRequest> result;
    result.swap(m_requests);
    return result;
}

std::vector<ScriptHostRequest> ScriptHostServices::take_external_requests() noexcept
{
    const auto is_autosave = [](const ScriptHostRequest& request) {
        return std::holds_alternative<AutosaveSafePointRequest>(request) ||
               std::holds_alternative<DialogueLineAutosaveSafePointRequest>(request) ||
               std::holds_alternative<DialogueChoiceAutosaveSafePointRequest>(request);
    };
    std::vector<ScriptHostRequest> result;
    for (auto it = m_requests.begin(); it != m_requests.end();) {
        if (is_autosave(*it)) {
            ++it;
            continue;
        }
        result.push_back(std::move(*it));
        it = m_requests.erase(it);
    }
    return result;
}

std::size_t ScriptHostServices::autosave_safe_point_count() const noexcept
{
    return static_cast<std::size_t>(
        std::count_if(m_requests.begin(), m_requests.end(), [](const ScriptHostRequest& request) {
            return std::holds_alternative<AutosaveSafePointRequest>(request) ||
                   std::holds_alternative<DialogueLineAutosaveSafePointRequest>(request) ||
                   std::holds_alternative<DialogueChoiceAutosaveSafePointRequest>(request);
        }));
}

std::size_t ScriptHostServices::in_flight_external_request_count() const noexcept
{
    return m_requests.size() - autosave_safe_point_count();
}

std::size_t ScriptHostServices::consume_autosave_safe_points() noexcept
{
    const auto is_autosave = [](const ScriptHostRequest& request) {
        return std::holds_alternative<AutosaveSafePointRequest>(request) ||
               std::holds_alternative<DialogueLineAutosaveSafePointRequest>(request) ||
               std::holds_alternative<DialogueChoiceAutosaveSafePointRequest>(request);
    };
    const auto before = m_requests.size();
    m_requests.erase(std::remove_if(m_requests.begin(), m_requests.end(), is_autosave),
                     m_requests.end());
    return before - m_requests.size();
}

} // namespace noveltea::core
