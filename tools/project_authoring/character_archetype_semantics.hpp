#pragma once

#include "contracts.hpp"

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {

// The generated contracts own shapes and defaults; these operations cover the
// Character/Archetype invariants that are contextual rather than structural.
using AuthoringRecordResolver =
    std::function<std::optional<std::string>(std::string_view family, std::string_view id)>;

ValidationResult validate_character_local(std::string_view normalized_record);
ValidationResult validate_archetype_local(std::string_view normalized_record);
ValidationResult validate_character_dependencies(std::string_view normalized_record,
                                                 const AuthoringRecordResolver& resolve);
ValidationResult validate_archetype_dependencies(std::string_view archetype_id,
                                                 std::string_view normalized_record,
                                                 const AuthoringRecordResolver& resolve);
ValidationResult validate_archetype_owner(std::string_view family,
                                          std::string_view normalized_record,
                                          const AuthoringRecordResolver& resolve);

// Resource semantics live in other migration tickets. If their structural
// contract is blocked *only* by registered-but-unimplemented native operations,
// supply the explicitly authored source view for Character reference checks.
// Do not turn the resource owner's own validation green or accept other errors.
std::optional<std::string>
character_reference_resource_source(std::string_view family, std::string_view source_json,
                                    const std::vector<Diagnostic>& diagnostics);

} // namespace noveltea::authoring
