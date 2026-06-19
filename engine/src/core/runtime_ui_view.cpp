#include <noveltea/core/runtime_ui_view.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <utility>

namespace noveltea::core {

namespace {
constexpr std::size_t kMaxTextLogLines = 64;

std::string json_string_or(const nlohmann::json& value, const char* key, std::string fallback = {})
{
    const auto it = value.find(key);
    return it != value.end() && it->is_string() ? it->get<std::string>() : std::move(fallback);
}
}

void RuntimeUIViewAdapter::reset()
{
    m_state = RuntimeUIViewState{};
}

void RuntimeUIViewAdapter::apply(const std::vector<ControllerCommand>& commands)
{
    for (const auto& command : commands) {
        apply(command);
    }
}

void RuntimeUIViewAdapter::apply(const ControllerCommand& command)
{
    switch (command.type) {
    case ControllerCommandType::ModeChanged:
        m_state.mode = json_string_or(command.data, "mode", m_state.mode);
        m_state.dialogue_options.clear();
        if (m_state.mode != "room") {
            m_state.objects.clear();
            m_state.actions.clear();
        }
        m_state.awaiting_continue = false;
        m_state.page_break = false;
        break;
    case ControllerCommandType::RoomEntry:
        m_state.mode = "room";
        m_state.title = json_string_or(command.data, "name", command.text);
        m_state.dialogue_options.clear();
        m_state.awaiting_continue = false;
        m_state.page_break = false;
        break;
    case ControllerCommandType::RoomDescription:
        m_state.mode = "room";
        m_state.body = json_string_or(command.data, "text", command.text);
        m_state.dialogue_options.clear();
        m_state.page_break = false;
        break;
    case ControllerCommandType::NavigationUpdate:
        apply_navigation(command.data);
        break;
    case ControllerCommandType::Notification:
        m_state.notification = command.text;
        break;
    case ControllerCommandType::TextLogged: {
        const std::string name = json_string_or(command.data, "name");
        push_log_line(name.empty() ? command.text : name + ": " + command.text);
        break;
    }
    case ControllerCommandType::DialogueText:
        m_state.mode = "dialogue";
        m_state.title = json_string_or(command.data, "name");
        m_state.body = json_string_or(command.data, "text", command.text);
        m_state.objects.clear();
        m_state.actions.clear();
        m_state.awaiting_continue = command.data.value("wait_for_click", false);
        m_state.page_break = false;
        break;
    case ControllerCommandType::DialogueOptions:
        apply_options(command.data.value("options", nlohmann::json::array()));
        m_state.awaiting_continue = false;
        break;
    case ControllerCommandType::DialogueComplete:
        m_state.mode = "idle";
        m_state.dialogue_options.clear();
        m_state.awaiting_continue = false;
        break;
    case ControllerCommandType::CutsceneText:
        m_state.mode = "cutscene";
        m_state.title.clear();
        m_state.body = json_string_or(command.data, "text", command.text);
        m_state.dialogue_options.clear();
        m_state.objects.clear();
        m_state.actions.clear();
        m_state.awaiting_continue = command.data.value("wait_for_click", false);
        m_state.page_break = false;
        break;
    case ControllerCommandType::CutscenePageBreak:
        m_state.mode = "cutscene";
        m_state.page_break = true;
        m_state.awaiting_continue = true;
        break;
    case ControllerCommandType::CutsceneComplete:
        m_state.mode = "idle";
        m_state.awaiting_continue = false;
        m_state.page_break = false;
        break;
    case ControllerCommandType::ActionResolved:
        m_state.notification = "Action resolved";
        break;
    case ControllerCommandType::ActionRejected:
        m_state.notification = command.text.empty() ? "Action unavailable" : command.text;
        break;
    case ControllerCommandType::ScriptDeferred:
        break;
    }
}

void RuntimeUIViewAdapter::set_room_interactions(std::vector<RuntimeUIObject> objects,
                                                 std::vector<RuntimeUIAction> actions)
{
    m_state.objects = std::move(objects);
    m_state.actions = std::move(actions);
}

void RuntimeUIViewAdapter::apply_options(const nlohmann::json& options)
{
    m_state.dialogue_options.clear();
    if (!options.is_array()) return;
    for (const auto& option : options) {
        if (!option.is_object()) continue;
        RuntimeUIOption out;
        out.text = json_string_or(option, "text");
        out.enabled = option.value("enabled", true);
        m_state.dialogue_options.push_back(std::move(out));
    }
}

void RuntimeUIViewAdapter::apply_navigation(const nlohmann::json& data)
{
    m_state.navigation.clear();
    static constexpr std::array<const char*, 4> keys = {"north", "east", "south", "west"};
    for (const char* key : keys) {
        if (data.value(key, false)) {
            m_state.navigation.emplace_back(key);
        }
    }

    const auto paths = data.find("paths");
    if (paths != data.end() && paths->is_array()) {
        for (const auto& path : *paths) {
            if (path.is_string()) {
                m_state.navigation.push_back(path.get<std::string>());
            } else if (path.is_object()) {
                auto label = json_string_or(path, "label");
                if (label.empty()) label = json_string_or(path, "direction");
                if (label.empty()) label = json_string_or(path, "target_id");
                if (!label.empty() && path.value("enabled", true)) {
                    m_state.navigation.push_back(std::move(label));
                }
            }
        }
    }
}

void RuntimeUIViewAdapter::push_log_line(std::string line)
{
    if (line.empty()) return;
    m_state.text_log.push_back(std::move(line));
    if (m_state.text_log.size() > kMaxTextLogLines) {
        m_state.text_log.erase(m_state.text_log.begin(),
                               m_state.text_log.begin() + static_cast<std::ptrdiff_t>(m_state.text_log.size() - kMaxTextLogLines));
    }
}

} // namespace noveltea::core
