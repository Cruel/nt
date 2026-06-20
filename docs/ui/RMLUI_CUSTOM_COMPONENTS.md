# RmlUi Custom Components

## Purpose

Track the custom RmlUi element/component strategy for complex NovelTea runtime widgets.

## Initial Component Candidates

- `nt-active-text`: registered as a C++ RmlUi element. Phase 5 binds room/dialogue/cutscene body state into safe fallback RML. Phase 6 adds deterministic reveal progress through the engine-owned `TweenService`. Phase 7 preserves `RichTextDocument` state, builds deterministic per-glyph ActiveText frames, and emits fallback RML glyph spans with style, object, shader, offset, diff, and effect state. Shader/material ids remain metadata stubs until renderer-specific hooks are added.
- `nt-map-view`: registered as a C++ RmlUi element. Phase 8 binds typed map rooms and
  connections from `RuntimeUIViewState`, highlights the current room, preserves style ids and
  visibility script text as metadata, and emits `nt-nav` click targets for directly reachable
  rooms. Lua visibility scripts are not executed by backend-neutral core in this v1 fallback.
- `nt-text-log`: registered as a C++ RmlUi element. Phase 9 binds structured runtime log
  entries into deterministic fallback RML with sequence ids, rich-text snapshots,
  speaker/source/category metadata, and playback-assertable output payloads. Filtering remains
  later work.
- Inventory/object interaction widgets where generic RML is insufficient
- Save/load or profile widgets if they need custom behavior beyond ordinary controls

## Phase 5 Contract

Custom runtime elements live only in the RmlUi runtime layer. Backend-neutral core state is
still exposed as `RuntimeUIViewState`; `RuntimeUiDocumentBinder` adapts that state into the
component snapshots.

The system fallback runtime template contains all three initial tags. Project/theme
overrides may still provide legacy slots such as `rt_body`, `rt_log`, and `rt_map`; the
binder keeps those working with the same fallback RML.
