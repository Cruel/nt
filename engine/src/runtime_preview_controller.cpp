#include "noveltea/runtime_preview_controller.hpp"

#include "noveltea/core/editor_runtime_protocol.hpp"
#include "noveltea/core/json_access.hpp"
#include "noveltea/engine.hpp"
#include "noveltea/preview_bridge.hpp"

#include <SDL3/SDL.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <optional>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

namespace noveltea {
namespace {

std::string typed_mutation_result(bool accepted, std::string kind, std::string id,
                                  std::string message = {})
{
    return nlohmann::json{{"accepted", accepted},
                          {"kind", std::move(kind)},
                          {"id", std::move(id)},
                          {"message", std::move(message)}}
        .dump();
}

std::optional<core::RuntimeValue> runtime_value_from_json(const nlohmann::json& value)
{
    if (value.is_boolean())
        return core::json_access::get_or<bool>(value, false);
    if (value.is_number_integer())
        return core::json_access::get_or<std::int64_t>(value, 0);
    if (value.is_number_float()) {
        const auto number = core::json_access::get_or<double>(value, 0.0);
        return std::isfinite(number) ? std::optional<core::RuntimeValue>(number) : std::nullopt;
    }
    if (value.is_string())
        return core::json_access::get_or<std::string>(value, {});
    if (value.is_null())
        return std::monostate{};
    return std::nullopt;
}

nlohmann::json preview_entity_ref(std::string type, std::string id, std::string collection = {})
{
    nlohmann::json result = {{"type", std::move(type)}, {"id", std::move(id)}};
    if (!collection.empty())
        result["collection"] = std::move(collection);
    return result;
}

std::string preview_diagnostic_severity(core::ErrorSeverity severity)
{
    switch (severity) {
    case core::ErrorSeverity::Info:
        return "info";
    case core::ErrorSeverity::Warning:
        return "warning";
    case core::ErrorSeverity::Error:
    case core::ErrorSeverity::Fatal:
        return "error";
    }
    return "error";
}

nlohmann::json encode_preview_debug_snapshot(const core::TypedRuntimeUIViewState& view,
                                             const core::Diagnostics& diagnostics,
                                             bool preview_running)
{
    nlohmann::json dialogue_options = nlohmann::json::array();
    if (view.dialogue && view.dialogue->choice) {
        for (std::size_t index = 0; index < view.dialogue->choice->options.size(); ++index) {
            const auto& option = view.dialogue->choice->options[index];
            dialogue_options.push_back({{"index", static_cast<int>(index)},
                                        {"label", option.label},
                                        {"enabled", option.enabled}});
        }
    } else if (view.scene && view.scene->choice) {
        for (std::size_t index = 0; index < view.scene->choice->options.size(); ++index) {
            const auto& option = view.scene->choice->options[index];
            dialogue_options.push_back({{"index", static_cast<int>(index)},
                                        {"label", option.label},
                                        {"enabled", option.enabled}});
        }
    }

    nlohmann::json navigation = nlohmann::json::array();
    if (view.room) {
        for (const auto& exit : view.room->exits) {
            navigation.push_back({{"index", static_cast<int>(exit.direction)},
                                  {"label", exit.label},
                                  {"enabled", exit.enabled}});
        }
    }

    nlohmann::json actions = nlohmann::json::array();
    const auto& controls = view.room ? view.room->controls : view.inventory.controls;
    for (const auto& control : controls) {
        actions.push_back({{"verbId", control.verb.text()},
                           {"label", control.label},
                           {"objectCount", static_cast<int>(control.arity)},
                           {"selectedCount", static_cast<int>(view.selected_interactables.size())},
                           {"enabled", control.enabled}});
    }

    nlohmann::json selected_objects = nlohmann::json::array();
    for (const auto& id : view.selected_interactables)
        selected_objects.push_back(id.text());

    nlohmann::json inventory = nlohmann::json::array();
    for (const auto& item : view.inventory.items) {
        inventory.push_back(
            {{"id", item.interactable.text()},
             {"label", item.display_name},
             {"selected",
              std::find(view.selected_interactables.begin(), view.selected_interactables.end(),
                        item.interactable) != view.selected_interactables.end()},
             {"enabled", item.enabled}});
    }

    nlohmann::json diagnostic_list = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics) {
        nlohmann::json encoded = {{"severity", preview_diagnostic_severity(diagnostic.severity)},
                                  {"message", diagnostic.message},
                                  {"category", diagnostic.code}};
        if (!diagnostic.source_path.empty())
            encoded["path"] = diagnostic.source_path;
        diagnostic_list.push_back(std::move(encoded));
    }

