#include "ui/rmlui/runtime_ui_action_gateway.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

#include <sol/sol.hpp>

namespace noveltea::ui::rmlui {
namespace {

void append_command_builder_lua_error(core::Diagnostics& diagnostics, std::string code,
                                      std::string message)
{
    diagnostics.push_back(core::Diagnostic{.code = std::move(code), .message = std::move(message)});
}

template<class Id>
std::optional<Id> command_builder_lua_id(const sol::object& value, core::Diagnostics& diagnostics,
                                         std::string_view field)
{
    if (!value.is<std::string>()) {
        append_command_builder_lua_error(diagnostics, "runtime_ui.invalid_command_builder_subject",
                                         "Command Builder subject field '" + std::string(field) +
                                             "' must be a string");
        return std::nullopt;
    }
    auto parsed = Id::create(value.as<std::string>());
    if (!parsed) {
        append_command_builder_lua_error(diagnostics, "runtime_ui.invalid_command_builder_subject",
                                         "Command Builder subject field '" + std::string(field) +
                                             "' is invalid");
        return std::nullopt;
    }
    return std::move(*parsed.value_if());
}

std::optional<core::compiled::InteractionSubject>
command_builder_lua_subject(const sol::object& value, core::Diagnostics& diagnostics)
{
    if (!value.is<sol::table>()) {
        append_command_builder_lua_error(diagnostics, "runtime_ui.invalid_command_builder_subject",
                                         "Command Builder subjects must be tables");
        return std::nullopt;
    }
    const auto subject = value.as<sol::table>();
    const sol::object kind_value = subject["kind"];
    if (!kind_value.is<std::string>()) {
        append_command_builder_lua_error(diagnostics, "runtime_ui.invalid_command_builder_subject",
                                         "Command Builder subjects require a string kind");
        return std::nullopt;
    }
    const auto kind = kind_value.as<std::string>();
    if (kind == "character") {
        auto id = command_builder_lua_id<core::CharacterId>(subject["id"], diagnostics, "id");
        if (!id)
            return std::nullopt;
        return core::compiled::CharacterInteractionSubject{std::move(*id)};
    }
    if (kind == "interactable") {
        auto id =
            command_builder_lua_id<core::InteractableInstanceId>(subject["id"], diagnostics, "id");
        if (!id)
            return std::nullopt;
        return core::compiled::InteractableInteractionSubject{std::move(*id)};
    }
    if (kind == "feature") {
        const sol::object id_value = subject["id"];
        if (!id_value.is<std::string>()) {
            append_command_builder_lua_error(
                diagnostics, "runtime_ui.invalid_command_builder_subject",
                "Command Builder Feature subjects require the owner-qualified projected id");
            return std::nullopt;
        }
        const auto id = id_value.as<std::string>();
        const auto separator = id.find('#');
        if (separator == std::string::npos) {
            append_command_builder_lua_error(
                diagnostics, "runtime_ui.invalid_command_builder_subject",
                "Command Builder Feature id must be room:<owner>#<feature> or "
                "interactable:<owner>#<feature>");
            return std::nullopt;
        }
        auto feature = core::FeatureId::create(id.substr(separator + 1));
        if (!feature) {
            append_command_builder_lua_error(
                diagnostics, "runtime_ui.invalid_command_builder_subject",
                "Command Builder Feature id has an invalid feature id");
            return std::nullopt;
        }
        constexpr std::string_view room_prefix = "room:";
        constexpr std::string_view interactable_prefix = "interactable:";
        if (id.starts_with(room_prefix)) {
            auto owner =
                core::RoomId::create(id.substr(room_prefix.size(), separator - room_prefix.size()));
            if (!owner) {
                append_command_builder_lua_error(
                    diagnostics, "runtime_ui.invalid_command_builder_subject",
                    "Command Builder Feature id has an invalid Room owner");
                return std::nullopt;
            }
            return core::compiled::FeatureInteractionSubject{
                core::RoomFeatureRef{std::move(*owner.value_if()), std::move(*feature.value_if())}};
        }
        if (id.starts_with(interactable_prefix)) {
            auto owner = core::InteractableInstanceId::create(
                id.substr(interactable_prefix.size(), separator - interactable_prefix.size()));
            if (!owner) {
                append_command_builder_lua_error(
                    diagnostics, "runtime_ui.invalid_command_builder_subject",
                    "Command Builder Feature id has an invalid Interactable owner");
                return std::nullopt;
            }
            return core::compiled::FeatureInteractionSubject{core::InteractableFeatureRef{
                std::move(*owner.value_if()), std::move(*feature.value_if())}};
        }
        append_command_builder_lua_error(
            diagnostics, "runtime_ui.invalid_command_builder_subject",
            "Command Builder Feature id must be room:<owner>#<feature> or "
            "interactable:<owner>#<feature>");
        return std::nullopt;
    }
    append_command_builder_lua_error(
        diagnostics, "runtime_ui.invalid_command_builder_subject",
        "Command Builder subject kind must be character, interactable, or feature");
    return std::nullopt;
}

std::optional<std::vector<core::compiled::InteractionSubject>>
command_builder_lua_subjects(const sol::table& values, core::Diagnostics& diagnostics)
{
    std::vector<core::compiled::InteractionSubject> subjects;
    subjects.reserve(values.size());
    for (std::size_t index = 1; index <= values.size(); ++index) {
        auto subject = command_builder_lua_subject(values[index], diagnostics);
        if (!subject)
            return std::nullopt;
        subjects.push_back(std::move(*subject));
    }
    return subjects;
}

std::optional<std::vector<core::InteractionSubjectBinding>>
command_builder_lua_bindings(const sol::table& values, core::Diagnostics& diagnostics)
{
    std::vector<core::InteractionSubjectBinding> bindings;
    bindings.reserve(values.size());
    for (std::size_t index = 1; index <= values.size(); ++index) {
        const sol::object value = values[index];
        if (!value.is<sol::table>()) {
            append_command_builder_lua_error(diagnostics,
                                             "runtime_ui.invalid_command_builder_binding",
                                             "Command Builder bindings must be tables");
            return std::nullopt;
        }
        const auto binding = value.as<sol::table>();
        const sol::object slot_value = binding["slotId"];
        if (!slot_value.is<std::string>()) {
            append_command_builder_lua_error(diagnostics,
                                             "runtime_ui.invalid_command_builder_binding",
                                             "Command Builder bindings require a string slotId");
            return std::nullopt;
        }
        auto slot = core::VerbSlotId::create(slot_value.as<std::string>());
        if (!slot) {
            append_command_builder_lua_error(diagnostics,
                                             "runtime_ui.invalid_command_builder_binding",
                                             "Command Builder binding slotId is invalid");
            return std::nullopt;
        }
        auto subject = command_builder_lua_subject(binding["subject"], diagnostics);
        if (!subject)
            return std::nullopt;
        bindings.push_back({std::move(*slot.value_if()), std::move(*subject)});
    }
    return bindings;
}

} // namespace

RuntimeUiActionGateway::RuntimeUiActionGateway(core::Diagnostics& diagnostics)
    : m_diagnostics(diagnostics)
{
}

RuntimeUiActionGateway::~RuntimeUiActionGateway() { remove_lua_api(); }

void RuntimeUiActionGateway::set_lua_state(lua_State* state) noexcept
{
    if (m_lua_state == state)
        return;
    remove_lua_api();
    m_lua_state = state;
    if (m_input_sink)
        install_lua_api();
}

void RuntimeUiActionGateway::bind_input_sink(RuntimeUiInputSink* sink) noexcept
{
    m_input_sink = sink;
    if (!sink) {
        m_event_capture_active = false;
        m_captured_runtime_inputs.clear();
        m_captured_shell_commands.clear();
    }
    if (sink)
        install_lua_api();
    else
        remove_lua_api();
}

void RuntimeUiActionGateway::bind_layout_gameplay_admission(std::function<bool()> admission)
{
    m_layout_gameplay_admission = std::move(admission);
}

bool RuntimeUiActionGateway::apply(const RuntimeUiGameplayValues& values)
{
    if (!can_apply(values)) {
        m_diagnostics.push_back(core::Diagnostic{
            .code = "runtime_ui.stale_gameplay_values",
            .message = "Gameplay UI revision " + std::to_string(values.revision) +
                       " is older than applied revision " + std::to_string(revision())});
        return false;
    }
    commit(values);
    sync_command_builder_watches();
    return true;
}

bool RuntimeUiActionGateway::can_apply(const RuntimeUiGameplayValues& values) const noexcept
{
    return values.revision != 0 && revision() <= values.revision;
}

void RuntimeUiActionGateway::commit(RuntimeUiGameplayValues values) noexcept
{
    if (m_command_builder_draft) {
        const auto& builder = values.view.command_builder;
        if (!builder.active || !builder.occurrence) {
            m_command_builder_draft.reset();
            m_command_builder_watch_dirty = false;
        } else if (!m_command_builder_draft->occurrence) {
            m_command_builder_draft->occurrence = builder.occurrence;
        } else if (m_command_builder_draft->occurrence != builder.occurrence) {
            m_command_builder_draft.reset();
            m_command_builder_watch_dirty = false;
        }
        if (m_command_builder_draft && m_command_builder_draft->occurrence == builder.occurrence &&
            builder.capture_revision > m_command_builder_draft->last_capture_revision) {
            m_command_builder_draft->last_capture_revision = builder.capture_revision;
            if (builder.captured_subject) {
                const auto next = std::find_if(
                    m_command_builder_draft->binding_order.begin(),
                    m_command_builder_draft->binding_order.end(), [&](const auto& slot) {
                        return std::none_of(
                            m_command_builder_draft->bindings.begin(),
                            m_command_builder_draft->bindings.end(),
                            [&](const auto& binding) { return binding.slot_id == slot; });
                    });
                if (next != m_command_builder_draft->binding_order.end()) {
                    m_command_builder_draft->bindings.push_back({*next, *builder.captured_subject});
                    m_command_builder_watch_dirty = true;
                }
            }
        }
    }
    m_values = std::move(values);
}

void RuntimeUiActionGateway::clear_gameplay_values()
{
    m_values.reset();
    m_command_builder_draft.reset();
    m_command_builder_watch_dirty = false;
}

void RuntimeUiActionGateway::sync_command_builder_watches()
{
    if (!m_command_builder_watch_dirty || !m_command_builder_draft ||
        !m_command_builder_draft->occurrence)
        return;
    m_command_builder_watch_dirty = false;
    std::vector<core::compiled::InteractionSubject> watched;
    watched.reserve(m_command_builder_draft->bindings.size());
    for (const auto& binding : m_command_builder_draft->bindings) {
        if (std::find(watched.begin(), watched.end(), binding.subject) == watched.end())
            watched.push_back(binding.subject);
    }
    if (!dispatch_layout_input(core::RuntimeInputMessage{core::UpdateCommandBuilderWatchInput{
            *m_command_builder_draft->occurrence, std::move(watched)}}))
        m_command_builder_watch_dirty = true;
}

void RuntimeUiActionGateway::set_shell_slots(
    const std::vector<core::RuntimeShellSaveSlotView>& slots)
{
    m_shell_slots.clear();
    m_shell_slots.reserve(slots.size());
    for (const auto& slot : slots)
        m_shell_slots.push_back({slot.slot, slot.occupied});
}

void RuntimeUiActionGateway::clear_shell_slots() noexcept { m_shell_slots.clear(); }

const core::TypedRuntimeUIViewState* RuntimeUiActionGateway::view() const noexcept
{
    return m_values ? &m_values->view : nullptr;
}

std::uint64_t RuntimeUiActionGateway::revision() const noexcept
{
    return m_values ? m_values->revision : 0;
}

bool RuntimeUiActionGateway::dispatch_input(const core::RuntimeInputMessage& input)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Typed runtime UI input requires a bound input sink"});
        return false;
    }
    if (m_event_capture_active) {
        m_captured_runtime_inputs.push_back(input);
        return true;
    }
    return m_input_sink->submit_gameplay_input(input);
}

