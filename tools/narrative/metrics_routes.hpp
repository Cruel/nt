#pragma once

#include "catalog_internal.hpp"

namespace noveltea::narrative {
// Route accounting is an optional consumer of the canonical progression search;
// it never provides a second Event interpreter or modifies validate's hot path.
Json route_metrics(const Catalog& catalog, const Json& coverage);
} // namespace noveltea::narrative
