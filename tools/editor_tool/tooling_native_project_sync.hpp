#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>

namespace noveltea::authoring {
class ProjectSession;
}

// Native, deterministic source identity reconciliation. A native working
// Project session and its physical source authority own the transaction.
nlohmann::json native_project_localization_sync(const nlohmann::json& request,
                                                noveltea::authoring::ProjectSession& session,
                                                const std::filesystem::path& root);
nlohmann::json native_project_localization_reconcile(const nlohmann::json& request,
                                                     noveltea::authoring::ProjectSession& session,
                                                     const std::filesystem::path& root);
