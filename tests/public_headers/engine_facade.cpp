#include <noveltea/engine.hpp>

#include "public_header_probe_guard.hpp"

#include <type_traits>

template<typename T>
concept HasToolingSurface = requires(T value) {
    value.request_screenshot("capture.png");
    value.set_preview_running(true);
    value.set_show_fps_counter(true);
    value.set_fps_cap(60);
    value.runtime_preview();
    value.preview_running();
};

static_assert(std::is_class_v<noveltea::Engine>);
static_assert(std::is_default_constructible_v<noveltea::EngineConfig>);
static_assert(!HasToolingSurface<noveltea::Engine>);
