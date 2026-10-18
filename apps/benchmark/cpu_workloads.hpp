#pragma once

#include "benchmark_runner.hpp"
#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/presentation/runtime_presentation_model.hpp"
#include "noveltea/runtime/flow_prediction.hpp"
#include "noveltea/runtime/runtime_session.hpp"
#include "noveltea/script/script_runtime.hpp"

#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace noveltea::benchmark {

enum class CpuWorkload {
    Lua,
    RuntimeSession,
    FlowPrediction
};

class CpuScenario final : public Scenario {
public:
    explicit CpuScenario(CpuWorkload workload);
    ~CpuScenario() override;

    [[nodiscard]] const char* id() const override;
    [[nodiscard]] const char* description() const override;
    [[nodiscard]] bool requires_graphics() const override { return false; }
    bool prepare(const Options& options, std::string& reason) override;
    Readiness readiness(std::string& reason) override;
    bool frame(std::string& reason) override;
    bool complete(std::string& reason) override;
    bool cleanup(std::string& reason) override;

private:
    class Sources;
    class Presentation;
    CpuWorkload workload_;
    uint32_t work_units_ = 1;
    uint64_t batches_ = 0;
    std::unique_ptr<Sources> sources_;
    std::unique_ptr<script::ScriptRuntime> scripts_;
    std::optional<core::CompiledProject> project_;
    std::unique_ptr<presentation::RuntimePresentationModel> model_;
    std::unique_ptr<Presentation> presentation_;
    std::unique_ptr<core::TypedMemorySaveSlotStore> saves_;
    std::unique_ptr<core::JsonSaveStateCodec> save_codec_;
    std::unique_ptr<runtime::RuntimeSession> session_;
};

} // namespace noveltea::benchmark
