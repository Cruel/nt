#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>
#include <string>
#include <string_view>

namespace noveltea::authoring {
class ProjectSession;
}

// Certification-only native workflow for named Message targets. Structured,
// free-form and ambiguous Message identity stays a separately certified source
// reconciliation responsibility.
nlohmann::json native_project_localization(const nlohmann::json& request,
                                           noveltea::authoring::ProjectSession& session,
                                           const std::filesystem::path& root);
nlohmann::json native_project_localization_view(const nlohmann::json& request,
                                                noveltea::authoring::ProjectSession& session,
                                                bool validated_preparation = false);

// Pure authoring Message freshness contract shared by native localization
// editing and cold runtime export diagnostics.
std::string native_authoring_message_semantic_fingerprint(const nlohmann::json& message);
std::string native_authoring_rml_semantic_fingerprint(std::string_view text);
