#include "noveltea/runtime_debug_snapshot.hpp"

#include "noveltea/core/json_access.hpp"
#include "noveltea/core/project_ids.hpp"
#include "noveltea/core/project_model.hpp"
#include "noveltea/runtime_shell.hpp"

#include <algorithm>
#include <map>
#include <string>
#include <utility>

namespace noveltea {
namespace {

std::string runtime_diagnostic_severity(core::RuntimeDiagnosticSeverity severity)
{
    switch (severity) {
    case core::RuntimeDiagnosticSeverity::Info:
        return "info";
    case core::RuntimeDiagnosticSeverity::Warning:
        return "warning";
    case core::RuntimeDiagnosticSeverity::Error:
        return "error";
    }
    return "warning";
}

std::string entity_type_name(core::EntityType type)
{
    switch (type) {
    case core::EntityType::Action:
        return "action";
    case core::EntityType::Cutscene:
        return "cutscene";
    case core::EntityType::Dialogue:
        return "dialogue";
    case core::EntityType::Map:
        return "map";
    case core::EntityType::Object:
        return "object";
    case core::EntityType::Room:
        return "room";
    case core::EntityType::CustomScript:
        return "custom_script";
    case core::EntityType::Script:
        return "script";
    case core::EntityType::Verb:
        return "verb";
    case core::EntityType::Invalid:
        return "invalid";
    }
    return "unknown";
}

std::string editor_collection_name(core::EntityType type)
{
    switch (type) {
    case core::EntityType::Action:
        return "actions";
    case core::EntityType::Cutscene:
        return "scenes";
    case core::EntityType::Dialogue:
        return "dialogues";
    case core::EntityType::Map:
        return "maps";
    case core::EntityType::Object:
        return "objects";
    case core::EntityType::Room:
        return "rooms";
    case core::EntityType::Script:
    case core::EntityType::CustomScript:
        return "scripts";
    case core::EntityType::Verb:
        return "verbs";
    case core::EntityType::Invalid:
        return "";
    }
    return "";
}

std::string entity_label(const core::ProjectModel* project, const core::EntityRef& ref)
{
    if (!project) {
        return ref.id;
    }
    switch (ref.type) {
    case core::EntityType::Dialogue:
        if (auto it = project->dialogues().find(ref.id); it != project->dialogues().end()) {
            return it->second.default_name.empty() ? ref.id : it->second.default_name;
        }
        break;
    case core::EntityType::Object:
        if (auto it = project->objects().find(ref.id); it != project->objects().end()) {
            return it->second.name.empty() ? ref.id : it->second.name;
        }
        break;
    case core::EntityType::Room:
        if (auto it = project->rooms().find(ref.id); it != project->rooms().end()) {
            return it->second.name.empty() ? ref.id : it->second.name;
        }
        break;
    case core::EntityType::Verb:
        if (auto it = project->verbs().find(ref.id); it != project->verbs().end()) {
            return it->second.name.empty() ? ref.id : it->second.name;
        }
        break;
    case core::EntityType::Action:
    case core::EntityType::Cutscene:
    case core::EntityType::Map:
    case core::EntityType::Script:
    case core::EntityType::CustomScript:
    case core::EntityType::Invalid:
        break;
    }
    return ref.id;
}

std::string json_value_type(const nlohmann::json& value)
{
    if (value.is_boolean()) {
        return "boolean";
    }
    if (value.is_number_integer()) {
        return "integer";
    }
    if (value.is_number()) {
        return "number";
    }
    if (value.is_string()) {
        return "string";
    }
    if (value.is_array()) {
        return "array";
    }
    if (value.is_object()) {
        return "object";
    }
    if (value.is_null()) {
        return "null";
    }
    return "unknown";
}

} // namespace

std::string runtime_debug_shell_mode_name(RuntimeShellMode mode)
{
    switch (mode) {
    case RuntimeShellMode::Boot:
        return "boot";
    case RuntimeShellMode::Title:
        return "title";
    case RuntimeShellMode::Game:
        return "game";
    case RuntimeShellMode::Paused:
        return "paused";
    case RuntimeShellMode::Error:
        return "error";
    }
    return "unknown";
}

bool runtime_debug_diagnostics_have_error(const nlohmann::json& diagnostics)
{
    if (!diagnostics.is_array()) {
        return false;
    }
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const nlohmann::json& value) {
        return value.is_object() &&
               core::json_access::value_or(value, "severity", std::string()) == "error";
    });
}

