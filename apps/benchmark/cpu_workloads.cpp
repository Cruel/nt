#include "cpu_workloads.hpp"

#include "benchmark_assets.hpp"
#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/data_asset_codec.hpp"
#include "noveltea/runtime/runtime_ports.hpp"

#include <SDL3/SDL.h>

#include <chrono>
#include <cstdint>
#include <string>
#include <utility>

namespace noveltea::benchmark {
namespace {

std::string diagnostic_reason(const core::Diagnostics& diagnostics)
{
    return diagnostics.empty() ? "unknown runtime diagnostic"
                               : diagnostics.front().code + ": " + diagnostics.front().message;
}

} // namespace

class CpuScenario::Sources final : public runtime::ScriptSourcePort {
public:
    [[nodiscard]] core::Result<std::string, runtime::ScriptSourceError>
    read_script_source(std::string_view path) const override
    {
        if (path == "project:/scripts/bootstrap.lua")
            return core::Result<std::string, runtime::ScriptSourceError>::success("return {}\n");
        return core::Result<std::string, runtime::ScriptSourceError>::failure(
            {"unknown benchmark script: " + std::string(path)});
    }

    [[nodiscard]] core::Result<core::PersistableValue, std::string>
    read_data_asset(std::string_view path) const override
    {
        return core::Result<core::PersistableValue, std::string>::failure(
            "CPU benchmark has no data asset: " + std::string(path));
    }
};

class CpuScenario::Presentation final : public runtime::PresentationRuntimePort {
public:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_snapshot(const core::RuntimePresentationSnapshot&) override
    {
        return core::Result<void, core::Diagnostics>::success();
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation&) override
    {
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation&) override
    {
        return core::Result<runtime::PresentationAcceptance, core::Diagnostics>::success({true});
    }

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
    {
        return status_;
    }