bool RuntimeUiActionGateway::dispatch_layout_input(const core::RuntimeInputMessage& input)
{
    if (m_layout_gameplay_admission && !m_layout_gameplay_admission())
        return invalid("runtime_ui.layout_input_blocked",
                       "Gameplay input from RuntimeUI is blocked by the active Layout policy");
    return dispatch_input(input);
}

bool RuntimeUiActionGateway::dispatch_shell_command(const core::RuntimeShellCommand& command)
{
    if (!m_input_sink) {
        m_diagnostics.push_back(
            core::Diagnostic{.code = "runtime_ui.input_sink_unavailable",
                             .message = "Runtime shell command requires a bound input sink"});
        return false;
    }
    if (m_event_capture_active) {
        m_captured_shell_commands.push_back(command);
        return true;
    }
    return m_input_sink->submit_shell_command(command);
}

bool RuntimeUiActionGateway::dispatch_layout_event(core::MountedLayoutOwner owner,
                                                   const std::function<bool()>& dispatch)
{
    return m_input_sink ? m_input_sink->dispatch_layout_event(owner, dispatch)
                        : dispatch && dispatch();
}

void RuntimeUiActionGateway::begin_event_capture() noexcept
{
    m_event_capture_active = true;
    m_captured_runtime_inputs.clear();
    m_captured_shell_commands.clear();
}

