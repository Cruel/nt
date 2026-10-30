#pragma once

#include "character_archetype_semantics.hpp"

namespace noveltea::authoring {

// Local graph invariants operate on generated-schema normalized records, not
// physical sparse YAML. These checks do not execute any authored programs.
ValidationResult validate_dialogue_scene_local(std::string_view family,
                                               std::string_view normalized_record);

ValidationResult validate_dialogue_scene_entrypoint(std::string_view family,
                                                    std::string_view normalized_record,
                                                    std::string_view manifest_json);

// Project resolution is deliberately lazy: referential checks use the
// authoritative collection inventory and only read dependent Scene inputs.
ValidationResult validate_dialogue_scene_dependencies(
    std::string_view family, std::string_view normalized_record,
    const AuthoringRecordResolver& resolve,
    const std::function<bool(std::string_view, std::string_view)>& exists);

} // namespace noveltea::authoring
