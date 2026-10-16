#pragma once

#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"

#include <filesystem>
#include <memory>
#include <string>

namespace noveltea {
class Engine;
}

namespace noveltea::benchmark {

// Engine owns SDL, its window, bgfx and all production rendering services.
// No Compiled Project or authored UI document is loaded.
class EmptyEngine final : public Scenario {
public:
    explicit EmptyEngine(std::filesystem::path system_asset_root = {});
    ~EmptyEngine() override;

    const char* id() const override { return "engine-empty"; }
    const char* description() const override
    {
        return "real NovelTea Engine::tick without a Compiled Project, gameplay or UI document";
    }
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
    std::unique_ptr<Engine> engine_;
    Environment environment_;
    Interruption last_interruption_ = Interruption::None;
};

} // namespace noveltea::benchmark
