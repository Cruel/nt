#pragma once

namespace noveltea::preview_bridge {

struct NormalizedPosition {
    float x = 0.5f;
    float y = 0.5f;
};

void emit_ready(NormalizedPosition position, bool running);
void emit_state_changed(NormalizedPosition position, bool running);
void emit_object_clicked(const char* object_id, NormalizedPosition object_position,
                         NormalizedPosition pointer_position);

} // namespace noveltea::preview_bridge
