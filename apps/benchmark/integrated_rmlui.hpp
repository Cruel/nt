#pragma once

#include "benchmark_report.hpp"
#include "benchmark_runner.hpp"

#include <memory>
#include <string>

namespace noveltea {
class Engine;
}

namespace noveltea::benchmark {

// Unlike the standalone adapter, this scenario uses the production Engine,
// RuntimeUI, RmlUiHost, and renderer. Engine owns the SDL window and bgfx device.
class IntegratedRmlUi final : public Scenario {
public:
    explicit IntegratedRmlUi(bool controlled);
    ~IntegratedRmlUi() override;

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
    bool controlled_;
    std::unique_ptr<Engine> engine_;
    Environment environment_;
    Interruption last_interruption_ = Interruption::None;
};

} // namespace noveltea::benchmark
