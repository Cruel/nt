#pragma once

#include "../project_authoring/localization_semantics.hpp"

#include <nlohmann/json.hpp>

#include <filesystem>
#include <map>
#include <vector>
#include <string>
#include <string_view>

namespace noveltea::authoring {
class ProjectSession;
}

// Read-only managed-source discovery shared by native sync and CLI views.
std::vector<noveltea::authoring::NativeLocalizationTrackingSource>
native_project_localization_sources(noveltea::authoring::ProjectSession& session,
                                    bool validated_preparation = false);

std::string
native_project_source_generation(const noveltea::authoring::ProjectSession& session,
                                 const std::filesystem::path& root, bool observed_at_entry = false,
                                 std::string_view proof_phase = "generation",
                                 std::map<std::string, std::string>* exact_revisions = nullptr);
bool native_project_source_generation_is_current(const std::filesystem::path& root,
                                                 std::string_view expected);

// Native, deterministic source identity reconciliation. A native working
// Project session and its physical source authority own the transaction.
nlohmann::json native_project_localization_sync(const nlohmann::json& request,
                                                noveltea::authoring::ProjectSession& session,
                                                const std::filesystem::path& root);
nlohmann::json native_project_localization_reconcile(const nlohmann::json& request,
                                                     noveltea::authoring::ProjectSession& session,
                                                     const std::filesystem::path& root);
