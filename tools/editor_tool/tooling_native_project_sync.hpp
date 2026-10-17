#pragma once

#include "../project_authoring/localization_semantics.hpp"

#include <nlohmann/json.hpp>

#include <filesystem>
#include <vector>

namespace noveltea::authoring {
class ProjectSession;
}

// Read-only managed-source discovery shared by native sync and CLI views.
std::vector<noveltea::authoring::NativeLocalizationTrackingSource>
native_project_localization_sources(noveltea::authoring::ProjectSession& session);

// Native, deterministic source identity reconciliation. A native working
// Project session and its physical source authority own the transaction.
nlohmann::json native_project_localization_sync(const nlohmann::json& request,
                                                noveltea::authoring::ProjectSession& session,
                                                const std::filesystem::path& root);
nlohmann::json native_project_localization_reconcile(const nlohmann::json& request,
                                                     noveltea::authoring::ProjectSession& session,
                                                     const std::filesystem::path& root);