    std::string waiting_kind = "none";
    std::string waiting_reason;
    if (!dialogue_options.empty()) {
        waiting_kind = "choice";
        waiting_reason = "runtime choices are available";
    } else if (!navigation.empty()) {
        waiting_kind = "navigation";
        waiting_reason = "room navigation is available";
    } else if (!actions.empty()) {
        waiting_kind = "action";
        waiting_reason = "runtime actions are available";
    } else if (view.can_continue) {
        waiting_kind = "continue";
        waiting_reason = "runtime is waiting for continue";
    } else if (view.mode == "title") {
        waiting_kind = "title";
        waiting_reason = "title UI is active";
    } else if (view.mode == "ended") {
        waiting_kind = "paused";
        waiting_reason = "runtime has ended";
    }

    nlohmann::json waiting = {{"kind", waiting_kind}, {"canContinue", view.can_continue}};
    if (!waiting_reason.empty())
        waiting["reason"] = std::move(waiting_reason);

    nlohmann::json snapshot = {
        {"loaded", true},
        {"running", preview_running},
        {"shellMode", view.mode},
        {"runtimeMode", view.mode},
        {"gameplayPaused", view.gameplay_paused},
        {"waiting", std::move(waiting)},
        {"availableInputs",
         {{"continue", view.can_continue},
          {"dialogueOptions", std::move(dialogue_options)},
          {"navigation", std::move(navigation)},
          {"actions", std::move(actions)},
          {"selectedObjects", selected_objects},
          {"clickableTargets", nlohmann::json::array()}}},
        {"variables", nlohmann::json::array()},
        {"inventory", std::move(inventory)},
        {"selectedObjects", std::move(selected_objects)},
        {"diagnostics", std::move(diagnostic_list)},
        {"saveSnapshot", nlohmann::json::object()},
        {"controllerState", nlohmann::json::object()},
    };

    if (view.room) {
        snapshot["currentRoomId"] = view.room->room.text();
        snapshot["currentEntity"] = preview_entity_ref("room", view.room->room.text(), "rooms");
    } else if (view.dialogue) {
        snapshot["currentDialogueId"] = view.dialogue->dialogue.text();
        snapshot["currentEntity"] =
            preview_entity_ref("dialogue", view.dialogue->dialogue.text(), "dialogues");
    } else if (view.scene) {
        snapshot["currentEntity"] = preview_entity_ref("scene", view.scene->scene.text(), "scenes");
    }

    return snapshot;
}

} // namespace

RuntimePreviewController::RuntimePreviewController(Engine& engine) noexcept : m_engine(engine) {}

bool RuntimePreviewController::load_project(const std::string& logical_path)
{
    return m_engine.load_compiled_project(logical_path);
}

bool RuntimePreviewController::reset()
{
    if (m_engine.m_compiled_project_path.empty()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot reset without a loaded compiled project");
        return false;
    }
    return m_engine.load_compiled_project(m_engine.m_compiled_project_path);
}

bool RuntimePreviewController::start()
{
    if (!m_engine.m_compiled_runtime)
        return false;
    m_engine.m_preview_running = true;
    const bool handled = m_engine.m_runtime_ui.dispatch_typed_runtime_input(
        core::RuntimeInputMessage{core::StartRuntimeInput{}});
    preview_bridge::emit_state_changed(m_engine.m_demo_position, m_engine.m_preview_running);
    return handled;
}

bool RuntimePreviewController::stop()
{
    if (!m_engine.m_compiled_runtime)
        return false;
    m_engine.m_preview_running = false;
    const bool handled = m_engine.m_runtime_ui.dispatch_typed_runtime_input(
        core::RuntimeInputMessage{core::StopRuntimeInput{}});
    preview_bridge::emit_state_changed(m_engine.m_demo_position, m_engine.m_preview_running);
    return handled;
}

