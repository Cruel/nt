#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>

namespace noveltea::authoring {
class ProjectSession;
}

// Native disk-authoritative entity transaction seam. Never called by the
// production CLI until the #474 coordinated cutover.
nlohmann::json native_project_entity(const nlohmann::json& request,
                                    noveltea::authoring::ProjectSession& session,
                                    const std::filesystem::path& root);
