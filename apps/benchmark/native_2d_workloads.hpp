#pragma once

#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/render/quad_batch.hpp"
#include "noveltea/renderer.hpp"

#include <bgfx/bgfx.h>

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::benchmark {

// Runs the production NovelTea Renderer and TextEngine without Engine/RmlUi tick overhead.
struct Native2DReference {
    QuadBatch quads;
    std::string text;
    std::string alternate_text;
};

// Pure, deterministic reference content reused unchanged through warmup and measurement.
[[nodiscard]] Native2DReference make_native_2d_reference(uint32_t quad_count, uint32_t glyph_count,
                                                         int width, int height);

class Native2DScenario final : public Scenario {
public:
    explicit Native2DScenario(std::string_view scenario) : id_(scenario) {}
    ~Native2DScenario() override;

    const char* id() const override { return id_.c_str(); }
    const char* description() const override;
    bool requires_graphics() const override { return true; }
    bool prepare(const Options& options, std::string& reason) override;
    Readiness readiness(std::string& reason) override;
    bool frame(std::string& reason) override;
    void diagnostic_frame(DiagnosticObservation& observation) override;
    bool complete(std::string& reason) override;
    bool inspect(const Options& options, std::string& reason);
    bool cleanup(std::string& reason) override;
    Interruption interruption() const override { return interruption_; }
    const Environment& environment() const noexcept { return environment_; }

private:
    std::string id_;
    Platform platform_;
    assets::AssetManager assets_;
    Renderer renderer_;
    Native2DReference reference_;
    bgfx::TextureHandle texture_ = BGFX_INVALID_HANDLE;
    FontHandle font_{};
    Text label_;
    TextLayout static_layout_;
    TextLayout dynamic_layout_;
    bool dynamic_ = false;
    uint64_t frame_number_ = 0;
    Interruption interruption_ = Interruption::None;
    Environment environment_;
};

} // namespace noveltea::benchmark
