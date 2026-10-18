#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>
#include <optional>
#include <string>

namespace noveltea::authoring {
class ProjectSession;
}

// Scoped read-only asset inventory: it deliberately does not admit unrelated
// Project record families, unlike mutation and full-Project validation.
nlohmann::json native_project_asset_audit(const std::filesystem::path& root);
// Native Asset import owns source checks, metadata projection and a single
// revision-checked YAML transaction. File installation is staged beforehand.
nlohmann::json native_project_asset_import(const nlohmann::json& request,
                                          noveltea::authoring::ProjectSession& session,
                                          const std::filesystem::path& root);
std::optional<std::string> native_project_asset_recover(const std::filesystem::path& root);
