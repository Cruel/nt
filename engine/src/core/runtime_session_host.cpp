#include <noveltea/core/runtime_session_host.hpp>

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
    m_last_commands = std::move(commands);
}

} // namespace noveltea::core
