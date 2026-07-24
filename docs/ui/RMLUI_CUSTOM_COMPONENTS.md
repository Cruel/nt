# RmlUi Custom Components

## Purpose

Track the custom RmlUi element/component strategy for complex NovelTea runtime widgets.

## Initial Component Candidates

- `nt-active-text`: registered as a C++ RmlUi element. It is a layout/input host rather than a glyph
  markup renderer. It binds typed Room/Dialogue/Scene text state, drives deterministic reveal and
  alpha playback through the coordinator-owned typed presentation lifecycle, and preserves
  `RichTextDocument` state.
  After RmlUi resolves the element box, RuntimeUI shapes visible text through the engine text stack,
  `ActiveTextLayout` maps shaped glyph ranges back to rich-text metadata and object hit rectangles,
  local page/wait segments, playback alpha, and prompt metadata, and the engine bgfx text renderer
  draws the direct path after RmlUi.
- `nt-map-view`: registered as a C++ RmlUi element. It binds typed map rooms and
  connections from `TypedRuntimeUIViewState`, highlights the current room, preserves style ids and
  visibility script text as metadata, and emits `nt-nav` click targets for directly reachable
  rooms. Lua visibility scripts are not executed by backend-neutral core in this v1 fallback.
- `nt-text-log`: registered as a C++ RmlUi element. It binds structured runtime log
  entries into deterministic fallback RML with sequence ids, rich-text snapshots,
  speaker/source/category metadata, and playback-assertable output payloads. Filtering remains
  later work.
- Inventory/object interaction widgets where generic RML is insufficient
- Save/load or profile widgets if they need custom behavior beyond ordinary controls

## Runtime contract

Custom runtime elements live only in the private RmlUi runtime layer. Backend-neutral runtime state
is exposed as `TypedRuntimeUIViewState` inside revisioned `RuntimeUiGameplayValues`;
`RuntimeUiBinder` and `RuntimeUiDocumentBinder` adapt it into document and component snapshots.

The system fallback runtime template contains all three initial tags. Project/theme
overrides may still provide legacy slots such as `rt_body`, `rt_log`, and `rt_map`; the
binder keeps those working with the same fallback RML.

Direct ActiveText rendering is intentionally engine-side. RmlUi owns layout hosting and input event
routing; RuntimeUI snapshots the resolved element bounds after `Rml::Context::Update()`; NovelTea's
text stack owns shaping; and NovelTea's renderer owns glyph submission, material/direct-shader
binding, effect projection, and deduped diagnostics. Missing ActiveText material or direct shader-pair
programs fall back to default text rendering.
