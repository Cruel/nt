#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/game_session.hpp>

namespace noveltea::core {

enum class ControllerCommandType {
    ModeChanged,
    RoomEntry,
    RoomDescription,
    NavigationUpdate,
    ScriptDeferred,
};

struct ControllerCommand {
    ControllerCommandType type = ControllerCommandType::ModeChanged;
    std::optional<EntityRef> entity;
    std::string text;
    nlohmann::json data;
};

class RuntimeController {
public:
    explicit RuntimeController(GameSession& session);

    void tick(double delta_seconds);

    [[nodiscard]] bool idle() const noexcept { return m_idle; }
    [[nodiscard]] std::string_view current_mode_name() const noexcept;
    [[nodiscard]] int visit_count(const std::string& room_id) const;

    void navigate_path(int direction);

    [[nodiscard]] std::vector<ControllerCommand> take_commands();

private:
    void drain_next();
    void enter_room(const std::string& room_id);
    void exit_current_mode();
    void emit_command(ControllerCommand cmd);

    enum class Mode { None, Room, Dialogue, Cutscene, Script };

    GameSession* m_session;
    Mode m_mode = Mode::None;
    std::string m_mode_entity_id;
    bool m_idle = true;
    bool m_startup_handled = false;
    std::map<std::string, int> m_visit_counts;
    std::vector<ControllerCommand> m_commands;
};

} // namespace noveltea::core
