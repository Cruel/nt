#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>

namespace noveltea::authoring {
class ProjectSession;
}

// Certification-only portable source bundle transport. It deliberately does
// not publish compiled runtime artifacts or include session-local dirty state.
nlohmann::json native_project_bundle(const nlohmann::json& request,
                                     noveltea::authoring::ProjectSession* session,
                                     const std::filesystem::path& root);
