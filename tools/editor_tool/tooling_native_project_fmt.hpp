#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>

namespace noveltea::authoring {
class ProjectSession;
}

// Certification-only, conservative sparse-default compaction through the
// native YAML transaction owner. Never rewrites annotated or unknown fields.
nlohmann::json native_project_strip_defaults(const nlohmann::json& request,
                                             noveltea::authoring::ProjectSession& session,
                                             const std::filesystem::path& root);