nlohmann::json make_runtime_debug_entity_ref(const core::EntityRef& ref,
                                             const core::ProjectModel* project)
{
    nlohmann::json out = {{"type", entity_type_name(ref.type)},
                          {"id", ref.id},
                          {"legacyType", core::to_integer(ref.type)}};
    if (auto collection = editor_collection_name(ref.type); !collection.empty()) {
        out["collection"] = std::move(collection);
    }
    if (auto label = entity_label(project, ref); !label.empty()) {
        out["label"] = std::move(label);
    }
    return out;
}

nlohmann::json make_runtime_debug_diagnostic_snapshot(const core::RuntimeDiagnostic& diagnostic,
                                                      const core::ProjectModel* project)
{
    nlohmann::json out = {{"severity", runtime_diagnostic_severity(diagnostic.severity)},
                          {"message", diagnostic.message}};
    if (!diagnostic.category.empty()) {
        out["category"] = diagnostic.category;
    }
    if (diagnostic.source) {
        out["source"] = make_runtime_debug_entity_ref(*diagnostic.source, project);
    }
    if (!diagnostic.script_context.empty()) {
        out["scriptContext"] = diagnostic.script_context;
    }
    if (!diagnostic.hook_context.empty()) {
        out["hookContext"] = diagnostic.hook_context;
    }
    if (!diagnostic.lua_traceback.empty()) {
        out["luaTraceback"] = diagnostic.lua_traceback;
    }
    return out;
}

