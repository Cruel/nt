#pragma once

#include <noveltea/preview_bridge.hpp>

#include <memory>
#include <string>
#include <vector>

namespace noveltea {

class Engine;

namespace sandbox {

enum class DemoMode {
    None,
    All,
    Render2D,
    TextureSampling,
    RmlUi,
    Text,
};

struct SandboxDemoConfig {
    DemoMode mode = DemoMode::None;
    std::vector<std::string> audio_sfx_paths;
    std::vector<std::string> audio_track_specs;
};

class SandboxDemoHarness final {
public:
    explicit SandboxDemoHarness(Engine& engine);
    ~SandboxDemoHarness();

    SandboxDemoHarness(const SandboxDemoHarness&) = delete;
    SandboxDemoHarness& operator=(const SandboxDemoHarness&) = delete;

    bool initialize(SandboxDemoConfig config);
    void shutdown();
    void submit_frame();

    void set_position(float normalized_x, float normalized_y);
    void reset_position();
    [[nodiscard]] preview_bridge::NormalizedPosition position() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace sandbox
} // namespace noveltea