RuntimeUiEventResult RuntimeUiActionGateway::finish_event_capture() noexcept
{
    RuntimeUiEventResult result;
    result.runtime_inputs = std::move(m_captured_runtime_inputs);
    result.shell_commands = std::move(m_captured_shell_commands);
    m_captured_runtime_inputs.clear();
    m_captured_shell_commands.clear();
    m_event_capture_active = false;
    return result;
}

bool RuntimeUiActionGateway::invalid(std::string code, std::string message)
{
    m_diagnostics.push_back(
        core::Diagnostic{.code = std::move(code), .message = std::move(message)});
    return false;
}

bool RuntimeUiActionGateway::require_view()
{
    return view() != nullptr ||
           invalid("runtime_ui.view_unavailable", "Typed runtime view is unavailable");
}

const RuntimeUiActionGateway::ShellSlotState*
RuntimeUiActionGateway::shell_slot(core::TypedSaveSlotId slot) const noexcept
{
    const auto found =
        std::find_if(m_shell_slots.begin(), m_shell_slots.end(),
                     [slot](const ShellSlotState& state) { return state.slot == slot; });
    return found == m_shell_slots.end() ? nullptr : &*found;
}

bool RuntimeUiActionGateway::action_continue()
{
    if (!require_view())
        return false;
    if (!view()->can_continue)
        return invalid("runtime_ui.continue_unavailable", "Continue is not currently enabled");
    return dispatch_layout_input(core::RuntimeInputMessage{core::ContinueInput{}});
}

