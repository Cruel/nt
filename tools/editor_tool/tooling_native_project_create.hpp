#pragma once

#include <nlohmann/json.hpp>

// Atomic Project creation from the canonical generated blank Workspace codec.
nlohmann::json native_project_create(const nlohmann::json& request);
