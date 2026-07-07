#pragma once

#include "noveltea/core/runtime_io.hpp"

#include <string>

namespace noveltea {

class RuntimeShell;

struct RuntimeDebugMutationResult {
    std::string event_json;
    core::RuntimeInputResult runtime_result;
    bool has_runtime_result = false;
};

std::string runtime_debug_set_variable(RuntimeShell& shell, const std::string& variable_id,
                                       const std::string& value_json);
std::string runtime_debug_reset_variable(RuntimeShell& shell, const std::string& variable_id);
std::string runtime_debug_give_object(RuntimeShell& shell, const std::string& object_id);
std::string runtime_debug_remove_inventory_object(RuntimeShell& shell,
                                                  const std::string& object_id);
RuntimeDebugMutationResult runtime_debug_teleport_room(RuntimeShell& shell,
                                                       const std::string& room_id);

} // namespace noveltea