bool RuntimeUiActionGateway::action_choose(std::string kind, std::string text)
{
    if (!require_view())
        return false;
    if (kind == "scene") {
        auto id = core::SceneChoiceOptionId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto* choice =
            view()->scene && view()->scene->choice ? &*view()->scene->choice : nullptr;
        const bool enabled =
            choice &&
            std::any_of(choice->options.begin(), choice->options.end(), [&](const auto& option) {
                return option.option == *id.value_if() && option.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_scene_choice",
                           "Scene choice is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::SelectSceneChoiceInput{*id.value_if()}});
    }
    if (kind == "dialogue") {
        auto id = core::DialogueEdgeId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return false;
        }
        const auto* choice =
            view()->dialogue && view()->dialogue->choice ? &*view()->dialogue->choice : nullptr;
        const bool enabled =
            choice &&
            std::any_of(choice->options.begin(), choice->options.end(), [&](const auto& option) {
                return option.edge == *id.value_if() && option.enabled;
            });
        if (!enabled)
            return invalid("runtime_ui.invalid_dialogue_choice",
                           "Dialogue choice is stale, unknown, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::SelectDialogueChoiceInput{*id.value_if()}});
    }
    return invalid("runtime_ui.invalid_choice_kind", "Choice kind must be scene or dialogue");
}

bool RuntimeUiActionGateway::action_navigate_room(std::string text)
{
    if (!require_view())
        return false;
    auto id = core::RoomExitId::create(std::move(text));
    if (!id) {
        core::append_diagnostics(m_diagnostics, id.error());
        return false;
    }
    const auto* room = view()->room ? &*view()->room : nullptr;
    const bool enabled =
        room && std::any_of(room->exits.begin(), room->exits.end(), [&](const auto& exit) {
            return exit.exit == *id.value_if() && exit.enabled;
        });
    if (!enabled)
        return invalid("runtime_ui.invalid_room_exit", "Room exit is stale, unknown, or disabled");
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::NavigateRoomInput{*id.value_if()}});
}

std::optional<core::compiled::InteractionSubject>
RuntimeUiActionGateway::resolve_subject(std::string kind, std::string text)
{
    if (!require_view())
        return std::nullopt;
    std::optional<core::compiled::InteractionSubject> subject;
    if (kind == "interactable") {
        auto id = core::InteractableInstanceId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return std::nullopt;
        }
        subject = core::compiled::InteractableInteractionSubject{*id.value_if()};
        const auto available_in_room =
            view()->room &&
            std::any_of(view()->room->placements.begin(), view()->room->placements.end(),
                        [&](const auto& placement) {
                            return std::any_of(placement.occupants.begin(),
                                               placement.occupants.end(),
                                               [&](const auto& occupant) {
                                                   return occupant.subject == *subject &&
                                                          occupant.visible && occupant.enabled;
                                               });
                        });
        const auto available_in_inventory = std::any_of(
            view()->inventory.items.begin(), view()->inventory.items.end(), [&](const auto& item) {
                return item.interactable == *id.value_if() && item.visible && item.enabled;
            });
        if (!available_in_room && !available_in_inventory) {
            (void)invalid("runtime_ui.invalid_interactable",
                          "Interactable is stale, unknown, hidden, or disabled");
            return std::nullopt;
        }
    } else if (kind == "character") {
        auto id = core::CharacterId::create(std::move(text));
        if (!id) {
            core::append_diagnostics(m_diagnostics, id.error());
            return std::nullopt;
        }
        subject = core::compiled::CharacterInteractionSubject{*id.value_if()};
        const bool available =
            view()->room &&
            std::any_of(view()->room->placements.begin(), view()->room->placements.end(),
                        [&](const auto& placement) {
                            return std::any_of(placement.occupants.begin(),
                                               placement.occupants.end(),
                                               [&](const auto& occupant) {
                                                   return occupant.subject == *subject &&
                                                          occupant.visible && occupant.enabled;
                                               });
                        });
        if (!available) {
            (void)invalid("runtime_ui.invalid_character",
                          "Character is stale, unknown, hidden, or disabled");
            return std::nullopt;
        }
    } else {
        (void)invalid("runtime_ui.invalid_subject_kind",
                      "Interaction subject kind must be character or interactable");
        return std::nullopt;
    }
    return subject;
}

