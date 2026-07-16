#pragma once

struct lua_State;

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
void install_host_print(lua_State* state);

} // namespace noveltea::script

namespace noveltea::script {

void bind_typed_script_host(lua_State* state, RuntimeScriptApi* api);
void clear_typed_script_host(lua_State* state);
void bind_runtime_capabilities(lua_State* state, RuntimeScriptApi* api);
void clear_runtime_capabilities(lua_State* state);

} // namespace noveltea::script
