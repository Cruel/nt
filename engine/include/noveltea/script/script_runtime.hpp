#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/runtime/runtime_ports.hpp"
#include "noveltea/script/script_result.hpp"
#include "noveltea/script/script_value.hpp"

#include <memory>
#include <string>
#include <string_view>

namespace noveltea::script {

namespace detail {
struct ScriptRuntimeAccess;
}
class RuntimeScriptApi;

struct ScriptRuntimeConfig {
    const runtime::ScriptSourcePort* sources = nullptr;
};

class ScriptRuntime final : public runtime::ScriptRuntimePort {
public:
    ScriptRuntime();
    ~ScriptRuntime();

    ScriptRuntime(const ScriptRuntime&) = delete;
    ScriptRuntime& operator=(const ScriptRuntime&) = delete;

    [[nodiscard]] core::Result<void, ScriptError> initialize(ScriptRuntimeConfig config);
    void shutdown();
    [[nodiscard]] bool is_initialized() const;

    [[nodiscard]] core::Result<void, ScriptError> execute(std::string_view source,
                                                          std::string_view chunk_name = "chunk");
    [[nodiscard]] core::Result<void, ScriptError> certify(std::string_view source,
                                                          std::string_view chunk_name = "chunk");
    [[nodiscard]] core::Result<void, ScriptError>
    certify_asset(std::string_view logical_asset_path);
    [[nodiscard]] core::Result<void, runtime::ScriptInvocationError>
    certify_source(std::string_view source, std::string_view chunk_name) override;
    [[nodiscard]] core::Result<void, runtime::ScriptInvocationError>
    certify_asset_source(std::string_view logical_path) override;
    [[nodiscard]] core::Result<void, ScriptError>
    execute_asset(std::string_view logical_asset_path);
    [[nodiscard]] core::Result<ScriptValue, ScriptError>
    evaluate(std::string_view expression, std::string_view chunk_name = "expression");
    [[nodiscard]] core::Result<bool, ScriptError>
    evaluate_bool(std::string_view expression, std::string_view chunk_name = "expression");
    [[nodiscard]] core::Result<std::string, ScriptError>
    evaluate_string(std::string_view expression, std::string_view chunk_name = "expression");

    void collect_garbage();

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    invoke(const runtime::ScriptInvocationRequest& request,
           const runtime::RuntimeCapabilitySet& capabilities) override;
    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, runtime::ScriptInvocationError>
    resume(const core::ScriptInvocationHandle& invocation,
           const runtime::RuntimeCapabilitySet& capabilities) override;
    void cancel(const core::ScriptInvocationHandle& invocation,
                runtime::ScriptCancellationReason reason) override;
    void invalidate_capabilities(runtime::CapabilityGeneration generation) noexcept override;

    void replace_runtime_capabilities(runtime::RuntimeCapabilitySet capabilities) noexcept;
    void clear_runtime_capabilities() noexcept;

private:
    friend struct detail::ScriptRuntimeAccess;

    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    begin_invocation(std::string_view source, std::string_view chunk_name,
                     const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation,
                     runtime::RuntimeCapabilityProfile profile,
                     runtime::CapabilityGeneration generation);
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    resume_invocation(const core::ScriptInvocationHandle& invocation);
    void cancel_invocation(const core::ScriptInvocationHandle& invocation) noexcept;

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::script
