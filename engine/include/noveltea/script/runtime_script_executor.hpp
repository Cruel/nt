#pragma once

#include <optional>
#include <vector>

#include <noveltea/core/runtime_io.hpp>

namespace noveltea::core {
class RuntimeSessionHost;
}

namespace noveltea::script {

class ScriptRuntime;

class RuntimeScriptExecutor {
public:
    RuntimeScriptExecutor() = default;

    void initialize(ScriptRuntime* runtime, core::RuntimeSessionHost* host);
    void shutdown();

    [[nodiscard]] bool ready() const noexcept { return m_runtime != nullptr && m_host != nullptr; }

    void process(core::RuntimeInputResult& result);
    void process_outputs(std::vector<core::RuntimeOutput>& outputs,
                         std::optional<std::uint64_t> step_index = std::nullopt);

private:
    ScriptRuntime* m_runtime = nullptr;
    core::RuntimeSessionHost* m_host = nullptr;
};

} // namespace noveltea::script
