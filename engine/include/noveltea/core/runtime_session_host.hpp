#pragma once

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/runtime_controller.hpp>
#include <noveltea/core/runtime_ui_view.hpp>

namespace noveltea::core {

class RuntimeSessionHost {
public:
    RuntimeSessionHost();
    ~RuntimeSessionHost();

    RuntimeSessionHost(const RuntimeSessionHost&) = delete;
    RuntimeSessionHost& operator=(const RuntimeSessionHost&) = delete;

    [[nodiscard]] GameSessionLoadResult load(ProjectDocument project,
                                             SaveDocument save = SaveDocument::new_save());
    void reset();
    void tick(double delta_seconds);

    [[nodiscard]] bool loaded() const noexcept { return m_session.loaded() && m_controller != nullptr; }
    [[nodiscard]] GameSession& session() noexcept { return m_session; }
    [[nodiscard]] const GameSession& session() const noexcept { return m_session; }
    [[nodiscard]] RuntimeController* controller() noexcept { return m_controller.get(); }
    [[nodiscard]] const RuntimeController* controller() const noexcept { return m_controller.get(); }
    [[nodiscard]] const RuntimeUIViewState& view_state() const noexcept { return m_view.state(); }
    [[nodiscard]] const std::vector<ControllerCommand>& last_commands() const noexcept { return m_last_commands; }
    [[nodiscard]] std::string_view current_mode_name() const noexcept;

    bool navigate_path(int direction);
    bool select_dialogue_option(int option_index);
    bool continue_active();
    bool process_action(const std::string& verb_id, const std::vector<std::string>& object_ids);

private:
    void consume_commands(std::vector<ControllerCommand> commands);

    GameSession m_session;
    std::unique_ptr<RuntimeController> m_controller;
    RuntimeUIViewAdapter m_view;
    std::vector<ControllerCommand> m_last_commands;
};

} // namespace noveltea::core
