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

EM_JS(void, nt_preview_emit_diagnostic,
      (const char* severity, const char* category, const char* path, const char* message,
       const char* source_url), {
    const bridge = globalThis.NovelTeaPreviewBridge;
    if (bridge && typeof bridge.send === 'function') {
        const diagnostic = {
            severity: UTF8ToString(severity),
            category: UTF8ToString(category),
            path: UTF8ToString(path),
            message: UTF8ToString(message)
        };
        const sourceUrl = UTF8ToString(source_url);
        if (sourceUrl.length > 0) diagnostic.sourceUrl = sourceUrl;
        bridge.send({version: 1, type: 'preview-diagnostic', diagnostic});
    }
});

EM_JS(void, nt_preview_emit_fps, (float fps, float frame_time_ms, int fps_cap), {
    const bridge = globalThis.NovelTeaPreviewBridge;
    if (bridge && typeof bridge.setFpsCounter === 'function') {
        bridge.setFpsCounter(fps, frame_time_ms, fps_cap);
    }
    if (bridge && typeof bridge.send === 'function') {
        bridge.send({
            version: 1,
            type: 'fps-counter',
            fps,
            frameTimeMs: frame_time_ms,
            fpsCap: fps_cap
        });
    }
});

EM_JS(void, nt_preview_emit_focused_document_applied,
      (const char* request_id, double host_generation, double apply_sequence,
       const char* project_instance_id, double resource_stage_generation, const char* kind,
       const char* record_id, const char* revision, const char* disposition,
       const char* diagnostics_json), {
    const bridge = globalThis.NovelTeaPreviewBridge;
    if (!bridge || typeof bridge.focusedDocumentApplied !== 'function') return;
    const diagnostics = JSON.parse(UTF8ToString(diagnostics_json));
    bridge.focusedDocumentApplied({
        requestId: UTF8ToString(request_id),
        hostGeneration: Number(host_generation),
        applySequence: Number(apply_sequence),
        projectInstanceId: UTF8ToString(project_instance_id),
        resourceStageGeneration: Number(resource_stage_generation),
        kind: UTF8ToString(kind),
        recordId: UTF8ToString(record_id),
        revision: UTF8ToString(revision),
        disposition: UTF8ToString(disposition),
        diagnostics
    });
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

void emit_diagnostic(const char* severity, const char* category, const char* path,
                     const char* message, const char* source_url)
{
#if defined(__EMSCRIPTEN__)
    nt_preview_emit_diagnostic(severity ? severity : "warning", category ? category : "runtime",
                               path ? path : "", message ? message : "",
                               source_url ? source_url : "");
#else
    (void)severity;
    (void)category;
    (void)path;
    (void)message;
    (void)source_url;
#endif
}

void emit_fps(float fps, float frame_time_ms, int fps_cap)
{
#if defined(__EMSCRIPTEN__)
    nt_preview_emit_fps(fps, frame_time_ms, fps_cap);
#else
    (void)fps;
    (void)frame_time_ms;
    (void)fps_cap;
#endif
}

void emit_focused_document_applied(const char* request_id, std::uint64_t host_generation,
                                   std::uint64_t apply_sequence, const char* project_instance_id,
                                   std::uint64_t resource_stage_generation, const char* kind,
                                   const char* record_id, const char* revision,
                                   const char* disposition, const char* diagnostics_json)
{
#if defined(__EMSCRIPTEN__)
    nt_preview_emit_focused_document_applied(
        request_id ? request_id : "", static_cast<double>(host_generation),
        static_cast<double>(apply_sequence), project_instance_id ? project_instance_id : "",
        static_cast<double>(resource_stage_generation), kind ? kind : "",
        record_id ? record_id : "", revision ? revision : "", disposition ? disposition : "failed",
        diagnostics_json ? diagnostics_json : "[]");
#else
    (void)request_id;
    (void)host_generation;
    (void)apply_sequence;
    (void)project_instance_id;
    (void)resource_stage_generation;
    (void)kind;
    (void)record_id;
    (void)revision;
    (void)disposition;
    (void)diagnostics_json;
#endif
}

} // namespace noveltea::preview_bridge
