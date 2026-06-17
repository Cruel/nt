#pragma once

struct lua_State;

namespace noveltea::script {

class ScriptRuntime;

lua_State* native_lua_state(ScriptRuntime& runtime);
const lua_State* native_lua_state(const ScriptRuntime& runtime);

void bind_noveltea(lua_State* state);

} // namespace noveltea::script
