#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/script/script_result.hpp"
#include "noveltea/script/script_value.hpp"

#include <memory>
#include <string>
#include <string_view>

namespace noveltea {
class AudioSystem;
class RuntimeCommandDispatcher;
} // namespace noveltea
namespace noveltea::assets {
class AssetManager;
}
namespace noveltea::core {
class GameSession;
class RuntimeSessionHost;
class ScriptHostServices;
} // namespace noveltea::core

namespace noveltea::script {

namespace detail {
struct ScriptRuntimeAccess;
}
class ScriptInvoker;
class RuntimeScriptApi;

struct ScriptRuntimeConfig {
    const assets::AssetManager* assets = nullptr;
    AudioSystem* audio = nullptr;
};

class ScriptRuntime {
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
    [[nodiscard]] core::Result<void, ScriptError>
    execute_asset(std::string_view logical_asset_path);
    [[nodiscard]] core::Result<ScriptValue, ScriptError>
    evaluate(std::string_view expression, std::string_view chunk_name = "expression");
    [[nodiscard]] core::Result<bool, ScriptError>
    evaluate_bool(std::string_view expression, std::string_view chunk_name = "expression");
    [[nodiscard]] core::Result<std::string, ScriptError>
    evaluate_string(std::string_view expression, std::string_view chunk_name = "expression");

    void collect_garbage();

    void bind_game_session(core::GameSession* session);
    void bind_runtime_host(core::RuntimeSessionHost* host);
    void bind_runtime_command_dispatcher(RuntimeCommandDispatcher* dispatcher);
    void bind_audio(AudioSystem* audio);
    void clear_audio_binding();
    void clear_game_bindings();
    void bind_typed_host(core::ScriptHostServices* host);
    void clear_typed_host();
    void bind_runtime_script_api(RuntimeScriptApi* api);
    [[nodiscard]] bool has_runtime_script_api() const noexcept;

private:
    friend class ScriptInvoker;
    friend struct detail::ScriptRuntimeAccess;

    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    begin_invocation(std::string_view source, std::string_view chunk_name,
                     const core::FlowFrameId& owner,
                     const core::ScriptInvocationHandle& invocation);
    [[nodiscard]] core::Result<ScriptInvocationOutcome, ScriptError>
    resume_invocation(const core::FlowFrameId& owner,
                      const core::ScriptInvocationHandle& invocation);
    [[nodiscard]] core::Result<void, ScriptError>
    cancel_invocation(const core::FlowFrameId& owner,
                      const core::ScriptInvocationHandle& invocation);

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::script
