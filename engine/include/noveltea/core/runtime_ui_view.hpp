#pragma once

#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/game_session.hpp>
#include <noveltea/core/runtime_controller.hpp>
#include <noveltea/core/rich_text.hpp>

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

struct RuntimeUIMapRoom {
    std::string name;
    std::vector<std::string> room_ids;
    std::string visibility_script;
    int left = 0;
    int top = 0;
    int width = 0;
    int height = 0;
    int style = 0;
    int navigation_index = -1;
    bool visible = false;
    bool current = false;
    bool enabled = false;
};

struct RuntimeUIMapConnection {
    int room_start = 0;
    int room_end = 0;
    int port_start_x = 0;
    int port_start_y = 0;
    int port_end_x = 0;
    int port_end_y = 0;
    std::string visibility_script;
    int style = 0;
    bool visible = false;
};

struct RuntimeUIMapView {
    std::string map_id;
    std::string current_room_id;
    std::string default_room_script;
    std::string default_path_script;
    int min_x = 0;
    int min_y = 0;
    int max_x = 0;
    int max_y = 0;
    bool available = false;
    bool enabled = false;
    std::vector<RuntimeUIMapRoom> rooms;
    std::vector<RuntimeUIMapConnection> connections;
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
    RuntimeUIMapView map_view;
    RichTextDocument active_text;
    float active_text_reveal_progress = 1.0f;
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
    void sync_map(const GameSession& session);

    [[nodiscard]] const RuntimeUIViewState& state() const noexcept { return m_state; }

private:
    void apply_options(const nlohmann::json& options);
    void apply_navigation(const nlohmann::json& data);
    void push_log_line(std::string line);

    RuntimeUIViewState m_state;
};

} // namespace noveltea::core
