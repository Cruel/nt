#include <noveltea/core/runtime_session_host.hpp>

#include <noveltea/core/project_ids.hpp>

#include <algorithm>

namespace noveltea::core {

RuntimeSessionHost::RuntimeSessionHost() = default;
RuntimeSessionHost::~RuntimeSessionHost() = default;

GameSessionLoadResult RuntimeSessionHost::load(ProjectDocument project, SaveDocument save)
{
    reset();
    auto result = m_session.load(std::move(project), std::move(save));
    if (!result.success) {
        return result;
    }

    m_controller = std::make_unique<RuntimeController>(m_session);
    return result;
}

void RuntimeSessionHost::reset()
{
    m_controller.reset();
    m_session.reset();
    m_view.reset();
    m_last_commands.clear();
}

void RuntimeSessionHost::tick(double delta_seconds)
{
    if (!m_controller) return;
    m_controller->tick(delta_seconds);
    consume_commands(m_controller->take_commands());
}

std::string_view RuntimeSessionHost::current_mode_name() const noexcept
{
    return m_controller ? m_controller->current_mode_name() : std::string_view("none");
}

bool RuntimeSessionHost::navigate_path(int direction)
{
    if (!m_controller || current_mode_name() != std::string_view("room")) return false;
    m_controller->navigate_path(direction);
    consume_commands(m_controller->take_commands());
    return true;
}

bool RuntimeSessionHost::select_dialogue_option(int option_index)
{
    if (!m_controller || current_mode_name() != std::string_view("dialogue")) return false;
    const bool selected = m_controller->dialogue_select_option(option_index);
    consume_commands(m_controller->take_commands());
    return selected;
}

bool RuntimeSessionHost::continue_active()
{
    if (!m_controller) return false;
    const auto mode = current_mode_name();
    if (mode == std::string_view("dialogue")) {
        m_controller->dialogue_continue();
    } else if (mode == std::string_view("cutscene")) {
        m_controller->cutscene_click();
    } else {
        return false;
    }
    consume_commands(m_controller->take_commands());
    return true;
}

bool RuntimeSessionHost::process_action(const std::string& verb_id, const std::vector<std::string>& object_ids)
{
    if (!m_controller) return false;
    const bool processed = m_controller->process_action(verb_id, object_ids);
    consume_commands(m_controller->take_commands());
    return processed;
}

void RuntimeSessionHost::consume_commands(std::vector<ControllerCommand> commands)
{
    m_view.apply(commands);
    if (m_controller && m_controller->current_mode_name() == std::string_view("room")) {
        std::vector<RuntimeUIObject> objects;
        std::vector<RuntimeUIAction> actions;
        if (const auto* project = m_session.project()) {
            const auto room_id = std::string(m_controller->current_mode_entity_id());
            if (auto room_it = project->rooms().find(room_id); room_it != project->rooms().end()) {
                for (const auto& room_object : room_it->second.objects) {
                    auto object_it = project->objects().find(room_object.object_id);
                    RuntimeUIObject object;
                    object.id = room_object.object_id;
                    object.name = object_it != project->objects().end() ? object_it->second.name : room_object.object_id;
                    object.in_room = true;
                    objects.push_back(std::move(object));
                }
            }

            const auto& root = project->document_root();
            if (auto inv_it = root.find(std::string(project_ids::starting_inventory));
                inv_it != root.end() && inv_it->is_array()) {
                for (const auto& item : *inv_it) {
                    if (!item.is_string()) continue;
                    const auto id = item.get<std::string>();
                    auto object_it = project->objects().find(id);
                    if (auto existing = std::find_if(objects.begin(), objects.end(), [&](const RuntimeUIObject& object) {
                            return object.id == id;
                        }); existing != objects.end()) {
                        existing->in_inventory = true;
                        continue;
                    }
                    RuntimeUIObject object;
                    object.id = id;
                    object.name = object_it != project->objects().end() ? object_it->second.name : id;
                    object.in_inventory = true;
                    objects.push_back(std::move(object));
                }
            }

            for (const auto& [id, verb] : project->verbs()) {
                (void)id;
                if (verb.object_count > 0 || verb.object_count == 0) {
                    RuntimeUIAction action;
                    action.verb_id = verb.metadata.entity.id;
                    action.label = verb.name.empty() ? verb.metadata.entity.id : verb.name;
                    action.object_count = verb.object_count;
                    actions.push_back(std::move(action));
                }
            }
        }
        m_view.set_room_interactions(std::move(objects), std::move(actions));
    }
    m_last_commands = std::move(commands);
}

} // namespace noveltea::core