bool RuntimeUiActionGateway::action_toggle_subject(std::string kind, std::string text)
{
    if (view() && view()->command_builder.active && view()->command_builder.occurrence)
        return action_primary_activate(std::move(kind), std::move(text));
    auto subject = resolve_subject(std::move(kind), std::move(text));
    if (!subject)
        return false;
    auto selection = view()->selected_subjects;
    const auto selected = std::find(selection.begin(), selection.end(), *subject);
    if (selected == selection.end())
        selection.push_back(*subject);
    else
        selection.erase(selected);
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{std::move(selection)}});
}

bool RuntimeUiActionGateway::action_primary_activate(
    std::string kind, std::string text, std::optional<core::TriggerContext> trigger_context,
    std::optional<core::LayoutPresentationParent> presentation_parent)
{
    auto subject = resolve_subject(std::move(kind), std::move(text));
    if (!subject)
        return false;
    if (view()->command_builder.active && view()->command_builder.occurrence)
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::CommandBuilderSubjectPressInput{
                *view()->command_builder.occurrence, std::move(*subject)}});
    return dispatch_layout_input(core::RuntimeInputMessage{core::PrimaryActivateInput{
        std::move(*subject), std::move(trigger_context), std::move(presentation_parent)}});
}

bool RuntimeUiActionGateway::action_open_verb_menu(
    std::string kind, std::string text, std::optional<core::TriggerContext> trigger_context,
    std::optional<core::LayoutPresentationParent> presentation_parent)
{
    if (view() && view()->command_builder.active && view()->command_builder.occurrence)
        return action_primary_activate(std::move(kind), std::move(text));
    auto subject = resolve_subject(std::move(kind), std::move(text));
    if (!subject)
        return false;
    return dispatch_layout_input(core::RuntimeInputMessage{core::OpenVerbMenuInput{
        std::move(*subject), std::move(trigger_context), std::move(presentation_parent)}});
}

bool RuntimeUiActionGateway::action_present_player_inventory(
    std::optional<core::TriggerContext> trigger_context,
    std::optional<core::LayoutPresentationParent> presentation_parent, bool coexist)
{
    if (!require_view() || !view()->inventory.player_inventory_available ||
        !view()->inventory.player_inventory)
        return invalid("runtime_ui.player_inventory_unavailable",
                       "Player Inventory is not configured or is unavailable");
    return dispatch_layout_input(core::RuntimeInputMessage{core::PresentInventoryInput{
        *view()->inventory.player_inventory, std::nullopt, std::move(trigger_context),
        std::move(presentation_parent), coexist}});
}

bool RuntimeUiActionGateway::action_present_child_layout(
    std::string layout_text, std::optional<std::string> instance_text,
    std::optional<core::TriggerContext> trigger_context,
    core::LayoutPresentationParent presentation_parent)
{
    auto layout = core::LayoutId::create(std::move(layout_text));
    if (!layout) {
        core::append_diagnostics(m_diagnostics, layout.error());
        return false;
    }
    std::optional<core::ScopedLayoutInstanceId> instance;
    if (instance_text) {
        auto created = core::ScopedLayoutInstanceId::create(std::move(*instance_text));
        if (!created) {
            core::append_diagnostics(m_diagnostics, created.error());
            return false;
        }
        instance = *created.value_if();
    }
    return dispatch_layout_input(core::RuntimeInputMessage{core::PresentContextualLayoutInput{
        *layout.value_if(), std::move(instance), std::move(trigger_context),
        std::move(presentation_parent)}});
}

bool RuntimeUiActionGateway::action_clear_selection()
{
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::ClearInteractionSubjectSelectionInput{}});
}

