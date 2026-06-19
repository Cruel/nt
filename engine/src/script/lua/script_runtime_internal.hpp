#pragma once

struct lua_State;

namespace noveltea::script {

class ScriptRuntime;

namespace detail {
struct ScriptRuntimeAccess {
    static lua_State* state(ScriptRuntime& runtime);
    static const lua_State* state(const ScriptRuntime& runtime);
};
} // namespace detail

void bind_noveltea(lua_State* state);
void install_host_print(lua_State* state);

} // namespace noveltea::script

namespace noveltea::core {
class GameSession;
}

namespace noveltea::script {

void bind_game_session(lua_State* state, noveltea::core::GameSession* session);
void clear_game_bindings(lua_State* state);

} // namespace noveltea::script
