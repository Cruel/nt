#pragma once

#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/runtime_controller.hpp>

namespace noveltea::core {

struct RuntimeUIOption {
    std::string text;
    bool enabled = true;
};

struct RuntimeUIObject {
    std::string id;
    std::string name;
    bool in_room = false;
    bool in_inventory = false;
};

struct RuntimeUIAction {
    std::string verb_id;
    std::string label;
    int object_count = 0;
};

struct RuntimeUIViewState {
    std::string mode = "idle";
    std::string title;
    std::string body;
    std::string notification;
    std::vector<RuntimeUIOption> dialogue_options;
    std::vector<std::string> navigation;
    std::vector<RuntimeUIObject> objects;
    std::vector<RuntimeUIAction> actions;
    std::vector<std::string> text_log;
    bool awaiting_continue = false;
    bool page_break = false;
};

class RuntimeUIViewAdapter {
public:
    void reset();
    void apply(const ControllerCommand& command);
    void apply(const std::vector<ControllerCommand>& commands);
    void set_room_interactions(std::vector<RuntimeUIObject> objects,
                               std::vector<RuntimeUIAction> actions);

    [[nodiscard]] const RuntimeUIViewState& state() const noexcept { return m_state; }

private:
    void apply_options(const nlohmann::json& options);
    void apply_navigation(const nlohmann::json& data);
    void push_log_line(std::string line);

    RuntimeUIViewState m_state;
};

} // namespace noveltea::core
