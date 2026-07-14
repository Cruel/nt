#pragma once

#include <string>
#include <vector>

namespace noveltea {

class Engine;

class RuntimePreviewController {
public:
    explicit RuntimePreviewController(Engine& engine) noexcept;

    bool load_project(const std::string& logical_path);
    bool reset();
    bool start();
    bool stop();
    bool step(double delta_seconds);

    bool continue_dialogue();
    bool select_dialogue_option(int option_index);
    bool navigate(int direction);
    bool select_object(const std::string& object_id);
    bool clear_object_selection();
    bool run_action(const std::string& verb_id, const std::vector<std::string>& object_ids);

    std::string set_variable(const std::string& variable_id, const std::string& value_json);
    std::string reset_variable(const std::string& variable_id);
    std::string give_object(const std::string& object_id);
    std::string remove_inventory_object(const std::string& object_id);
    std::string teleport_room(const std::string& room_id);

    std::string fast_forward_to_input();
    std::string debug_snapshot() const;

private:
    Engine& m_engine;
};

} // namespace noveltea
