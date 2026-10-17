#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>

namespace noveltea::authoring {
class ProjectSession;
}

// Certification-only native workflow for named Message targets. Structured,
// free-form and ambiguous Message identity stays a separately certified source
// reconciliation responsibility.
nlohmann::json native_project_localization(const nlohmann::json& request,
                                           noveltea::authoring::ProjectSession& session,
                                           const std::filesystem::path& root);
