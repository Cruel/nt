#pragma once

struct lua_State;

namespace noveltea {
class AudioSystem;
namespace core {
class GameSession;
class RuntimeSessionHost;
} // namespace core
} // namespace noveltea

namespace noveltea::script {

class ScriptRuntime;

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
void clear_game_bindings(lua_State* state);

} // namespace noveltea::script
