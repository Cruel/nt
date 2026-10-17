#pragma once

#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/platform.hpp"
#include "noveltea/renderer.hpp"

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::benchmark {

// Runs production source reads / Compiled Project decoding headlessly, or a
// real typed image request through the production Renderer and AssetManager.
class AssetScenario final : public Scenario {
public:
    explicit AssetScenario(std::string_view id) : id_(id) {}
    ~AssetScenario() override;

    const char* id() const override { return id_.c_str(); }
    const char* description() const override;
    bool requires_graphics() const override { return id_ == "asset-texture-realize"; }
    bool prepare(const Options& options, std::string& reason) override;
    Readiness readiness(std::string& reason) override;
    bool frame(std::string& reason) override;
    void diagnostic_frame(DiagnosticObservation& observation) override;
    bool complete(std::string& reason) override;
    bool cleanup(std::string& reason) override;
    Interruption interruption() const override { return interruption_; }
    const Environment& environment() const { return environment_; }

private:
    void mount_assets();
    bool load_texture(uint32_t index, std::string& reason);
    bool initialize_graphics(const Options& options, std::string& reason);

    std::string id_;
    Platform platform_;
    Renderer renderer_;
    assets::AssetManager assets_;
    std::unique_ptr<jobs::InlineJobExecutor> executor_;
    std::shared_ptr<assets::AssetResidencyManager> residency_;
    std::vector<assets::AssetLease<assets::TextureAsset>> resident_;
    Environment environment_;
    uint32_t work_units_ = 1;
    uint64_t batches_ = 0;
    bool ready_ = false;
    bool cold_ = false;
    Interruption interruption_ = Interruption::None;
};

} // namespace noveltea::benchmark
