#include <noveltea/core/cutscene_controller.hpp>

#include <nlohmann/json.hpp>

#include <sstream>
#include <vector>

namespace noveltea::core {

CutsceneController::CutsceneController(GameSession& session)
    : m_session(&session)
{
}

void CutsceneController::start(const std::string& cutscene_id)
{
    m_cutscene_id = cutscene_id;
    m_segment_index = 0;
    m_time_to_next = 0.0;
    m_complete = false;
    m_waiting_for_click = false;
    m_commands.clear();
    m_expanded_segments.clear();

    if (auto* project = m_session->project()) {
        auto it = project->cutscenes().find(cutscene_id);
        if (it != project->cutscenes().end()) {
            m_cutscene = &it->second;
            expand_timeline();
            advance_to_segment(0);
        } else {
            m_complete = true;
        }
    } else {
        m_complete = true;
    }
}

void CutsceneController::click()
{
    if (m_waiting_for_click) {
        m_waiting_for_click = false;
        advance_to_segment(m_segment_index + 1);
    }
}

void CutsceneController::tick(double delta_seconds)
{
    if (m_complete || m_waiting_for_click || m_expanded_segments.empty())
        return;

    double speed = m_cutscene ? m_cutscene->speed_factor : 1.0;
    delta_seconds *= speed;

    while (delta_seconds >= m_time_to_next) {
        if (m_waiting_for_click)
            break;
        if (m_segment_index >= m_expanded_segments.size())
            break;

        delta_seconds -= m_time_to_next;

        auto& seg = m_expanded_segments[m_segment_index];
        if (!passes_condition(seg)) {
            advance_to_segment(m_segment_index + 1);
            continue;
        }

        if (seg.type == 3) {
            auto& record = seg.record;
            std::string script;
            bool autosave_before = false;
            bool autosave_after = false;
            if (record.is_array() && record.size() > 1) {
                script = record[1].get<std::string>();
                if (record.size() > 2)
                    autosave_before = record[2].get<bool>();
                if (record.size() > 3)
                    autosave_after = record[3].get<bool>();
            }
            if (!script.empty()) {
                nlohmann::json script_data = nlohmann::json::object();
                script_data["autosave_before"] = autosave_before;
                script_data["autosave_after"] = autosave_after;
                emit_script_deferred(script, script_data.dump());
            }
        }

        m_segment_index = m_segment_index + 1;

        if (m_segment_index >= m_expanded_segments.size()) {
            m_complete = true;
            emit_cutscene_complete();
            return;
        }

        m_time_to_next = 0.0;

        auto& next_seg = m_expanded_segments[m_segment_index];
        if (next_seg.type == 0 || next_seg.type == 1) {
            auto& rec = next_seg.record;
            if (rec.is_array() && rec.size() > 4) {
                double delay = rec[4].get<double>() / 1000.0;
                m_time_to_next = delay;
            }
        }
    }

    if (!m_waiting_for_click) {
        m_time_to_next -= delta_seconds;
    }
}

void CutsceneController::expand_timeline()
{
    if (!m_cutscene)
        return;

    for (const auto& seg : m_cutscene->segments) {
        if (seg.type == 2) {
            auto expanded = expand_page_segment(seg);
            m_expanded_segments.insert(
                m_expanded_segments.end(),
                expanded.begin(),
                expanded.end());
        } else {
            m_expanded_segments.push_back(seg);
        }
    }
}

std::vector<CutsceneSegmentModel>
CutsceneController::expand_page_segment(const CutsceneSegmentModel& page_seg)
{
    std::vector<CutsceneSegmentModel> result;

    auto& record = page_seg.record;
    if (!record.is_array() || record.size() < 4) {
        return result;
    }

    std::string text = record[2].get<std::string>();
    std::string text_delimiter = "\n";
    std::string break_delimiter = "\n\n";
    int text_duration = 1000;
    int text_delay = 2000;
    int break_duration = 2000;
    int break_delay = 3000;
    int text_effect = 0;
    int break_effect = 1;
    bool wait_for_click = true;
    bool can_skip = true;
    bool begin_with_newline = true;
    bool end_with_page_break = true;
    int offset_x = 0;
    int offset_y = 0;

    if (record.size() > 3)
        text_delimiter = record[3].get<std::string>();
    if (record.size() > 4)
        break_delimiter = record[4].get<std::string>();
    if (record.size() > 5)
        text_effect = record[5].get<int>();
    if (record.size() > 6)
        break_effect = record[6].get<int>();
    if (record.size() > 7)
        text_duration = record[7].get<int>();
    if (record.size() > 8)
        text_delay = record[8].get<int>();
    if (record.size() > 9)
        break_duration = record[9].get<int>();
    if (record.size() > 10)
        break_delay = record[10].get<int>();
    if (record.size() > 11)
        can_skip = record[11].get<bool>();
    if (record.size() > 12)
        begin_with_newline = record[12].get<bool>();
    if (record.size() > 13)
        offset_x = record[13].get<int>();
    if (record.size() > 14)
        offset_y = record[14].get<int>();
    if (record.size() > 16)
        end_with_page_break = record[16].get<bool>();

    auto text_pages = [&]() -> std::vector<std::string> {
        std::vector<std::string> pages;
        std::string remaining = text;
        size_t pos = 0;
        while ((pos = remaining.find(break_delimiter)) != std::string::npos) {
            pages.push_back(remaining.substr(0, pos));
            remaining.erase(0, pos + break_delimiter.length());
        }
        if (!remaining.empty())
            pages.push_back(remaining);
        return pages;
    }();

    for (int i = 0; i < static_cast<int>(text_pages.size()); ++i) {
        if (i > 0) {
            CutsceneSegmentModel break_seg;
            break_seg.type = 1;
            break_seg.record = nlohmann::json::array({
                1,
                break_effect,
                break_duration,
                break_delay,
                can_skip,
                false,
                "",
            });
            result.push_back(std::move(break_seg));
        }

        auto texts = [](const std::string& page, const std::string& delim) -> std::vector<std::string> {
            std::vector<std::string> lines;
            std::string remaining = page;
            size_t pos = 0;
            while ((pos = remaining.find(delim)) != std::string::npos) {
                lines.push_back(remaining.substr(0, pos));
                remaining.erase(0, pos + delim.length());
            }
            if (!remaining.empty())
                lines.push_back(remaining);
            return lines;
        }(text_pages[i], text_delimiter);

        for (const auto& t : texts) {
            CutsceneSegmentModel text_seg;
            text_seg.type = 0;
            text_seg.record = nlohmann::json::array({
                0,
                t,
                wait_for_click,
                can_skip,
                text_effect,
                text_duration,
                text_delay,
                offset_x,
                offset_y,
                begin_with_newline,
                "",
            });
            result.push_back(std::move(text_seg));
        }
    }

    if (end_with_page_break) {
        CutsceneSegmentModel break_seg;
        break_seg.type = 1;
        break_seg.record = nlohmann::json::array({
            1,
            break_effect,
            break_duration,
            break_delay,
            can_skip,
            false,
            "",
        });
        result.push_back(std::move(break_seg));
    }

    return result;
}

void CutsceneController::advance_to_segment(size_t index)
{
    m_segment_index = index;
    m_time_to_next = 0.0;
    m_waiting_for_click = false;

    if (index >= m_expanded_segments.size()) {
        m_complete = true;
        emit_cutscene_complete();
        return;
    }

    const auto& seg = m_expanded_segments[index];

    if (!passes_condition(seg)) {
        advance_to_segment(index + 1);
        return;
    }

    if (seg.type == 0) {
        const auto& rec = seg.record;
        std::string text;
        if (rec.is_array() && rec.size() > 1)
            text = rec[1].get<std::string>();

        if (!text.empty()) {
            emit_cutscene_text(text);
        }

        if (rec.is_array() && rec.size() > 2)
            m_waiting_for_click = rec[2].get<bool>();
        else
            m_waiting_for_click = true;

        if (rec.is_array() && rec.size() > 5) {
            double delay = rec[5].get<double>() / 1000.0;
            m_time_to_next = delay;
        }

        if (!m_waiting_for_click) {
            advance_to_segment(index + 1);
        }
    } else if (seg.type == 1) {
        emit_cutscene_page_break();

        advance_to_segment(index + 1);
    } else if (seg.type == 3) {
        const auto& rec = seg.record;
        if (rec.is_array() && rec.size() > 1) {
            std::string script = rec[1].get<std::string>();
            bool autosave_before = false;
            bool autosave_after = false;
            if (rec.size() > 2)
                autosave_before = rec[2].get<bool>();
            if (rec.size() > 3)
                autosave_after = rec[3].get<bool>();

            if (!script.empty()) {
                nlohmann::json script_data = nlohmann::json::object();
                script_data["autosave_before"] = autosave_before;
                script_data["autosave_after"] = autosave_after;
                emit_script_deferred(script, script_data.dump());
            }
        }

        bool seg_wait_for_click = false;
        if (rec.is_array() && rec.size() > 4)
            seg_wait_for_click = rec[4].get<bool>();

        if (seg_wait_for_click) {
            m_waiting_for_click = true;
        } else {
            advance_to_segment(index + 1);
        }
    }
}

bool CutsceneController::passes_condition(const CutsceneSegmentModel& seg)
{
    auto& rec = seg.record;
    if (!rec.is_array())
        return true;

    std::string condition_script;
    int condition_index = -1;

    switch (seg.type) {
    case 4: condition_index = 15; break; // Page
    case 3: condition_index = 6; break;  // Script
    case 1: condition_index = 6; break;  // PageBreak
    case 0: condition_index = 10; break; // Text
    }

    if (condition_index >= 0 && condition_index < static_cast<int>(rec.size()))
        condition_script = rec[condition_index].get<std::string>();

    if (condition_script.empty())
        return true;

    emit_script_deferred(condition_script, "cutscene condition evaluation (assumed true)");
    return true;
}

std::vector<ControllerCommand> CutsceneController::take_commands()
{
    auto commands = std::move(m_commands);
    m_commands.clear();
    return commands;
}

void CutsceneController::reset()
{
    m_cutscene_id.clear();
    m_cutscene = nullptr;
    m_expanded_segments.clear();
    m_segment_index = 0;
    m_time_to_next = 0.0;
    m_complete = true;
    m_waiting_for_click = false;
    m_commands.clear();
}

nlohmann::json CutsceneController::save_state() const
{
    nlohmann::json j = nlohmann::json::object();
    j["cutscene_id"] = m_cutscene_id;
    j["segment_index"] = static_cast<int>(m_segment_index);
    return j;
}

void CutsceneController::restore_state(const nlohmann::json& state)
{
    reset();
    auto cutscene_id = state.value("cutscene_id", "");
    if (cutscene_id.empty())
        return;

    start(cutscene_id);
    auto segment_index = state.value("segment_index", 0);
    if (segment_index > 0 && segment_index < static_cast<int>(m_expanded_segments.size())) {
        advance_to_segment(static_cast<size_t>(segment_index));
    }
}

void CutsceneController::emit_script_deferred(
    const std::string& script, const std::string& context_desc)
{
    emit_command(ControllerCommand{
        ControllerCommandType::ScriptDeferred,
        std::nullopt,
        script,
        {{"context", "cutscene"}, {"desc", context_desc}},
    });
}

void CutsceneController::emit_cutscene_text(const std::string& text)
{
    nlohmann::json data = nlohmann::json::object();
    data["text"] = text;
    data["segment_index"] = m_segment_index;
    data["total_segments"] = m_expanded_segments.size();
    data["wait_for_click"] = m_waiting_for_click;

    emit_command(ControllerCommand{
        ControllerCommandType::CutsceneText,
        EntityRef{EntityType::Cutscene, m_cutscene_id},
        text,
        std::move(data),
    });
}

void CutsceneController::emit_cutscene_page_break()
{
    nlohmann::json data = nlohmann::json::object();
    data["segment_index"] = m_segment_index;

    emit_command(ControllerCommand{
        ControllerCommandType::CutscenePageBreak,
        EntityRef{EntityType::Cutscene, m_cutscene_id},
        m_cutscene_id,
        std::move(data),
    });
}

void CutsceneController::emit_cutscene_complete()
{
    nlohmann::json data = nlohmann::json::object();
    if (m_cutscene && m_cutscene->next_entity.has_value()) {
        data["next_entity_type"] = to_integer(m_cutscene->next_entity->type);
        data["next_entity_id"] = m_cutscene->next_entity->id;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::CutsceneComplete,
        EntityRef{EntityType::Cutscene, m_cutscene_id},
        m_cutscene_id,
        std::move(data),
    });
}

void CutsceneController::emit_command(ControllerCommand cmd)
{
    m_commands.push_back(std::move(cmd));
}

} // namespace noveltea::core