bool RuntimeUiActionGateway::action_invoke_interaction(std::string text)
{
    if (!require_view())
        return false;
    auto id = core::VerbId::create(std::move(text));
    if (!id) {
        core::append_diagnostics(m_diagnostics, id.error());
        return false;
    }
    const auto* controls = view()->room ? &view()->room->controls : &view()->inventory.controls;
    const auto found = std::find_if(controls->begin(), controls->end(), [&](const auto& control) {
        return control.verb == *id.value_if();
    });
    if (found == controls->end() || !found->enabled)
        return invalid("runtime_ui.invalid_interaction",
                       "Interaction verb is stale, unknown, or disabled");
    const auto offer =
        std::find_if(view()->verb_offers.begin(), view()->verb_offers.end(),
                     [&](const auto& value) { return value.verb == *id.value_if(); });
    if (offer == view()->verb_offers.end() || view()->selected_subjects.size() != 1)
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::InvokeInteractionInput{*id.value_if(), {}}});

    const auto subject = view()->selected_subjects.front();
    if (offer->binding_order.size() == 1 && offer->slot == offer->binding_order.front())
        return dispatch_layout_input(core::RuntimeInputMessage{
            core::InvokeInteractionInput{*id.value_if(), {{offer->slot, subject}}}});

    m_command_builder_draft = CommandBuilderDraft{.verb = *id.value_if(),
                                                  .label = offer->label,
                                                  .binding_order = offer->binding_order,
                                                  .bindings = {{offer->slot, subject}},
                                                  .occurrence = std::nullopt,
                                                  .last_capture_revision = 0};
    if (!dispatch_layout_input(
            core::RuntimeInputMessage{core::BeginCommandBuilderInput{{subject}}})) {
        m_command_builder_draft.reset();
        return false;
    }
    return true;
}

bool RuntimeUiActionGateway::action_begin_command_builder(
    std::vector<core::compiled::InteractionSubject> subjects)
{
    if (!require_view())
        return false;
    return dispatch_layout_input(
        core::RuntimeInputMessage{core::BeginCommandBuilderInput{std::move(subjects)}});
}

bool RuntimeUiActionGateway::action_set_command_builder_watch(
    std::vector<core::compiled::InteractionSubject> subjects)
{
    if (!require_view() || !view()->command_builder.active || !view()->command_builder.occurrence)
        return invalid("runtime_ui.command_builder_inactive", "Command Builder is not active");
    return dispatch_layout_input(core::RuntimeInputMessage{core::UpdateCommandBuilderWatchInput{
        *view()->command_builder.occurrence, std::move(subjects)}});
}

bool RuntimeUiActionGateway::action_submit_command_builder()
{
    if (!require_view() || !m_command_builder_draft || !m_command_builder_draft->occurrence)
        return invalid("runtime_ui.command_builder_inactive", "Command Builder is not active");
    if (m_command_builder_draft->bindings.size() != m_command_builder_draft->binding_order.size())
        return invalid("runtime_ui.command_builder_incomplete",
                       "Command Builder Draft is incomplete");
    return dispatch_layout_input(core::RuntimeInputMessage{core::SubmitCommandBuilderInput{
        *m_command_builder_draft->occurrence, m_command_builder_draft->verb,
        m_command_builder_draft->bindings}});
}

bool RuntimeUiActionGateway::action_submit_command_builder(
    std::string text, std::vector<core::InteractionSubjectBinding> bindings)
{
    if (!require_view() || !view()->command_builder.active || !view()->command_builder.occurrence)
        return invalid("runtime_ui.command_builder_inactive", "Command Builder is not active");
    auto verb = core::VerbId::create(std::move(text));
    if (!verb) {
        core::append_diagnostics(m_diagnostics, verb.error());
        return false;
    }
    return dispatch_layout_input(core::RuntimeInputMessage{core::SubmitCommandBuilderInput{
        *view()->command_builder.occurrence, std::move(*verb.value_if()), std::move(bindings)}});
}

bool RuntimeUiActionGateway::action_rebind_command_builder(std::string text)
{
    if (!require_view() || !m_command_builder_draft || !m_command_builder_draft->occurrence)
        return invalid("runtime_ui.command_builder_inactive", "Command Builder is not active");
    auto slot = core::VerbSlotId::create(std::move(text));
    if (!slot) {
        core::append_diagnostics(m_diagnostics, slot.error());
        return false;
    }
    const auto binding = std::find_if(
        m_command_builder_draft->bindings.begin(), m_command_builder_draft->bindings.end(),
        [&](const auto& value) { return value.slot_id == *slot.value_if(); });
    if (binding == m_command_builder_draft->bindings.end())
        return invalid("runtime_ui.command_builder_slot_not_bound",
                       "Command Builder can rebind only a currently bound slot");

    const auto previous_bindings = m_command_builder_draft->bindings;
    m_command_builder_draft->bindings.erase(binding);
    m_command_builder_watch_dirty = true;
    sync_command_builder_watches();
    if (m_command_builder_watch_dirty) {
        m_command_builder_draft->bindings = previous_bindings;
        m_command_builder_watch_dirty = false;
        return false;
    }
    return true;
}

