#pragma once

#include "contracts.hpp"
#include "source_analysis.hpp"

#include <filesystem>
#include <map>
#include <string>

namespace noveltea::authoring {
// Assemble and validate the tracked split i18n sources as one effective Project
// localization model. Overlays are JSON source values from dirty native owners;
// they are never persisted by reading or validating this model.
ValidationResult
validate_project_localization(const std::filesystem::path& project_root,
                              const std::map<std::string, std::string>& source_overlays = {},
                              const std::map<std::string, std::string>& record_overlays = {},
                              const std::map<std::string, SourceAnalysis>& working_sources = {});
} // namespace noveltea::authoring