bool RuntimePreviewController::step(double delta_seconds)
{
    if (!m_engine.m_compiled_runtime)
        return false;
    return m_engine.m_runtime_ui.dispatch_typed_runtime_input(core::RuntimeInputMessage{
        core::AdvanceTimeInput{std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::duration<double>(std::max(0.0, delta_seconds)))}});
}

bool RuntimePreviewController::continue_dialogue()
{
    return m_engine.m_compiled_runtime && m_engine.m_runtime_ui.dispatch_typed_runtime_input(
                                              core::RuntimeInputMessage{core::ContinueInput{}});
}

bool RuntimePreviewController::select_dialogue_option(int option_index)
{
    const auto* view = m_engine.m_runtime_ui.typed_runtime_view_state();
    if (!view || !view->dialogue || !view->dialogue->choice || option_index < 0 ||
        static_cast<std::size_t>(option_index) >= view->dialogue->choice->options.size())
        return false;
    return m_engine.m_runtime_ui.dispatch_typed_runtime_input(
        core::RuntimeInputMessage{core::SelectDialogueChoiceInput{
            view->dialogue->choice->options[static_cast<std::size_t>(option_index)].edge}});
}

bool RuntimePreviewController::navigate(int direction)
{
    const auto* view = m_engine.m_runtime_ui.typed_runtime_view_state();
    if (!view || !view->room)
        return false;
    const auto exit = std::find_if(
        view->room->exits.begin(), view->room->exits.end(), [&](const auto& candidate) {
            return candidate.enabled && static_cast<int>(candidate.direction) == direction;
        });
    return exit != view->room->exits.end() &&
           m_engine.m_runtime_ui.dispatch_typed_runtime_input(
               core::RuntimeInputMessage{core::NavigateRoomInput{exit->exit}});
}

bool RuntimePreviewController::select_object(const std::string& object_id)
{
    auto id = core::InteractableId::create(object_id);
    return id && m_engine.m_runtime_ui.dispatch_typed_runtime_input(
                     core::RuntimeInputMessage{core::SelectInteractablesInput{{*id.value_if()}}});
}

bool RuntimePreviewController::clear_object_selection()
{
    return m_engine.m_compiled_runtime &&
           m_engine.m_runtime_ui.dispatch_typed_runtime_input(
               core::RuntimeInputMessage{core::ClearInteractableSelectionInput{}});
}

bool RuntimePreviewController::run_action(const std::string& verb_id,
                                          const std::vector<std::string>& object_ids)
{
    auto verb = core::VerbId::create(verb_id);
    if (!verb)
        return false;
    std::vector<core::InteractableId> operands;
    for (const auto& text : object_ids) {
        auto id = core::InteractableId::create(text);
        if (!id)
            return false;
        operands.push_back(std::move(*id.value_if()));
    }
    return m_engine.m_runtime_ui.dispatch_typed_runtime_input(core::RuntimeInputMessage{
        core::InvokeInteractionInput{std::move(*verb.value_if()), std::move(operands)}});
}

std::string RuntimePreviewController::set_variable(const std::string& variable_id,
                                                   const std::string& value_json)
{
    auto id = core::VariableId::create(variable_id);
    auto json = nlohmann::json::parse(value_json, nullptr, false);
    auto value = json.is_discarded() ? std::nullopt : runtime_value_from_json(json);
    if (!id || !value)
        return typed_mutation_result(false, "set-variable", variable_id, "invalid value");
    const bool accepted =
        m_engine.m_runtime_ui.dispatch_typed_runtime_input(core::RuntimeInputMessage{
            core::SetVariableDebugInput{std::move(*id.value_if()), std::move(*value)}});
    return typed_mutation_result(accepted, "set-variable", variable_id);
}

