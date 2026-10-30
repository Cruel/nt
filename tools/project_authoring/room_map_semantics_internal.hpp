#pragma once

#include "contracts.hpp"

#include <jsoncons/json.hpp>

namespace noveltea::authoring {

// Internal native Project seam: no serialized JSON round-trip or redundant
// schema validation. Every Room/Map record must already be normalized by its
// owning session; the public validate_room_map_project retains strict admission.
ValidationResult validate_normalized_room_map_project(const jsoncons::ojson& project);

} // namespace noveltea::authoring
