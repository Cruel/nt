#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace noveltea::cli {

// The persistent runtime Save Contract deliberately excludes editor metadata,
// localization, graphics settings, and nonpersistent source file details.
// Implements the compiled-project wire v1 projection and canonical hashing.
[[nodiscard]] std::string
compiled_project_save_contract(const nlohmann::json& compiled_project);

} // namespace noveltea::cli