bool RuntimeUiActionGateway::action_cancel_command_builder()
{
    if (!require_view() || !view()->command_builder.active || !view()->command_builder.occurrence)
        return invalid("runtime_ui.command_builder_inactive", "Command Builder is not active");
    return dispatch_layout_input(core::RuntimeInputMessage{
        core::CancelCommandBuilderInput{*view()->command_builder.occurrence}});
}

RuntimeUiActionGateway::CommandBuilderDraftSnapshot
RuntimeUiActionGateway::command_builder_draft() const
{
    CommandBuilderDraftSnapshot out;
    if (!m_command_builder_draft)
        return out;
    out.active = true;
    out.verb_id = m_command_builder_draft->verb.text();
    out.label = m_command_builder_draft->label;
    out.complete =
        m_command_builder_draft->bindings.size() == m_command_builder_draft->binding_order.size();
    out.binding_order.reserve(m_command_builder_draft->binding_order.size());
    for (const auto& slot : m_command_builder_draft->binding_order)
        out.binding_order.push_back(slot.text());
    out.bound_slots.reserve(m_command_builder_draft->bindings.size());
    for (const auto& binding : m_command_builder_draft->bindings)
        out.bound_slots.push_back(binding.slot_id.text());
    const auto focused = std::find_if(
        m_command_builder_draft->binding_order.begin(),
        m_command_builder_draft->binding_order.end(), [&](const auto& slot) {
            return std::none_of(m_command_builder_draft->bindings.begin(),
                                m_command_builder_draft->bindings.end(),
                                [&](const auto& binding) { return binding.slot_id == slot; });
        });
    if (focused != m_command_builder_draft->binding_order.end())
        out.focused_slot = focused->text();
    return out;
}

bool RuntimeUiActionGateway::action_save_slot(std::uint64_t number)
{
    if (number > std::numeric_limits<std::uint32_t>::max())
        return invalid("runtime_ui.invalid_save_slot",
                       "Save slot number must be a valid manual slot");
    const auto slot = core::TypedSaveSlotId::manual(static_cast<std::uint32_t>(number));
    if (!shell_slot(slot))
        return invalid("runtime_ui.invalid_save_slot",
                       "Save slot is not exposed by the current shell state");
    return dispatch_shell_command(core::RuntimeShellCommand{core::SaveShellSlotCommand{slot}});
}

bool RuntimeUiActionGateway::action_load_slot(std::string kind, std::uint64_t number)
{
    core::TypedSaveSlotId slot = core::TypedSaveSlotId::autosave();
    if (kind == "autosave") {
        if (number != 0)
            return invalid("runtime_ui.invalid_load_slot", "Autosave slot number must be zero");
    } else if (kind == "manual") {
        if (number > std::numeric_limits<std::uint32_t>::max())
            return invalid("runtime_ui.invalid_load_slot",
                           "Load slot number must be a valid manual slot");
        slot = core::TypedSaveSlotId::manual(static_cast<std::uint32_t>(number));
    } else {
        return invalid("runtime_ui.invalid_load_slot_kind",
                       "Load slot kind must be autosave or manual");
    }

    const auto* state = shell_slot(slot);
    if (!state)
        return invalid("runtime_ui.invalid_load_slot",
                       "Load slot is not exposed by the current shell state");
    if (!state->occupied)
        return invalid("runtime_ui.invalid_load_slot", "Load slot is not occupied");
    return dispatch_shell_command(
        core::RuntimeShellCommand{core::RequestLoadShellSlotCommand{slot}});
}