std::string make_runtime_debug_snapshot(const RuntimeShell& shell, bool preview_running)
{
    const auto& host = shell.host();
    const auto& view = host.view_state();
    const auto& session = host.session();
    const auto* project = session.project();

    nlohmann::json save_snapshot = nlohmann::json::object();
    nlohmann::json controller_state = nlohmann::json::object();
    nlohmann::json variables = nlohmann::json::array();
    nlohmann::json inventory = nlohmann::json::array();
    nlohmann::json selected_objects = nlohmann::json::array();
    nlohmann::json diagnostics = nlohmann::json::array();

    if (host.loaded()) {
        save_snapshot = host.snapshot_save().root();
        if (const auto* controller = host.controller()) {
            controller_state = controller->save_state();
        }
    }

    std::map<std::string, nlohmann::json> default_properties;
    if (project) {
        if (const auto properties =
                project->document_root().find(std::string(core::project_ids::properties));
            properties != project->document_root().end() && properties->is_object()) {
            for (const auto& [id, value] : properties->items()) {
                default_properties.emplace(id, value);
                variables.push_back({{"id", id},
                                     {"label", id},
                                     {"type", json_value_type(value)},
                                     {"value", value},
                                     {"defaultValue", value},
                                     {"dirty", false},
                                     {"overridden", false}});
            }
        }
    }

    if (const auto properties = save_snapshot.find(std::string(core::project_ids::properties));
        properties != save_snapshot.end() && properties->is_object()) {
        for (const auto& [id, value] : properties->items()) {
            const auto default_it = default_properties.find(id);
            auto existing = std::find_if(
                variables.begin(), variables.end(), [&](const nlohmann::json& variable) {
                    return variable.is_object() &&
                           core::json_access::value_or(variable, "id", std::string()) == id;
                });
            nlohmann::json variable = {
                {"id", id},
                {"label", id},
                {"type", json_value_type(value)},
                {"value", value},
                {"dirty", default_it == default_properties.end() || default_it->second != value},
                {"overridden", true}};
            if (default_it != default_properties.end()) {
                variable["defaultValue"] = default_it->second;
            }
            if (existing != variables.end()) {
                *existing = std::move(variable);
            } else {
                variables.push_back(std::move(variable));
            }
        }
    }

    for (const auto& object : view.objects) {
        if (object.selected) {
            selected_objects.push_back(object.id);
        }
        if (!object.in_inventory) {
            continue;
        }
        nlohmann::json item = {{"id", object.id},
                               {"label", object.name.empty() ? object.id : object.name},
                               {"selected", object.selected},
                               {"enabled", object.enabled}};
        if (host.loaded()) {
            if (const auto location = session.effective_object_location(object.id); location) {
                item["location"] = make_runtime_debug_entity_ref(*location, project);
            }
        }
        inventory.push_back(std::move(item));
    }

    if (host.loaded() && project) {
        for (const auto& [object_id, object_model] : project->objects()) {
            const auto location = session.effective_object_location(object_id);
            if (!location || location->type != core::EntityType::CustomScript ||
                location->id != core::project_ids::player) {
                continue;
            }
            const auto existing =
                std::find_if(inventory.begin(), inventory.end(), [&](const nlohmann::json& item) {
                    return item.is_object() &&
                           core::json_access::value_or(item, "id", std::string()) == object_id;
                });
            if (existing != inventory.end()) {
                continue;
            }
            inventory.push_back(
                {{"id", object_id},
                 {"label", object_model.name.empty() ? object_id : object_model.name},
                 {"selected", false},
                 {"enabled", true},
                 {"location", make_runtime_debug_entity_ref(*location, project)}});
        }
    }

    for (const auto& diagnostic : shell.last_diagnostics()) {
        diagnostics.push_back(make_runtime_debug_diagnostic_snapshot(diagnostic, project));
    }
    for (const auto& diagnostic : host.last_diagnostics()) {
        diagnostics.push_back(make_runtime_debug_diagnostic_snapshot(diagnostic, project));
    }
    for (const auto& diagnostic : view.asset_diagnostics) {
        diagnostics.push_back({{"severity", "warning"},
                               {"category", "runtime-asset"},
                               {"message", diagnostic.message},
                               {"path", diagnostic.asset_path}});
    }

    nlohmann::json dialogue_options = nlohmann::json::array();
    nlohmann::json clickable_targets = nlohmann::json::array();
    for (std::size_t i = 0; i < view.dialogue_options.size(); ++i) {
        const auto& option = view.dialogue_options[i];
        dialogue_options.push_back(
            {{"index", static_cast<int>(i)}, {"label", option.text}, {"enabled", option.enabled}});
        if (option.enabled) {
            const auto selector = "button[nt-option=\"" + std::to_string(i) + "\"]";
            clickable_targets.push_back({{"documentId", "runtime_game"},
                                         {"target", selector},
                                         {"selector", selector},
                                         {"label", option.text},
                                         {"kind", "dialogue-option"},
                                         {"index", static_cast<int>(i)}});
        }
    }

    nlohmann::json navigation = nlohmann::json::array();
    for (std::size_t i = 0; i < view.navigation.size(); ++i) {
        navigation.push_back(
            {{"index", static_cast<int>(i)}, {"label", view.navigation[i]}, {"enabled", true}});
        const auto selector = "button[nt-nav=\"" + std::to_string(i) + "\"]";
        clickable_targets.push_back({{"documentId", "runtime_game"},
                                     {"target", selector},
                                     {"selector", selector},
                                     {"label", view.navigation[i]},
                                     {"kind", "navigate"},
                                     {"index", static_cast<int>(i)}});
    }

    nlohmann::json actions = nlohmann::json::array();
    for (const auto& action : view.actions) {
        nlohmann::json action_json = {
            {"verbId", action.verb_id},
            {"label", action.label.empty() ? action.verb_id : action.label},
            {"objectCount", action.object_count},
            {"selectedCount", action.selected_count},
            {"enabled", action.enabled}};
        if (!action.reason.empty()) {
            action_json["reason"] = action.reason;
        }
        if (action.enabled) {
            const auto selector = "button[nt-action=\"" + action.verb_id + "\"]";
            clickable_targets.push_back(
                {{"documentId", "runtime_game"},
                 {"target", selector},
                 {"selector", selector},
                 {"label", action.label.empty() ? action.verb_id : action.label},
                 {"kind", "run-action"},
                 {"verbId", action.verb_id}});
        }
        actions.push_back(std::move(action_json));
    }

    const bool can_continue = view.awaiting_continue || view.page_break;
    if (can_continue) {
        clickable_targets.push_back({{"documentId", "runtime_game"},
                                     {"target", ".continue"},
                                     {"selector", ".continue"},
                                     {"label", view.page_break ? "Page break" : "Continue"},
                                     {"kind", "continue"}});
    }

    std::string waiting_kind = "none";
    std::string waiting_reason;
    if (!host.loaded()) {
        waiting_kind = "unloaded";
        waiting_reason = "no runtime project is loaded";
    } else if (shell.paused()) {
        waiting_kind = "paused";
        waiting_reason = "runtime shell is paused";
    } else if (runtime_debug_diagnostics_have_error(diagnostics)) {
        waiting_kind = "error";
        waiting_reason = "runtime diagnostics contain an error";
    } else if (!dialogue_options.empty()) {
        waiting_kind = "choice";
        waiting_reason = "dialogue choices are available";
    } else if (!navigation.empty()) {
        waiting_kind = "navigation";
        waiting_reason = "navigation choices are available";
    } else if (!actions.empty()) {
        waiting_kind = "action";
        waiting_reason = "object actions are available";
    } else if (can_continue) {
        waiting_kind = "continue";
        waiting_reason = "runtime is waiting for continue";
    } else if (shell.mode() == RuntimeShellMode::Title) {
        waiting_kind = "title";
        waiting_reason = "title UI is active";
    }

    nlohmann::json waiting = {{"kind", waiting_kind}, {"canContinue", can_continue}};
    if (!waiting_reason.empty()) {
        waiting["reason"] = std::move(waiting_reason);
    }

    nlohmann::json snapshot = {{"loaded", host.loaded()},
                               {"running", host.loaded() && preview_running},
                               {"shellMode", runtime_debug_shell_mode_name(shell.mode())},
                               {"runtimeMode", std::string(host.current_mode_name())},
                               {"waiting", std::move(waiting)},
                               {"availableInputs",
                                {{"continue", can_continue},
                                 {"dialogueOptions", std::move(dialogue_options)},
                                 {"navigation", std::move(navigation)},
                                 {"actions", std::move(actions)},
                                 {"selectedObjects", selected_objects},
                                 {"clickableTargets", std::move(clickable_targets)}}},
                               {"variables", std::move(variables)},
                               {"inventory", std::move(inventory)},
                               {"selectedObjects", std::move(selected_objects)},
                               {"diagnostics", std::move(diagnostics)},
                               {"saveSnapshot", save_snapshot},
                               {"controllerState", controller_state}};

    if (const auto entrypoint = session.startup_entrypoint(); entrypoint && entrypoint->has_id()) {
        snapshot["entrypoint"] = make_runtime_debug_entity_ref(*entrypoint, project);
    }
    if (const auto current_entity = session.current_entity();
        current_entity && current_entity->has_id()) {
        snapshot["currentEntity"] = make_runtime_debug_entity_ref(*current_entity, project);
        if (current_entity->type == core::EntityType::Dialogue) {
            snapshot["currentDialogueId"] = current_entity->id;
        }
    }
    if (const auto current_room = session.current_room_id();
        current_room && !current_room->empty()) {
        snapshot["currentRoomId"] = *current_room;
    } else if (!view.map_view.current_room_id.empty()) {
        snapshot["currentRoomId"] = view.map_view.current_room_id;
    }
    if (const auto current_map = session.current_map_id(); current_map && !current_map->empty()) {
        snapshot["currentMapId"] = *current_map;
    } else if (!view.map_view.map_id.empty()) {
        snapshot["currentMapId"] = view.map_view.map_id;
    }

    return snapshot.dump();
}

} // namespace noveltea
