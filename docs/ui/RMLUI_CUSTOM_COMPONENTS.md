# RmlUi Custom Components

## Purpose

Track the custom RmlUi element/component strategy for complex NovelTea runtime widgets.

## Initial Component Candidates

- `nt-active-text`: registered as a C++ RmlUi element. Phase 5 binds room/dialogue/cutscene body state into safe fallback RML. Phase 6 adds deterministic reveal progress through the engine-owned `TweenService`. Rich-text layout and per-glyph effects are Phase 7 work.
- `nt-map-view`: registered as a C++ RmlUi element. Phase 5 binds a graceful placeholder or available navigation labels. Typed map rendering, visibility, hit testing, and navigation behavior are Phase 8 work.
- `nt-text-log`: registered as a C++ RmlUi element. Phase 5 binds saved/runtime log lines into safe fallback RML. Scrollback policy, richer entry metadata, and playback assertions are Phase 9 work.
- Inventory/object interaction widgets where generic RML is insufficient
- Save/load or profile widgets if they need custom behavior beyond ordinary controls

## Phase 5 Contract

Custom runtime elements live only in the RmlUi runtime layer. Backend-neutral core state is
still exposed as `RuntimeUIViewState`; `RuntimeUiDocumentBinder` adapts that state into the
component snapshots.

The system fallback runtime template contains all three initial tags. Project/theme
overrides may still provide legacy slots such as `rt_body`, `rt_log`, and `rt_map`; the
binder keeps those working with the same fallback RML.
