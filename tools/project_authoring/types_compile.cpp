#include "generated/project_types.hpp"

#include <type_traits>

static_assert(std::is_default_constructible_v<noveltea::authoring::generated::Project>);
static_assert(std::is_default_constructible_v<noveltea::authoring::generated::MapsRecord>);
static_assert(std::is_default_constructible_v<noveltea::authoring::generated::Condition>);
