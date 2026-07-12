#include "noveltea/runtime_preview_controller.hpp"

#include "noveltea/engine.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/runtime_debug_mutation.hpp"
#include "noveltea/runtime_debug_snapshot.hpp"

#include <SDL3/SDL.h>

#include <algorithm>
#include <exception>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

namespace noveltea {

RuntimePreviewController::RuntimePreviewController(Engine& engine) noexcept : m_engine(engine) {}

bool RuntimePreviewController::load_project(const std::string& logical_path)
{
    return m_engine.load_runtime_project(logical_path);
}

bool RuntimePreviewController::reset()
{
    if (m_engine.m_runtime_project_path.empty()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot reset without a loaded runtime project");
        return false;
    }
    return m_engine.load_runtime_project(m_engine.m_runtime_project_path);
}

bool RuntimePreviewController::start()
{
    if (!m_engine.m_runtime_shell.loaded()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot start without a loaded runtime project");
        return false;
    }
    m_engine.m_preview_running = true;
    auto result = m_engine.m_runtime_shell.start_game();
    const bool handled = result.handled;
    m_engine.process_runtime_result(result);
    preview_bridge::emit_state_changed(m_engine.m_demo_position, m_engine.m_preview_running);
    return handled;
}

bool RuntimePreviewController::stop()
{
    if (!m_engine.m_runtime_shell.loaded()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot stop without a loaded runtime project");
        return false;
    }
    m_engine.m_preview_running = false;
    preview_bridge::emit_state_changed(m_engine.m_demo_position, m_engine.m_preview_running);
    return true;
}

bool RuntimePreviewController::step(double delta_seconds)
{
    if (!m_engine.m_runtime_shell.loaded()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot step without a loaded runtime project");
        return false;
    }
    auto result = m_engine.m_runtime_shell.update(std::max(0.0, delta_seconds));
    const bool handled = result.handled;
    m_engine.process_runtime_result(result);
    return handled;
}

bool RuntimePreviewController::apply_input(core::RuntimeInput input)
{
    if (!m_engine.m_runtime_shell.loaded()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] runtime project is not loaded");
        return false;
    }
    auto result = m_engine.m_runtime_shell.host().apply_input(std::move(input));
    const bool handled = result.handled;
    m_engine.process_runtime_result(result);
    return handled;
}

bool RuntimePreviewController::continue_dialogue()
{
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::Continue;
    return apply_input(std::move(input));
}

bool RuntimePreviewController::select_dialogue_option(int option_index)
{
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::SelectDialogueOption;
    input.index = option_index;
    return apply_input(std::move(input));
}

bool RuntimePreviewController::navigate(int direction)
{
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::Navigate;
    input.direction = direction;
    return apply_input(std::move(input));
}

bool RuntimePreviewController::select_object(const std::string& object_id)
{
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::SelectObject;
    input.object_ids = {object_id};
    return apply_input(std::move(input));
}

bool RuntimePreviewController::clear_object_selection()
{
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::ClearObjectSelection;
    return apply_input(std::move(input));
}

bool RuntimePreviewController::run_action(const std::string& verb_id,
                                          const std::vector<std::string>& object_ids)
{
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::RunAction;
    input.verb_id = verb_id;
    input.object_ids = object_ids;
    return apply_input(std::move(input));
}

std::string RuntimePreviewController::set_variable(const std::string& variable_id,
                                                   const std::string& value_json)
{
    return runtime_debug_set_variable(m_engine.m_runtime_shell, variable_id, value_json);
}

std::string RuntimePreviewController::reset_variable(const std::string& variable_id)
{
    return runtime_debug_reset_variable(m_engine.m_runtime_shell, variable_id);
}

std::string RuntimePreviewController::give_object(const std::string& object_id)
{
    return runtime_debug_give_object(m_engine.m_runtime_shell, object_id);
}

