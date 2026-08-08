# RmlUi Custom Components

## Purpose

Track the custom RmlUi element/component strategy for complex NovelTea runtime widgets.

## Current Components

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
  rooms. Lua visibility scripts are not executed by backend-neutral core in this provisional
  fallback. Its generated inner RML and current activation path are explicitly not the final Map
  authoring contract.

Text Log is no longer a custom element. It uses ordinary RmlUi data binding over
`gameplay.text_log.entries`, including sanitized rich `body_rml` for each entry.

## Runtime contract

Custom runtime elements live only in the private RmlUi runtime layer. Ordinary state-driven UI uses
the context-local `noveltea` data model described in `docs/ui/RMLUI_DATA_MODEL_CONTRACT.md`. A C++
custom element is preferred only when ordinary RML/data binding is insufficient for the required
rendering, lifecycle, or input behavior.

RuntimeUI owns focused tag-based component refresh paths rather than a general document binder.
ActiveText is updated only for the first `nt-active-text` in the active Game HUD. The provisional Map
path updates only the first `nt-map-view` in the active Game HUD and active Text Log system documents
while gameplay state exists. Arbitrary opted-in Layouts receive `noveltea` model state but do not
automatically become ActiveText or Map component hosts.

Direct ActiveText rendering is intentionally engine-side. RmlUi owns layout hosting and input event
routing; RuntimeUI snapshots the resolved element bounds after `Rml::Context::Update()`; NovelTea's
text stack owns shaping; and NovelTea's renderer owns glyph submission, material/direct-shader
binding, effect projection, and deduped diagnostics. Missing ActiveText material or direct shader-pair
programs fall back to default text rendering.
