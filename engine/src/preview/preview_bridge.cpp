#include "noveltea/preview_bridge.hpp"

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#endif

namespace noveltea::preview_bridge {

// clang-format off
#if defined(__EMSCRIPTEN__)
EM_JS(void, nt_preview_emit_ready, (float x, float y, int running), {
    const bridge = globalThis.NovelTeaPreviewBridge;
    if (bridge && typeof bridge.markEngineReady === 'function') {
        bridge.markEngineReady({x, y}, !!running);
    }
});

EM_JS(void, nt_preview_emit_state, (float x, float y, int running), {
    const bridge = globalThis.NovelTeaPreviewBridge;
    if (bridge && typeof bridge.send === 'function') {
        bridge.send({version: 1, type: 'state', position: {x, y}, running: !!running});
    }
});

EM_JS(void, nt_preview_emit_object_clicked,
      (const char* object_id, float ox, float oy, float px, float py), {
    const bridge = globalThis.NovelTeaPreviewBridge;
    if (bridge && typeof bridge.send === 'function') {
        bridge.send({
            version: 1,
            type: 'object-clicked',
            objectId: UTF8ToString(object_id),
            position: {x: ox, y: oy},
            pointerPosition: {x: px, y: py}
        });
    }
});
#endif
// clang-format on

void emit_ready(NormalizedPosition position, bool running)
{
#if defined(__EMSCRIPTEN__)
    nt_preview_emit_ready(position.x, position.y, running ? 1 : 0);
#else
    (void)position;
    (void)running;
#endif
}

void emit_state_changed(NormalizedPosition position, bool running)
{
#if defined(__EMSCRIPTEN__)
    nt_preview_emit_state(position.x, position.y, running ? 1 : 0);
#else
    (void)position;
    (void)running;
#endif
}

void emit_object_clicked(const char* object_id, NormalizedPosition object_position,
                         NormalizedPosition pointer_position)
{
#if defined(__EMSCRIPTEN__)
    nt_preview_emit_object_clicked(object_id, object_position.x, object_position.y,
                                   pointer_position.x, pointer_position.y);
#else
    (void)object_id;
    (void)object_position;
    (void)pointer_position;
#endif
}

} // namespace noveltea::preview_bridge
