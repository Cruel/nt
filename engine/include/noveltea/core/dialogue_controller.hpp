#pragma once

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_model.hpp>
#include <noveltea/core/runtime_controller.hpp>

namespace noveltea::core {

struct DialogueOptionInfo {
    std::string text;
    int target_segment = -1;
    int sub_index = 0;
    bool enabled = false;
    bool show_once = false;
};

class DialogueController {
public:
    explicit DialogueController(GameSession& session);

    void start(const std::string& dialogue_id);
    void continue_to_next();
    bool select_option(int option_index);
    void tick(double delta_seconds);

    [[nodiscard]] bool is_complete() const noexcept { return m_complete; }
    [[nodiscard]] bool is_waiting_for_text() const noexcept { return m_waiting_for_text; }
    [[nodiscard]] bool is_waiting_for_choice() const noexcept { return m_waiting_for_choice; }
    [[nodiscard]] const std::string& current_dialogue_id() const noexcept { return m_dialogue_id; }
    [[nodiscard]] const std::string& current_text_name() const noexcept { return m_current_name; }
    [[nodiscard]] const std::string& current_text_body() const noexcept { return m_current_text; }
    [[nodiscard]] const std::vector<DialogueOptionInfo>& options() const noexcept { return m_options; }

    [[nodiscard]] std::vector<ControllerCommand> take_commands();
    void reset();

    static std::vector<std::pair<std::string, std::string>> get_text_multiline(
        const std::string& text_raw, const std::string& default_name);
    static std::pair<std::string, std::string> get_line_pair(
        const std::string& line, const std::string& default_name);
    static std::vector<std::string> get_option_multiline(const std::string& text_raw);

    // Save/restore for checkpoint save slots
    [[nodiscard]] nlohmann::json save_state() const;
    void restore_state(const nlohmann::json& state);

private:
    void change_segment(int segment_index, bool run_segment = true, int button_subindex = -1);
    void change_line(int line_index);
    void gen_options(int parent_index, bool is_root);
    void emit_script_deferred(const std::string& script, const std::string& context_desc);
    void emit_dialogue_text();
    void emit_dialogue_options();
    void emit_dialogue_complete();
    void emit_command(ControllerCommand cmd);

    bool passes_condition(const DialogueSegmentModel& seg, int button_subindex);
    std::string evaluate_text(const DialogueSegmentModel& seg, int button_subindex);

    GameSession* m_session;
    std::string m_dialogue_id;
    const DialogueModel* m_dialogue = nullptr;

    int m_current_segment_index = -1;
    int m_next_forced_segment_index = -1;
    int m_text_line_index = -1;
    bool m_complete = false;
    bool m_waiting_for_text = false;
    bool m_waiting_for_choice = false;
    bool m_current_text_logged = false;

    std::string m_current_name;
    std::string m_current_text;
    std::vector<std::pair<std::string, std::string>> m_text_lines;
    std::vector<DialogueOptionInfo> m_options;
    std::set<int> m_shown_segments;

    std::vector<ControllerCommand> m_commands;
};

} // namespace noveltea::core
