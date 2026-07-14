#pragma once

struct lua_State;

namespace noveltea {
class AudioSystem;
class RuntimeCommandDispatcher;
namespace core {
class GameSession;
class RuntimeSessionHost;
class ScriptHostServices;
} // namespace core
} // namespace noveltea

namespace noveltea::script {

class ScriptRuntime;
class RuntimeScriptApi;

namespace detail {
struct ScriptRuntimeAccess {
    static lua_State* state(ScriptRuntime& runtime);
    static const lua_State* state(const ScriptRuntime& runtime);
};
} // namespace detail

void bind_noveltea(lua_State* state);
void bind_audio(lua_State* state, noveltea::AudioSystem* audio);
void bind_audio_runtime_host(lua_State* state, noveltea::core::RuntimeSessionHost* host);
void clear_audio_binding(lua_State* state);
void install_host_print(lua_State* state);

} // namespace noveltea::script

namespace noveltea::script {

void bind_game_session(lua_State* state, noveltea::core::GameSession* session);
void bind_runtime_host(lua_State* state, noveltea::core::RuntimeSessionHost* host);
void bind_runtime_command_dispatcher(lua_State* state,
                                     noveltea::RuntimeCommandDispatcher* dispatcher);
void clear_game_bindings(lua_State* state);
void release_game_binding_state(lua_State* state);
void bind_typed_script_host(lua_State* state, RuntimeScriptApi* api);
void clear_typed_script_host(lua_State* state);

} // namespace noveltea::script