    void terminate(core::PresentationCancellationReason) override {}

private:
    core::PresentationCheckpointStatus status_{core::CheckpointStatusRevision::from_number(1), {}};
};

CpuScenario::CpuScenario(CpuWorkload workload) : workload_(workload) {}

CpuScenario::~CpuScenario()
{
    std::string ignored;
    (void)cleanup(ignored);
}

const char* CpuScenario::id() const
{
    switch (workload_) {
    case CpuWorkload::Lua:
        return "cpu-lua";
    case CpuWorkload::RuntimeSession:
        return "cpu-runtime-session";
    case CpuWorkload::FlowPrediction:
        return "cpu-flow-prediction";
    }
    return "";
}

const char* CpuScenario::description() const
{
    switch (workload_) {
    case CpuWorkload::Lua:
        return "Lua 5.5 ScriptRuntime expression invocation; 64 deterministic integer additions "
               "per work unit, no graphics or presentation";
    case CpuWorkload::RuntimeSession:
        return "real RuntimeSession AdvanceTimeInput at fixed 16.667 ms per work unit; "
               "compiled-project-golden/minimal.json, headless presentation port";
    case CpuWorkload::FlowPrediction:
        return "real FlowPredictor projection of compiled-project-golden/minimal.json entrypoint "
               "per work unit, no Lua execution or graphics";
    }
    return "";
}

bool CpuScenario::prepare(const Options& options, std::string& reason)
{
    if (!cleanup(reason))
        return false;
    work_units_ = options.cpu_work_units;
    batches_ = 0;
    if (work_units_ == 0 || work_units_ > 4096) {
        reason = "CPU work units must be in 1..4096";
        return false;
    }

    if (workload_ != CpuWorkload::Lua) {
        const auto path = benchmark_asset_path("compiled-project-minimal.json").string();
        size_t byte_count = 0;
        void* bytes = SDL_LoadFile(path.c_str(), &byte_count);
        if (!bytes || byte_count == 0) {
            SDL_free(bytes);
            reason = "cannot load real compiled-project CPU fixture: " + path;
            return false;
        }
        const std::string text(static_cast<const char*>(bytes), byte_count);
        SDL_free(bytes);
        auto decoded = core::decode_compiled_project_json(text, path);
        if (!decoded) {
            reason = "invalid compiled-project CPU fixture: " + diagnostic_reason(decoded.error());
            return false;
        }
        project_.emplace(std::move(decoded).value());
        if (workload_ == CpuWorkload::FlowPrediction) {
            if (!project_->flow_prediction() || project_->flow_prediction()->slices.empty()) {
                reason = "compiled-project CPU fixture has no generated Flow Prediction Index";
                return false;
            }
            return true;
        }
    }

    sources_ = std::make_unique<Sources>();
    scripts_ = std::make_unique<script::ScriptRuntime>();
    auto initialized = scripts_->initialize({.sources = sources_.get()});
    if (!initialized) {
        reason = "Lua initialization failed: " + initialized.error().message;
        return false;
    }
    if (workload_ == CpuWorkload::Lua) {
        auto loaded =
            scripts_->execute("function benchmark_step() local sum=0 for i=1,64 do sum=sum+i end "
                              "return sum == 2080 end",
                              "cpu-benchmark-lua");
        if (!loaded) {
            reason = "Lua workload definition failed: " + loaded.error().message;
            return false;
        }
        return true;
    }

    auto prepared = scripts_->prepare_project_modules(*project_);
    if (!prepared) {
        reason = "Runtime Session script preparation failed: " + prepared.error().message;
        return false;
    }
    auto bootstrapped = scripts_->run_project_bootstrap();
    if (!bootstrapped) {
        reason = "Runtime Session bootstrap failed: " + bootstrapped.error().message;
        return false;
    }
    auto frozen = scripts_->freeze_project_hooks();
    if (!frozen) {
        reason = "Runtime Session hook freeze failed: " + frozen.error().message;
        return false;
    }

    model_ = std::make_unique<presentation::RuntimePresentationModel>();
    presentation_ = std::make_unique<Presentation>();
    saves_ = std::make_unique<core::TypedMemorySaveSlotStore>();
    save_codec_ = std::make_unique<core::JsonSaveStateCodec>();
    auto created = runtime::RuntimeSession::create(*project_, *scripts_, *model_, *presentation_,
                                                   *saves_, *save_codec_, "en");
    if (!created) {
        reason = "Runtime Session create failed: " + diagnostic_reason(created.error());
        return false;
    }
    session_ = std::move(created).value();
    const auto started = session_->dispatch(core::RuntimeInputMessage{core::StartRuntimeInput{}});
    if (!started.diagnostics.empty() ||
        started.disposition == runtime::RuntimeInputDisposition::Failed) {
        reason = "Runtime Session start failed: " + diagnostic_reason(started.diagnostics);
        return false;
    }
    return true;
}

Readiness CpuScenario::readiness(std::string& reason)
{
    if (workload_ == CpuWorkload::Lua              ? !scripts_
        : workload_ == CpuWorkload::RuntimeSession ? !session_
                                                   : !project_) {
        reason = "CPU workload was not prepared";
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool CpuScenario::frame(std::string& reason)
{
    for (uint32_t unit = 0; unit < work_units_; ++unit) {
        switch (workload_) {
        case CpuWorkload::Lua: {
            auto evaluated = scripts_->evaluate_bool("benchmark_step()", "cpu-benchmark-lua-call");
            if (!evaluated || !evaluated.value()) {
                reason = "Lua workload failed deterministic result check";
                return false;
            }
            break;
        }
        case CpuWorkload::RuntimeSession: {
            const auto result = session_->dispatch(core::RuntimeInputMessage{
                core::AdvanceTimeInput{std::chrono::microseconds{16667}}});
            if (!result.diagnostics.empty() ||
                result.disposition == runtime::RuntimeInputDisposition::Failed) {
                reason =
                    "Runtime Session progression failed: " + diagnostic_reason(result.diagnostics);
                return false;
            }
            break;
        }
        case CpuWorkload::FlowPrediction: {
            const auto projected =
                runtime::FlowPredictor(*project_).predict(project_->entrypoint());
            if (!projected.diagnostics.empty() || projected.entries.empty()) {
                reason = "Flow prediction returned no dependencies or reported diagnostics";
                return false;
            }
            break;
        }
        }
    }
    ++batches_;
    return true;
}

bool CpuScenario::complete(std::string& reason)
{
    if (batches_ == 0) {
        reason = "CPU scenario completed without executing a work batch";
        return false;
    }
    return true;
}

bool CpuScenario::cleanup(std::string& reason)
{
    reason.clear();
    session_.reset();
    save_codec_.reset();
    saves_.reset();
    presentation_.reset();
    model_.reset();
    scripts_.reset();
    sources_.reset();
    project_.reset();
    return true;
}

} // namespace noveltea::benchmark
