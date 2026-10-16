#pragma once

#include "character_archetype_semantics.hpp"

#include <filesystem>

namespace noveltea::authoring {

// These checks complement generated Zod contracts. No binary Asset bytes are opened.
ValidationResult validate_asset_local(std::string_view normalized_record,
                                      const std::filesystem::path& project_root);
ValidationResult validate_animation_local(std::string_view normalized_record);
ValidationResult validate_animation_dependencies(std::string_view normalized_record,
                                                 const AuthoringRecordResolver& resolve);
ValidationResult validate_project_asset_aliases(const std::filesystem::path& project_root,
                                                const AuthoringRecordResolver& resolve);
ValidationResult validate_asset_localizations(const std::filesystem::path& project_root,
                                              const AuthoringRecordResolver& resolve);

} // namespace noveltea::authoring
