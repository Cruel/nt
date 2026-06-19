# Old Text UI Rendering Map

Files inspected: `NovelTea/include/NovelTea/ActiveText*.hpp`, `BBCodeParser.hpp`, `TextTypes.hpp`, `CutsceneRenderer.hpp`, `DialogueRenderer.hpp`, `MapRenderer.hpp`, `NovelTea/src/core/*Renderer.cpp`, `NovelTea/src/editor/*`, and `NovelTea/res/forms/*`.

Key findings:

- BBCode and text semantics live in `BBCodeParser`, `TextTypes`, `ActiveText`, and `ActiveTextSegment`.
- Runtime presentation is mixed with old renderer assumptions in `CutsceneRenderer`, `DialogueRenderer`, and `MapRenderer`.
- GUI/editor assets are Qt-era reference material only; they should not be migrated into the runtime.
- Old runtime UI behavior should be decomposed into controllers, RmlUi-facing views/adapters, and the future rich text layer.

Deferred until after bootstrap and core migration:

- `ActiveText` and text effects.
- Dialogue/cutscene/map renderers.
- State classes and old GUI widgets.
- Qt editor.

Recommended next action: after core/domain and scripting phases, port BBCode/TextTypes semantics into backend-neutral tests before implementing any bgfx text rendering.
