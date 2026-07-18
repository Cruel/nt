#include <noveltea/engine.hpp>

#include "public_header_probe_guard.hpp"

#include <type_traits>

static_assert(std::is_class_v<noveltea::Engine>);
static_assert(std::is_default_constructible_v<noveltea::EngineConfig>);
