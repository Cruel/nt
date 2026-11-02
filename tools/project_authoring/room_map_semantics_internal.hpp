#pragma once

#include "contracts.hpp"

#include <jsoncons/json.hpp>
#include <functional>

namespace noveltea::authoring {

// Internal native Project seam: no serialized JSON round-trip or redundant
// schema validation. Every Room/Map record must already be normalized by its
// owning session; the public validate_room_map_project retains strict admission.
ValidationResult validate_normalized_room_map_project(const jsoncons::ojson& project);

// Validate one normalized spatial owner against the resident normalized record
// graph. Record bodies are resolved on demand; the callback must return a
// stable view for the duration of this call (empty means absent/invalid).
using SpatialRecordLookup = std::function<std::string_view(std::string_view owner)>;
ValidationResult validate_normalized_room_map_owner(std::string_view owner,
                                                    std::string_view normalized_json,
                                                    const jsoncons::ojson& normalized_project,
                                                    const SpatialRecordLookup& lookup);

} // namespace noveltea::authoring
