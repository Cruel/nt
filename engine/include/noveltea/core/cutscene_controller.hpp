#pragma once

#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/game_session.hpp>
#include <noveltea/core/project_model.hpp>
#include <noveltea/core/runtime_controller.hpp>

namespace noveltea::core {

class CutsceneController {
public:
    explicit CutsceneController(GameSession& session);

    void start(const std::string& cutscene_id);
    void click();
    void tick(double delta_seconds);

    [[nodiscard]] bool is_complete() const noexcept { return m_complete; }
    [[nodiscard]] bool is_waiting_for_click() const noexcept { return m_waiting_for_click; }
    [[nodiscard]] const std::string& current_cutscene_id() const noexcept { return m_cutscene_id; }
    [[nodiscard]] size_t current_segment_index() const noexcept { return m_segment_index; }

    [[nodiscard]] std::vector<ControllerCommand> take_commands();
    void reset();

    // Save/restore for checkpoint save slots
    [[nodiscard]] nlohmann::json save_state() const;
    void restore_state(const nlohmann::json& state);

private:
    void expand_timeline();
    void advance_to_segment(size_t index);
    void emit_script_deferred(const std::string& script, const std::string& context_desc);
    void emit_cutscene_text(const std::string& text);
    void emit_cutscene_page_break();
    void emit_cutscene_complete();
    void emit_command(ControllerCommand cmd);

    static std::vector<CutsceneSegmentModel>
    expand_page_segment(const CutsceneSegmentModel& page_seg);

    bool passes_condition(const CutsceneSegmentModel& seg);

    GameSession* m_session;
    std::string m_cutscene_id;
    const CutsceneModel* m_cutscene = nullptr;

    std::vector<CutsceneSegmentModel> m_expanded_segments;
    size_t m_segment_index = 0;
    double m_time_to_next = 0.0;
    bool m_complete = false;
    bool m_waiting_for_click = false;

    std::vector<ControllerCommand> m_commands;
};

} // namespace noveltea::core
