#pragma once

#include "character_archetype_semantics.hpp"

namespace noveltea::authoring {

// Runs after the generated Test contract has normalized sparse source fields.
ValidationResult validate_test_local(std::string_view record_json);

// Resolve Test references against the active dirty Project, not disk snapshots.
ValidationResult
validate_test_dependencies(std::string_view record_json, std::string_view manifest_json,
                           std::string_view traits_json, const AuthoringRecordResolver& resolve,
                           const std::function<bool(std::string_view, std::string_view)>& exists);

} // namespace noveltea::authoring
