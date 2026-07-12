#include "noveltea/runtime_debug_mutation.hpp"

#include "noveltea/core/project_ids.hpp"
#include "noveltea/core/project_model.hpp"
#include "noveltea/runtime_debug_snapshot.hpp"
#include "noveltea/runtime_shell.hpp"

#include <SDL3/SDL.h>

#include <exception>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

namespace noveltea {
namespace {

nlohmann::json debug_variable_ref(const std::string& variable_id)
{
    return {{"type", "variable"},
            {"id", variable_id},
            {"collection", "variables"},
            {"label", variable_id}};
}

bool has_property_id(const nlohmann::json& root, const std::string& property_id)
{
    const auto properties = root.find(std::string(core::project_ids::properties));
    return properties != root.end() && properties->is_object() &&
           properties->find(property_id) != properties->end();
}

bool runtime_property_known(const core::ProjectModel* project, const nlohmann::json& save_root,
                            const std::string& property_id)
{
    if (property_id.empty()) {
        return false;
    }
    if (has_property_id(save_root, property_id)) {
        return true;
    }
    return project && has_property_id(project->document_root(), property_id);
}

nlohmann::json make_runtime_debug_event(std::string kind, std::string label, nlohmann::json target,
                                        nlohmann::json old_value, nlohmann::json new_value,
                                        std::string message = {})
{
    nlohmann::json event = {{"kind", std::move(kind)},          {"debugOnly", true},
                            {"label", std::move(label)},        {"target", std::move(target)},
                            {"oldValue", std::move(old_value)}, {"newValue", std::move(new_value)}};
    if (!message.empty()) {
        event["message"] = std::move(message);
    }
    return event;
}

} // namespace

std::string runtime_debug_set_variable(RuntimeShell& shell, const std::string& variable_id,
                                       const std::string& value_json)
{
    if (!shell.loaded() || variable_id.empty()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot set debug variable without a loaded runtime project");
        return {};
    }
    auto& host = shell.host();
    auto& session = host.session();
    const auto* project = session.project();
    const auto save_snapshot = host.snapshot_save().root();
    if (!runtime_property_known(project, save_snapshot, variable_id)) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] debug variable id does not exist in loaded project: %s",
                    variable_id.c_str());
        return {};
    }

    auto value = nlohmann::json::parse(value_json, nullptr, false);
    if (value.is_discarded()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] debug variable value JSON parse failed");
        return {};
    }

    const auto old_value = session.property(variable_id);
    session.set_property(variable_id, value);
    host.refresh_interactions();
    return make_runtime_debug_event("variable-set", "Debug set variable",
                                    debug_variable_ref(variable_id), old_value,
                                    session.property(variable_id), "debug-only variable override")
        .dump();
}

std::string runtime_debug_reset_variable(RuntimeShell& shell, const std::string& variable_id)
{
    if (!shell.loaded() || variable_id.empty()) {
        SDL_LogWarn(
            SDL_LOG_CATEGORY_APPLICATION,
            "[runtime-preview] cannot reset debug variable without a loaded runtime project");
        return {};
    }
    auto& host = shell.host();
    auto& session = host.session();
    const auto* project = session.project();
    const auto save_snapshot = host.snapshot_save().root();
    if (!runtime_property_known(project, save_snapshot, variable_id)) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] debug variable id does not exist in loaded project: %s",
                    variable_id.c_str());
        return {};
    }

    const auto old_value = session.property(variable_id);
    session.unset_property(variable_id);
    host.refresh_interactions();
    return make_runtime_debug_event(
               "variable-reset", "Debug reset variable", debug_variable_ref(variable_id), old_value,
               session.property(variable_id), "debug-only variable override removed")
        .dump();
}

std::string runtime_debug_give_object(RuntimeShell& shell, const std::string& object_id)
{
    if (!shell.loaded() || object_id.empty()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot give debug object without a loaded runtime project");
        return {};
    }
    auto& host = shell.host();
    auto& session = host.session();
    const auto* project = session.project();
    if (!project || !project->objects().contains(object_id)) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] debug object id does not exist in loaded project: %s",
                    object_id.c_str());
        return {};
    }

    const auto old_location = session.effective_object_location(object_id);
    const core::EntityRef player_ref{core::EntityType::CustomScript,
                                     std::string(core::project_ids::player)};
    session.set_object_location(object_id, player_ref);
    host.refresh_interactions();
    return make_runtime_debug_event(
               "inventory-give", "Debug give inventory object",
               make_runtime_debug_entity_ref(core::EntityRef{core::EntityType::Object, object_id},
                                             project),
               old_location ? make_runtime_debug_entity_ref(*old_location, project)
                            : nlohmann::json(nullptr),
               make_runtime_debug_entity_ref(player_ref, project), "debug-only inventory mutation")
        .dump();
}

std::string runtime_debug_remove_inventory_object(RuntimeShell& shell, const std::string& object_id)
{
    if (!shell.loaded() || object_id.empty()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION, "[runtime-preview] cannot remove debug inventory "
                                                  "object without a loaded runtime project");
        return {};
    }
    auto& host = shell.host();
    auto& session = host.session();
    const auto* project = session.project();
    if (!project || !project->objects().contains(object_id)) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] debug object id does not exist in loaded project: %s",
                    object_id.c_str());
        return {};
    }

    const auto old_location = session.effective_object_location(object_id);
    const core::EntityRef removed_ref{core::EntityType::CustomScript, "__debug_removed"};
    session.set_object_location(object_id, removed_ref);
    host.refresh_interactions();
    return make_runtime_debug_event(
               "inventory-remove", "Debug remove inventory object",
               make_runtime_debug_entity_ref(core::EntityRef{core::EntityType::Object, object_id},
                                             project),
               old_location ? make_runtime_debug_entity_ref(*old_location, project)
                            : nlohmann::json(nullptr),
               make_runtime_debug_entity_ref(removed_ref, project), "debug-only inventory mutation")
        .dump();
}

RuntimeDebugMutationResult runtime_debug_teleport_room(RuntimeShell& shell,
                                                       const std::string& room_id)
{
    RuntimeDebugMutationResult mutation;
    if (!shell.loaded() || room_id.empty()) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] cannot teleport without a loaded runtime project");
        return mutation;
    }
    auto& host = shell.host();
    auto& session = host.session();
    const auto* project = session.project();
    if (!project || !project->rooms().contains(room_id)) {
        SDL_LogWarn(SDL_LOG_CATEGORY_APPLICATION,
                    "[runtime-preview] debug room id does not exist in loaded project: %s",
                    room_id.c_str());
        return mutation;
    }

    const nlohmann::json old_room = session.current_room_id()
                                        ? nlohmann::json(*session.current_room_id())
                                        : nlohmann::json(nullptr);
    mutation.runtime_result = host.start_room(room_id);
    mutation.has_runtime_result = true;
    if (!mutation.runtime_result.handled) {
        return mutation;
    }
    host.refresh_interactions();
    const nlohmann::json new_room = session.current_room_id()
                                        ? nlohmann::json(*session.current_room_id())
                                        : nlohmann::json(nullptr);
    mutation.event_json =
        make_runtime_debug_event("room-teleport", "Debug teleport to room",
                                 make_runtime_debug_entity_ref(
                                     core::EntityRef{core::EntityType::Room, room_id}, project),
                                 old_room, new_room, "debug-only teleport")
            .dump();
    return mutation;
}

} // namespace noveltea
