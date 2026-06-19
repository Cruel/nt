#include <noveltea/core/dialogue_controller.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <sstream>

namespace noveltea::core {

DialogueController::DialogueController(GameSession& session)
    : m_session(&session)
{
}

void DialogueController::start(const std::string& dialogue_id)
{
    m_dialogue_id = dialogue_id;
    m_current_segment_index = -1;
    m_next_forced_segment_index = -1;
    m_text_line_index = -1;
    m_complete = false;
    m_waiting_for_text = false;
    m_waiting_for_choice = false;
    m_current_text_logged = false;
    m_current_name.clear();
    m_current_text.clear();
    m_text_lines.clear();
    m_options.clear();
    m_shown_segments.clear();
    m_commands.clear();

    if (auto* project = m_session->project()) {
        auto it = project->dialogues().find(dialogue_id);
        if (it != project->dialogues().end()) {
            m_dialogue = &it->second;
            m_next_forced_segment_index = m_dialogue->root_index;
        }
    }

    tick(0.0);
}

void DialogueController::continue_to_next()
{
    if (m_complete || m_waiting_for_choice)
        return;

    if (m_text_line_index + 1 < static_cast<int>(m_text_lines.size())) {
        change_line(m_text_line_index + 1);
    } else if (!m_waiting_for_choice) {
        change_segment(m_next_forced_segment_index);
    }
}

bool DialogueController::select_option(int option_index)
{
    if (m_complete)
        return false;
    if (option_index < 0 || option_index >= static_cast<int>(m_options.size()))
        return false;
    auto& opt = m_options[option_index];
    if (!opt.enabled)
        return false;

    if (opt.show_once)
        m_shown_segments.insert(opt.target_segment * 1000 + opt.sub_index);

    change_segment(opt.target_segment, true, opt.sub_index);
    return true;
}

void DialogueController::tick(double /*delta_seconds*/)
{
    if (m_complete)
        return;

    if (m_current_segment_index < 0)
        change_segment(m_next_forced_segment_index);
}

void DialogueController::change_segment(int segment_index, bool run_segment, int button_subindex)
{
    if (segment_index < 0) {
        m_complete = true;
        m_waiting_for_text = false;
        m_waiting_for_choice = false;
        m_current_name.clear();
        m_current_text.clear();
        m_text_lines.clear();
        m_options.clear();
        emit_dialogue_complete();
        return;
    }

    if (!m_dialogue)
        return;

    if (segment_index >= static_cast<int>(m_dialogue->segments.size())) {
        m_complete = true;
        emit_dialogue_complete();
        return;
    }

    m_options.clear();
    m_current_segment_index = segment_index;
    m_next_forced_segment_index = -1;
    m_waiting_for_choice = false;
    m_waiting_for_text = false;

    const auto& segments = m_dialogue->segments;
    const auto& start_seg = segments[segment_index];

    const DialogueSegmentModel* text_segment = nullptr;

    if (start_seg.type == 1) {
        text_segment = &start_seg;
    } else {
        if (run_segment && start_seg.script_enabled && !start_seg.script.empty()) {
            nlohmann::json script_data = nlohmann::json::object();
            script_data["button_index"] = button_subindex;
            script_data["autosave"] = start_seg.autosave;
            emit_script_deferred(start_seg.script, script_data.dump());
        }

        if (!start_seg.text_raw.empty()) {
            auto lines = get_option_multiline(start_seg.text_raw);
            if (!lines.empty()) {
                int idx = button_subindex >= 0 && button_subindex < static_cast<int>(lines.size())
                    ? button_subindex : 0;
                emit_script_deferred(
                    lines[idx],
                    "dialogue option text (needs expression eval)");
            }
        }
    }

    if (!text_segment) {
        for (auto child_id : start_seg.children_ids) {
            if (child_id < 0 || child_id >= static_cast<int>(segments.size()))
                continue;
            const auto& seg = segments[child_id];

            if (!passes_condition(seg, -1))
                continue;
            if (seg.show_once && m_shown_segments.count(child_id * 1000) > 0)
                continue;

            text_segment = &seg;
            break;
        }
    }

    if (text_segment) {
        m_current_text_logged = text_segment->is_logged;
        m_text_lines = get_text_multiline(
            evaluate_text(*text_segment, button_subindex),
            m_dialogue->default_name);

        if (run_segment && text_segment->script_enabled && !text_segment->script.empty()) {
            nlohmann::json script_data = nlohmann::json::object();
            script_data["button_index"] = button_subindex;
            script_data["autosave"] = text_segment->autosave;
            emit_script_deferred(text_segment->script, script_data.dump());
        }
    } else {
        m_complete = true;
        emit_dialogue_complete();
        return;
    }

    int before_index = m_current_segment_index;
    gen_options(static_cast<int>(text_segment - segments.data()), true);
    if (m_current_segment_index != before_index)
        return;

    const auto& child_ids = text_segment->children_ids;
    if (child_ids.empty() && text_segment->text_raw.empty() && m_options.empty()) {
        m_complete = true;
        emit_dialogue_complete();
        return;
    }

    change_line(0);
}

void DialogueController::change_line(int line_index)
{
    if (line_index < 0 || line_index >= static_cast<int>(m_text_lines.size()))
        return;

    m_text_line_index = line_index;
    m_current_name = m_text_lines[line_index].first;
    m_current_text = m_text_lines[line_index].second;

    m_waiting_for_text = true;

    emit_dialogue_text();
}

void DialogueController::gen_options(int parent_index, bool is_root)
{
    if (!m_dialogue || parent_index < 0 ||
        parent_index >= static_cast<int>(m_dialogue->segments.size()))
        return;

    const auto& segments = m_dialogue->segments;
    const auto& parent = segments[parent_index];

    bool has_working_option = false;

    for (auto child_id : parent.children_ids) {
        if (child_id < 0 || child_id >= static_cast<int>(segments.size()))
            continue;
        const auto& seg = segments[child_id];

        bool disabled = seg.show_once && m_shown_segments.count(child_id * 1000) > 0;
        if (!disabled && !passes_condition(seg, -1))
            disabled = true;

        if (!m_dialogue->show_disabled_options) {
            if (disabled)
                continue;
        }

        if (seg.text_raw.empty()) {
            if (parent.children_ids.size() == 1) {
                if (is_root)
                    m_next_forced_segment_index = child_id;
                if (seg.show_once)
                    m_shown_segments.insert(child_id * 1000);
                if (is_root && parent.text_raw.empty()) {
                    change_segment(child_id);
                    return;
                }
                break;
            }
            continue;
        }

        auto button_texts = get_option_multiline(seg.text_raw);
        for (int i = 0; i < static_cast<int>(button_texts.size()); ++i) {
            bool opt_disabled = disabled;
            if (seg.show_once) {
                int key = child_id * 1000 + i;
                if (m_shown_segments.count(key) > 0)
                    opt_disabled = true;
            }

            DialogueOptionInfo opt;
            opt.text = button_texts[i];
            opt.target_segment = child_id;
            opt.sub_index = i;
            opt.enabled = m_dialogue->enable_disabled_options || !opt_disabled;
            opt.show_once = seg.show_once;

            if (m_dialogue->enable_disabled_options || !opt_disabled)
                has_working_option = true;

            m_options.push_back(std::move(opt));
        }
    }

    if (is_root && !has_working_option)
        m_options.clear();
}

bool DialogueController::passes_condition(const DialogueSegmentModel& seg, int /*button_subindex*/)
{
    if (!seg.conditional_enabled || seg.condition_script.empty())
        return true;

    emit_script_deferred(seg.condition_script, "dialogue condition evaluation (assumed true)");
    return true;
}

std::string DialogueController::evaluate_text(const DialogueSegmentModel& seg, int /*button_subindex*/)
{
    if (seg.scripted_text && !seg.text_raw.empty()) {
        emit_script_deferred(seg.text_raw, "scripted text evaluation (using raw text)");
        return seg.text_raw;
    }

    return seg.text_raw;
}

std::vector<std::pair<std::string, std::string>>
DialogueController::get_text_multiline(
    const std::string& text_raw, const std::string& default_name)
{
    std::vector<std::pair<std::string, std::string>> result;
    std::istringstream stream(text_raw);
    std::string line;

    while (std::getline(stream, line)) {
        if (line.empty()) {
            continue;
        }
        auto pair = get_line_pair(line, default_name);
        result.push_back(std::move(pair));
    }

    return result;
}

std::pair<std::string, std::string>
DialogueController::get_line_pair(const std::string& line, const std::string& default_name)
{
    std::string name = default_name;
    std::string text = line;

    auto start = line.find('[');
    auto end = line.find(']');
    if (start == 0 && end != std::string::npos && end > start) {
        name = line.substr(start + 1, end - start - 1);
        text = line.substr(end + 1);
        if (!text.empty() && text[0] == ' ')
            text = text.substr(1);
    }

    return {name, text};
}

std::vector<std::string>
DialogueController::get_option_multiline(const std::string& text_raw)
{
    std::vector<std::string> result;
    std::istringstream stream(text_raw);
    std::string line;
    while (std::getline(stream, line)) {
        if (!line.empty())
            result.push_back(line);
    }
    if (result.empty())
        result.push_back(text_raw);
    return result;
}

std::vector<ControllerCommand> DialogueController::take_commands()
{
    auto commands = std::move(m_commands);
    m_commands.clear();
    return commands;
}

void DialogueController::reset()
{
    m_dialogue_id.clear();
    m_dialogue = nullptr;
    m_current_segment_index = -1;
    m_next_forced_segment_index = -1;
    m_text_line_index = -1;
    m_complete = true;
    m_waiting_for_text = false;
    m_waiting_for_choice = false;
    m_current_text_logged = false;
    m_current_name.clear();
    m_current_text.clear();
    m_text_lines.clear();
    m_options.clear();
    m_shown_segments.clear();
    m_commands.clear();
}

nlohmann::json DialogueController::save_state() const
{
    nlohmann::json j = nlohmann::json::object();
    int index = m_next_forced_segment_index;
    if (index < 0)
        index = m_current_segment_index;
    j["segment_index"] = index;
    j["dialogue_id"] = m_dialogue_id;

    nlohmann::json shown = nlohmann::json::array();
    for (auto s : m_shown_segments)
        shown.push_back(s);
    j["shown_segments"] = shown;

    return j;
}

void DialogueController::restore_state(const nlohmann::json& state)
{
    reset();
    auto dialogue_id = state.value("dialogue_id", "");
    if (dialogue_id.empty())
        return;

    start(dialogue_id);
    if (state.contains("shown_segments")) {
        for (const auto& s : state["shown_segments"])
            m_shown_segments.insert(s.get<int>());
    }

    auto segment_index = state.value("segment_index", -1);
    if (segment_index >= 0 && segment_index < static_cast<int>(m_dialogue->segments.size()))
        change_segment(segment_index, false);
}

void DialogueController::emit_script_deferred(
    const std::string& script, const std::string& context_desc)
{
    emit_command(ControllerCommand{
        ControllerCommandType::ScriptDeferred,
        std::nullopt,
        script,
        {{"context", "dialogue"}, {"desc", context_desc}},
    });
}

void DialogueController::emit_dialogue_text()
{
    nlohmann::json data = nlohmann::json::object();
    data["name"] = m_current_name;
    data["text"] = m_current_text;
    data["line_index"] = m_text_line_index;
    data["total_lines"] = m_text_lines.size();
    data["wait_for_click"] = true;

    if (!m_options.empty() && m_text_line_index + 1 == static_cast<int>(m_text_lines.size())) {
        nlohmann::json opts = nlohmann::json::array();
        for (const auto& opt : m_options) {
            nlohmann::json o = nlohmann::json::object();
            o["text"] = opt.text;
            o["enabled"] = opt.enabled;
            opts.push_back(std::move(o));
        }
        data["options"] = std::move(opts);
        m_waiting_for_choice = !m_options.empty();
    }

    emit_command(ControllerCommand{
        ControllerCommandType::DialogueText,
        EntityRef{EntityType::Dialogue, m_dialogue_id},
        m_current_text,
        std::move(data),
    });

    if (m_current_text_logged && !m_current_text.empty()) {
        emit_command(ControllerCommand{
            ControllerCommandType::TextLogged,
            EntityRef{EntityType::Dialogue, m_dialogue_id},
            m_current_text,
            {{"name", m_current_name}, {"dialogue_id", m_dialogue_id}, {"line_index", m_text_line_index}},
        });
    }

    if (m_waiting_for_choice) {
        emit_dialogue_options();
    }
}

void DialogueController::emit_dialogue_options()
{
    nlohmann::json opts = nlohmann::json::array();
    for (const auto& opt : m_options) {
        nlohmann::json o = nlohmann::json::object();
        o["text"] = opt.text;
        o["enabled"] = opt.enabled;
        o["target_segment"] = opt.target_segment;
        o["sub_index"] = opt.sub_index;
        o["show_once"] = opt.show_once;
        opts.push_back(std::move(o));
    }

    emit_command(ControllerCommand{
        ControllerCommandType::DialogueOptions,
        EntityRef{EntityType::Dialogue, m_dialogue_id},
        m_dialogue_id,
        {{"options", std::move(opts)}},
    });
}

void DialogueController::emit_dialogue_complete()
{
    nlohmann::json data = nlohmann::json::object();
    if (m_dialogue && m_dialogue->next_entity.has_value()) {
        data["next_entity_type"] = to_integer(m_dialogue->next_entity->type);
        data["next_entity_id"] = m_dialogue->next_entity->id;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::DialogueComplete,
        EntityRef{EntityType::Dialogue, m_dialogue_id},
        m_dialogue_id,
        std::move(data),
    });
}

void DialogueController::emit_command(ControllerCommand cmd)
{
    m_commands.push_back(std::move(cmd));
}

} // namespace noveltea::core
