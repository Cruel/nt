#pragma once

#include "contracts.hpp"

#include <functional>
#include <optional>
#include <string>
#include <string_view>

namespace noveltea::authoring {

// Rehydrate the explicitly permitted sparse Interactable source defaults and
// compact typed refs before applying the generated normalized-record contract.
ValidationResult validate_interactable_source(std::string_view source_json);

// Semantic validation of a normalized Variable, beyond its Zod-generated structure.
ValidationResult validate_variable_semantics(std::string_view record_json);

// Resolve only the references used by an inspected record. The caller supplies its
// dirty working Variables when present, otherwise the specific tracked disk owner.
using VariableResolver = std::function<std::optional<std::string>(std::string_view)>;
ValidationResult validate_property_dependencies(std::string_view family,
                                                std::string_view record_json,
                                                std::string_view traits_json,
                                                const VariableResolver& variables);

ValidationResult validate_interactable_instance(std::string_view instance_json,
                                                std::string_view definition_json,
                                                std::string_view traits_json);

} // namespace noveltea::authoring