void RuntimeUiActionGateway::install_lua_api()
{
    if (!m_lua_state || !m_input_sink)
        return;

    sol::state_view lua(m_lua_state);
    sol::table game;
    const sol::object existing = lua["Game"];
    if (existing.valid() && existing.get_type() == sol::type::table)
        game = existing.as<sol::table>();
    else {
        game = lua.create_table();
        lua["Game"] = game;
    }
    sol::table ui = lua.create_table();

    ui.set_function("continue", [this]() { return action_continue(); });
    ui.set_function("choose_scene",
                    [this](std::string text) { return action_choose("scene", std::move(text)); });
    ui.set_function("choose_dialogue", [this](std::string text) {
        return action_choose("dialogue", std::move(text));
    });
    ui.set_function("navigate_room",
                    [this](std::string text) { return action_navigate_room(std::move(text)); });

    auto require_view = [this]() { return this->require_view(); };
    ui.set_function("navigate_map_connection", [this, require_view](std::string map_text,
                                                                    std::string connection_text) {
        if (!require_view())
            return false;
        auto map_id = core::MapId::create(std::move(map_text));
        auto connection_id = core::MapConnectionId::create(std::move(connection_text));
        if (!map_id) {
            core::append_diagnostics(m_diagnostics, map_id.error());
            return false;
        }
        if (!connection_id) {
            core::append_diagnostics(m_diagnostics, connection_id.error());
            return false;
        }
        const auto map =
            std::find_if(view()->maps.begin(), view()->maps.end(), [&](const auto& candidate) {
                return candidate.map == *map_id.value_if();
            });
        if (map == view()->maps.end())
            return invalid("runtime_ui.invalid_map",
                           "Map is stale or unknown to this runtime view");
        const auto connection = std::find_if(
            map->connections.begin(), map->connections.end(), [&](const auto& candidate) {
                return candidate.connection == *connection_id.value_if();
            });
        if (connection == map->connections.end() || !connection->visible ||
            !connection->actionable || !connection->active_exit)
            return invalid("runtime_ui.invalid_map_connection",
                           "Map connection is stale, unknown, hidden, or disabled");
        return dispatch_layout_input(
            core::RuntimeInputMessage{core::NavigateRoomInput{connection->active_exit->exit_id}});
    });
    ui.set_function("navigate_map_location", [this, require_view](std::string map_text,
                                                                  std::string location_text) {
        if (!require_view())
            return false;
        auto map_id = core::MapId::create(std::move(map_text));
        auto location_id = core::MapLocationId::create(std::move(location_text));
        if (!map_id) {
            core::append_diagnostics(m_diagnostics, map_id.error());
            return false;
        }
        if (!location_id) {
            core::append_diagnostics(m_diagnostics, location_id.error());
            return false;
        }
        const auto map =
            std::find_if(view()->maps.begin(), view()->maps.end(), [&](const auto& candidate) {
                return candidate.map == *map_id.value_if();
            });
        if (map == view()->maps.end())
            return invalid("runtime_ui.invalid_map",
                           "Map is stale or unknown to this runtime view");
        const auto location =
            std::find_if(map->locations.begin(), map->locations.end(), [&](const auto& candidate) {
                return candidate.location == *location_id.value_if();
            });
        if (location == map->locations.end() || !location->visible || !location->actionable ||
            !location->convenience_exit)
            return false;
        return dispatch_layout_input(core::RuntimeInputMessage{
            core::NavigateRoomInput{location->convenience_exit->exit_id}});
    });
    ui.set_function("toggle_interactable", [this](std::string text) {
        return action_toggle_subject("interactable", std::move(text));
    });
    ui.set_function("toggle_character", [this](std::string text) {
        return action_toggle_subject("character", std::move(text));
    });
    ui.set_function("primary_activate", [this](std::string kind, std::string text) {
        return action_primary_activate(std::move(kind), std::move(text));
    });
    ui.set_function("open_verb_menu", [this](std::string kind, std::string text) {
        return action_open_verb_menu(std::move(kind), std::move(text));
    });
    ui.set_function("present_player_inventory",
                    [this]() { return action_present_player_inventory(); });
    ui.set_function("clear_selection", [this]() { return action_clear_selection(); });
    ui.set_function("invoke_interaction", [this](std::string text) {
        return action_invoke_interaction(std::move(text));
    });
    ui.set_function(
        "begin_command_builder",
        sol::overload([this]() { return action_begin_command_builder({}); },
                      [this](const sol::table& values) {
                          auto subjects = command_builder_lua_subjects(values, m_diagnostics);
                          return subjects && action_begin_command_builder(std::move(*subjects));
                      }));
    ui.set_function("set_command_builder_watch", [this](const sol::table& values) {
        auto subjects = command_builder_lua_subjects(values, m_diagnostics);
        return subjects && action_set_command_builder_watch(std::move(*subjects));
    });
    ui.set_function(
        "submit_command_builder",
        sol::overload([this]() { return action_submit_command_builder(); },
                      [this](std::string verb_id, const sol::table& values) {
                          auto bindings = command_builder_lua_bindings(values, m_diagnostics);
                          return bindings && action_submit_command_builder(std::move(verb_id),
                                                                           std::move(*bindings));
                      }));
    ui.set_function("rebind_command_builder", [this](std::string text) {
        return action_rebind_command_builder(std::move(text));
    });
    ui.set_function("cancel_command_builder", [this]() { return action_cancel_command_builder(); });
    game["ui"] = std::move(ui);
}

void RuntimeUiActionGateway::remove_lua_api() noexcept
{
    if (!m_lua_state)
        return;
    sol::state_view lua(m_lua_state);
    const sol::object game_object = lua["Game"];
    if (game_object.valid() && game_object.get_type() == sol::type::table)
        game_object.as<sol::table>()["ui"] = sol::lua_nil;
}

} // namespace noveltea::ui::rmlui
