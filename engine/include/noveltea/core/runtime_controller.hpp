#pragma once

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/game_session.hpp>

namespace noveltea::core {

class DialogueController;
class CutsceneController;

enum class ControllerCommandType {
    ModeChanged,
    RoomEntry,
    RoomDescription,
    NavigationUpdate,
    ScriptDeferred,
    Notification,
    TextLogged,

    // Dialogue mode
    DialogueText,
    DialogueOptions,
    DialogueComplete,

    // Cutscene mode
    CutsceneText,
    CutscenePageBreak,
    CutsceneComplete,

    // Room action processing
    ActionResolved,
    ActionRejected,
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
    ~RuntimeController();

    void tick(double delta_seconds);

    [[nodiscard]] bool idle() const noexcept { return m_idle; }
    [[nodiscard]] std::string_view current_mode_name() const noexcept;
    [[nodiscard]] int visit_count(const std::string& room_id) const;

    void navigate_path(int direction);
    bool process_action(const std::string& verb_id, const std::vector<std::string>& object_ids);

    // Dialogue control
    void dialogue_continue();
    bool dialogue_select_option(int option_index);

    // Cutscene control
    void cutscene_click();

    [[nodiscard]] std::vector<ControllerCommand> take_commands();

    [[nodiscard]] DialogueController& dialogue_controller() noexcept { return *m_dialogue_controller; }
    [[nodiscard]] CutsceneController& cutscene_controller() noexcept { return *m_cutscene_controller; }

    [[nodiscard]] nlohmann::json save_state() const;
    void restore_state(const nlohmann::json& state);

private:
    void drain_next();
    void enter_room(const std::string& room_id);
    void exit_current_mode();
    void emit_room_hook_script(const RoomModel& room, std::string_view hook_context, const std::string& script);
    void emit_room_enter_hooks(const RoomModel* room);
    void emit_room_leave_hooks(const RoomModel* room);
    void process_script_entity(const EntityRef& ref);
    void emit_command(ControllerCommand cmd);
    void process_dialogue_commands();
    void process_cutscene_commands();
    [[nodiscard]] bool object_available_for_action(const std::string& object_id) const;
    [[nodiscard]] const ActionModel* find_action(const std::string& verb_id,
                                                 const std::vector<std::string>& object_ids) const;
    void emit_action_script_chain(const ActionModel& action,
                                  const std::string& verb_id,
                                  const std::vector<std::string>& object_ids);
    void emit_action_script(const std::string& script,
                            const std::string& context,
                            const std::string& verb_id,
                            const std::vector<std::string>& object_ids,
                            const std::optional<std::string>& action_id = std::nullopt);

    enum class Mode { None, Room, Dialogue, Cutscene, Script };

    GameSession* m_session;
    Mode m_mode = Mode::None;
    std::string m_mode_entity_id;
    bool m_idle = true;
    bool m_startup_handled = false;
    std::map<std::string, int> m_visit_counts;
    std::vector<ControllerCommand> m_commands;
    RuntimeEventListenerId m_notification_listener = 0;
    RuntimeEventListenerId m_text_log_listener = 0;

    std::unique_ptr<DialogueController> m_dialogue_controller;
    std::unique_ptr<CutsceneController> m_cutscene_controller;
};

} // namespace noveltea::core
