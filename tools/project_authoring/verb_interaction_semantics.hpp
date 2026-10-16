#pragma once

#include "character_archetype_semantics.hpp"

#include <set>

namespace noveltea::authoring {

// The generated contract owns structure and Verb's native Zod refinements.
// These checks operate on effective records; source remains untouched.
ValidationResult validate_verb_interaction_local(std::string_view family,
                                                 std::string_view record_json);

ValidationResult validate_verb_interaction_dependencies(
    std::string_view family, std::string_view record_json, std::string_view manifest_json,
    std::string_view traits_json, const AuthoringRecordResolver& resolve,
    const std::function<bool(std::string_view, std::string_view)>& exists);

// Workspace Manifest owns the final fallback Interaction program.
ValidationResult validate_project_interaction_program(
    std::string_view manifest_json, std::string_view traits_json,
    const AuthoringRecordResolver& resolve,
    const std::function<bool(std::string_view, std::string_view)>& exists);

// Cross-record resolver diagnostics are attributed to the rule owner, not the
// record whose mutation made the relationship invalid.
ValidationResult validate_interaction_resolver(
    const std::vector<std::pair<std::string, std::string>>& interaction_records);

} // namespace noveltea::authoring
