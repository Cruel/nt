# NovelTea Migration Plan

Migration begins only after the framework bootstrap builds. The old `NovelTea/` tree is read-only reference material and must not be added as a production include path, CMake subdirectory, or linked target.

## Phase Order

1. Backend-neutral core/domain/project/save/settings utilities.
2. Scripting runtime compatibility, preserving Duktape/dukglue behavior initially.
3. Runtime `Context`/`Game` integration into the new `Engine::tick()` loop.
4. BBCode/TextTypes semantic port.
5. Rich text layout/effect model.
6. Rich text bgfx rendering path.
7. Cutscene/dialogue runtime controllers.
8. Game UI through RmlUi/adapters.
9. Editor preview/API integration for the future Electron editor.

## First Allowed Migration Slice

Only after Linux/Web/Android bootstrap verification is stable:

- Create a backend-neutral `noveltea_core` or equivalent target.
- Port only files that include no SFML, Qt, SDL, bgfx, RmlUi, ImGui, Android, or Emscripten headers.
- Start with data/serialization types and add smoke tests for construction and JSON compatibility.
- Document every compatibility compromise in `docs/migration/STATUS.md`.

## Explicitly Blocked For First Slice

- `ActiveText`, `ActiveTextSegment`, `CutsceneRenderer`, `DialogueRenderer`, `MapRenderer`.
- Old GUI widgets and state classes.
- Qt editor files and `.ui` forms.
- SFML-facing drawables, textures, fonts, windows, or events.
