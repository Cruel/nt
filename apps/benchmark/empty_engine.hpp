#pragma once

#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"

#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

namespace noveltea {
class Engine;
}

namespace noveltea::benchmark {

// Engine owns SDL, its window, bgfx and all production rendering services.
// Each mode uses the same production Engine tick; only its loaded content differs.
enum class EngineWorkload {
    EmptyEngine,
    EmptyProject,
    StaticMenu,
    FeatureLab
};

[[nodiscard]] inline bool is_compiled_project_scenario(std::string_view id)
{
    return id == "engine-compiled-empty" || id == "engine-compiled-menu" ||
           id == "engine-feature-lab";
}

[[nodiscard]] inline EngineWorkload engine_workload(std::string_view id)
{
    return id == "engine-compiled-empty"  ? EngineWorkload::EmptyProject
           : id == "engine-compiled-menu" ? EngineWorkload::StaticMenu
           : id == "engine-feature-lab"   ? EngineWorkload::FeatureLab
                                          : EngineWorkload::EmptyEngine;
}

class EmptyEngine final : public Scenario {
public:
    explicit EmptyEngine(std::filesystem::path system_asset_root = {},
                         EngineWorkload workload = EngineWorkload::EmptyEngine);
    ~EmptyEngine() override;

    const char* id() const override;
    const char* description() const override;
    bool requires_graphics() const override { return true; }
    bool prepare(const Options& options, std::string& reason) override;
    Readiness readiness(std::string& reason) override;
    bool frame(std::string& reason) override;
    void diagnostic_frame(DiagnosticObservation& observation) override;
    bool complete(std::string& reason) override;
    bool cleanup(std::string& reason) override;
    Interruption interruption() const override { return last_interruption_; }

    const Environment& environment() const { return environment_; }

private:
    std::filesystem::path system_asset_root_;
    EngineWorkload workload_;
    std::unique_ptr<Engine> engine_;
    Environment environment_;
    Interruption last_interruption_ = Interruption::None;
};

} // namespace noveltea::benchmark