std::string RuntimePreviewController::remove_inventory_object(const std::string& object_id)
{
    return runtime_debug_remove_inventory_object(m_engine.m_runtime_shell, object_id);
}

std::string RuntimePreviewController::teleport_room(const std::string& room_id)
{
    auto mutation = runtime_debug_teleport_room(m_engine.m_runtime_shell, room_id);
    if (mutation.has_runtime_result) {
        m_engine.process_runtime_result(mutation.runtime_result);
    }
    return mutation.event_json;
}

std::string RuntimePreviewController::fast_forward_to_input()
{
    constexpr int kMaxSemanticInputs = 500;
    constexpr int kMaxSimulatedTicks = 300;
    constexpr int kMaxUnchangedTicks = 20;
    constexpr double kTickSeconds = 1.0 / 60.0;

    auto parse_snapshot = [this]() {
        const auto snapshot_json = debug_snapshot();
        if (!snapshot_json.empty()) {
            auto parsed = nlohmann::json::parse(snapshot_json, nullptr, false);
            if (!parsed.is_discarded())
                return parsed;
            return nlohmann::json{{"loaded", false},
                                  {"running", false},
                                  {"waiting",
                                   {{"kind", "error"},
                                    {"canContinue", false},
                                    {"reason", "runtime debug snapshot parse failed"}}},
                                  {"availableInputs",
                                   {{"continue", false},
                                    {"dialogueOptions", nlohmann::json::array()},
                                    {"navigation", nlohmann::json::array()},
                                    {"actions", nlohmann::json::array()},
                                    {"selectedObjects", nlohmann::json::array()},
                                    {"clickableTargets", nlohmann::json::array()}}},
                                  {"variables", nlohmann::json::array()},
                                  {"inventory", nlohmann::json::array()},
                                  {"selectedObjects", nlohmann::json::array()},
                                  {"diagnostics", nlohmann::json::array()},
                                  {"saveSnapshot", nlohmann::json::object()},
                                  {"controllerState", nlohmann::json::object()}};
        }
        return nlohmann::json{{"loaded", false},
                              {"running", false},
                              {"waiting",
                               {{"kind", "unloaded"},
                                {"canContinue", false},
                                {"reason", "runtime debug snapshot is unavailable"}}},
                              {"availableInputs",
                               {{"continue", false},
                                {"dialogueOptions", nlohmann::json::array()},
                                {"navigation", nlohmann::json::array()},
                                {"actions", nlohmann::json::array()},
                                {"selectedObjects", nlohmann::json::array()},
                                {"clickableTargets", nlohmann::json::array()}}},
                              {"variables", nlohmann::json::array()},
                              {"inventory", nlohmann::json::array()},
                              {"selectedObjects", nlohmann::json::array()},
                              {"diagnostics", nlohmann::json::array()},
                              {"saveSnapshot", nlohmann::json::object()},
                              {"controllerState", nlohmann::json::object()}};
    };

    auto enabled_entries = [](const nlohmann::json& entries) {
        if (!entries.is_array())
            return 0;
        return static_cast<int>(
            std::count_if(entries.begin(), entries.end(), [](const auto& entry) {
                return entry.is_object() && entry.value("enabled", true);
            }));
    };

    auto classify_stop = [&](const nlohmann::json& snapshot) -> std::string {
        if (!snapshot.value("loaded", false))
            return "unloaded";
        const auto shell_mode = snapshot.value("shellMode", std::string());
        const auto runtime_mode = snapshot.value("runtimeMode", std::string());
        const auto waiting = snapshot.value("waiting", nlohmann::json::object());
        const auto waiting_kind = waiting.value("kind", std::string("unknown"));
        if (shell_mode == "error" ||
            runtime_debug_diagnostics_have_error(
                snapshot.value("diagnostics", nlohmann::json::array())) ||
            waiting_kind == "error")
            return "error";
        if (m_engine.m_runtime_shell.paused() ||
            m_engine.m_runtime_shell.layouts().pauses_gameplay() ||
            m_engine.m_runtime_shell.layouts().blocks_game_input() || shell_mode == "paused" ||
            shell_mode == "title" || waiting_kind == "paused" || waiting_kind == "title")
            return "blocking-ui";
        const auto inputs = snapshot.value("availableInputs", nlohmann::json::object());
        if (enabled_entries(inputs.value("dialogueOptions", nlohmann::json::array())) > 0 ||
            waiting_kind == "choice")
            return "choice-available";
        if (enabled_entries(inputs.value("navigation", nlohmann::json::array())) > 0 ||
            waiting_kind == "navigation")
            return "navigation-available";
        if (enabled_entries(inputs.value("actions", nlohmann::json::array())) > 0 ||
            waiting_kind == "action")
            return "action-available";
        const auto clickable_targets = inputs.value("clickableTargets", nlohmann::json::array());
        if (clickable_targets.is_array() && !clickable_targets.empty())
            return "ui-target-available";
        if (runtime_mode == "none" && shell_mode == "game")
            return "game-end";
        if (waiting_kind == "explicit-input")
            return "explicit-input";
        return "auto-progress";
    };

    int steps_applied = 0;
    int ticks_applied = 0;
    int unchanged_ticks = 0;
    std::string last_input;
    std::string reason;
    nlohmann::json final_snapshot = parse_snapshot();

    for (;;) {
        final_snapshot = parse_snapshot();
        reason = classify_stop(final_snapshot);
        if (reason != "auto-progress")
            break;

        const auto waiting = final_snapshot.value("waiting", nlohmann::json::object());
        const auto inputs = final_snapshot.value("availableInputs", nlohmann::json::object());
        if ((waiting.value("kind", std::string()) == "continue" ||
             waiting.value("canContinue", false)) &&
            inputs.value("continue", false)) {
            if (!continue_dialogue()) {
                reason = "stabilization-limit";
                break;
            }
            ++steps_applied;
            last_input = "continue";
            unchanged_ticks = 0;
        } else {
            const bool handled = step(kTickSeconds);
            ++ticks_applied;
            last_input = "tick";
            unchanged_ticks = handled ? 0 : unchanged_ticks + 1;
            if (unchanged_ticks >= kMaxUnchangedTicks) {
                reason = "stabilization-limit";
                break;
            }
        }

        if (steps_applied >= kMaxSemanticInputs || ticks_applied >= kMaxSimulatedTicks) {
            reason = "budget-exhausted";
            break;
        }
    }

    final_snapshot = parse_snapshot();
    nlohmann::json result = {{"reason", reason.empty() ? "stabilization-limit" : reason},
                             {"stepsApplied", steps_applied},
                             {"ticksApplied", ticks_applied},
                             {"semanticInputBudget", kMaxSemanticInputs},
                             {"simulatedTickBudget", kMaxSimulatedTicks},
                             {"stabilizationTickBudget", kMaxUnchangedTicks},
                             {"simulatedSecondsBudget", kMaxSimulatedTicks * kTickSeconds},
                             {"finalSnapshot", final_snapshot}};
    if (!last_input.empty()) {
        result["lastInput"] = last_input;
    }
    if (reason == "budget-exhausted") {
        result["diagnostic"] =
            "Fast-forward stopped after reaching the semantic input or simulated tick budget.";
    } else if (reason == "stabilization-limit") {
        result["diagnostic"] = "Fast-forward stopped because the runtime did not reach a new input "
                               "state within the stabilization budget.";
    } else if (reason == "error") {
        result["diagnostic"] = "Fast-forward stopped because runtime diagnostics contain an error.";
    }
    return result.dump();
}

std::string RuntimePreviewController::debug_snapshot() const
{
    return make_runtime_debug_snapshot(m_engine.m_runtime_shell, m_engine.m_preview_running);
}

} // namespace noveltea
