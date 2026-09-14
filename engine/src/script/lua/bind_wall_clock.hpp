#pragma once

struct lua_State;

namespace noveltea::script {
class WallClock;
void bind_wall_clock(lua_State* state, const WallClock& clock);
} // namespace noveltea::script
