#pragma once

#include "character_archetype_semantics.hpp"
#include <set>

namespace noveltea::authoring {

// Definition-local quantity and identity-bearing child invariants. The input
// is an effective (potentially Archetype-resolved) Interactable record.
ValidationResult validate_interactable_definition_local(std::string_view record_json);

// The manifest is the single physical owner of exact Interactable Instances.
// Referenced record sources remain independently owned by their YAML files.
ValidationResult validate_interactable_inventory_project(
    std::string_view manifest_json, const AuthoringRecordResolver& resolve,
    std::string_view traits_json,
    const std::function<bool(std::string_view, std::string_view)>& exists,
    const std::set<std::string>& affected_instances);

} // namespace noveltea::authoring