std::string RuntimePreviewController::reset_variable(const std::string& variable_id)
{
    auto id = core::VariableId::create(variable_id);
    if (!id || !m_engine.m_compiled_runtime)
        return typed_mutation_result(false, "reset-variable", variable_id, "invalid id");
    const auto* definition =
        m_engine.m_compiled_runtime->package().project().find_variable(*id.value_if());
    if (!definition)
        return typed_mutation_result(false, "reset-variable", variable_id, "unknown variable");
    const bool accepted =
        m_engine.m_runtime_ui.dispatch_typed_runtime_input(core::RuntimeInputMessage{
            core::SetVariableDebugInput{*id.value_if(), definition->default_value}});
    return typed_mutation_result(accepted, "reset-variable", variable_id);
}

std::string RuntimePreviewController::give_object(const std::string& object_id)
{
    auto id = core::InteractableId::create(object_id);
    if (!id || !m_engine.m_compiled_runtime)
        return typed_mutation_result(false, "give-object", object_id, "invalid id");
    auto result = m_engine.m_compiled_runtime->session().gateway().request_interactable_location(
        *id.value_if(), core::compiled::InventoryLocation{});
    return typed_mutation_result(static_cast<bool>(result), "give-object", object_id,
                                 result ? "" : result.error().front().message);
}

std::string RuntimePreviewController::remove_inventory_object(const std::string& object_id)
{
    auto id = core::InteractableId::create(object_id);
    if (!id || !m_engine.m_compiled_runtime)
        return typed_mutation_result(false, "remove-object", object_id, "invalid id");
    auto result = m_engine.m_compiled_runtime->session().gateway().request_interactable_location(
        *id.value_if(), core::compiled::NowhereLocation{});
    return typed_mutation_result(static_cast<bool>(result), "remove-object", object_id,
                                 result ? "" : result.error().front().message);
}

std::string RuntimePreviewController::teleport_room(const std::string& room_id)
{
    auto id = core::RoomId::create(room_id);
    if (!id || !m_engine.m_compiled_runtime)
        return typed_mutation_result(false, "teleport-room", room_id, "invalid id");
    auto result = m_engine.m_compiled_runtime->session().gateway().request_tail_replacement(
        core::FlowTarget{*id.value_if()});
    if (result)
        (void)m_engine.m_runtime_ui.dispatch_typed_runtime_input(
            core::RuntimeInputMessage{core::AdvanceTimeInput{}});
    return typed_mutation_result(static_cast<bool>(result), "teleport-room", room_id,
                                 result ? "" : result.error().front().message);
}

std::string RuntimePreviewController::fast_forward_to_input()
{
    constexpr int max_steps = 800;
    constexpr double tick_seconds = 1.0 / 60.0;
    int applied = 0;
    std::string reason = "stabilization-limit";
    for (; applied < max_steps; ++applied) {
        const auto* view = m_engine.m_runtime_ui.typed_runtime_view_state();
        if (!view) {
            reason = "unloaded";
            break;
        }
        if ((view->dialogue && view->dialogue->choice &&
             !view->dialogue->choice->options.empty()) ||
            (view->scene && view->scene->choice && !view->scene->choice->options.empty())) {
            reason = "choice-available";
            break;
        }
        if (view->room && std::any_of(view->room->exits.begin(), view->room->exits.end(),
                                      [](const auto& exit) { return exit.enabled; })) {
            reason = "navigation-available";
            break;
        }
        const auto& controls = view->room ? view->room->controls : view->inventory.controls;
        if (std::any_of(controls.begin(), controls.end(),
                        [](const auto& control) { return control.enabled; })) {
            reason = "action-available";
            break;
        }
        if (view->can_continue) {
            if (!continue_dialogue()) {
                reason = "error";
                break;
            }
        } else if (!step(tick_seconds)) {
            reason = view->mode == "ended" ? "game-end" : "explicit-input";
            break;
        }
    }
    return nlohmann::json{
        {"reason", reason},
        {"stepsApplied", applied},
        {"ticksApplied", applied},
        {"finalSnapshot", nlohmann::json::parse(debug_snapshot(), nullptr, false)}}
        .dump();
}

std::string RuntimePreviewController::debug_snapshot() const
{
    const auto* view = m_engine.m_runtime_ui.typed_runtime_view_state();
    if (!view)
        return {};
    return encode_preview_debug_snapshot(*view, m_engine.m_runtime_ui.typed_runtime_diagnostics(),
                                         m_engine.m_preview_running)
        .dump();
}

} // namespace noveltea
