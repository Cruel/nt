# Old NovelTea Rendering, Text, UI, Runtime Map

Files inspected: `NovelTea/include/NovelTea/*.hpp`, `NovelTea/src/core/*.cpp`, `NovelTea/src/editor/*`, `NovelTea/res/forms/*`.

Key findings:

- Backend-neutral-looking domain types include `Action`, `Verb`, `Object`, `Entity`, `Room`, `Map`, `Dialogue`, `Cutscene`, `ProjectData`, `SaveData`, `Settings`, `Timer`, `Event`, and `TextLog`.
- Scripting depends on Duktape and dukglue through `ScriptManager`, `Script`, and runtime context integration.
- Text semantics are split across `BBCodeParser`, `TextTypes`, `ActiveText`, and `ActiveTextSegment`. These should not be ported before an `nt` text semantic/layout/render split exists.
- Rendering-heavy classes include `CutsceneRenderer`, `DialogueRenderer`, and `MapRenderer`; these are tied to the old rendering assumptions and must wait.
- Editor files under `NovelTea/src/editor` and Qt `.ui` forms are reference-only and out of scope for the new Electron/TanStack/Vite direction.

Risks:

- Some core files may look backend-neutral but include renderer or SFML-era assumptions indirectly. First migration slice needs include-level screening.
- Old JSON compatibility should be tested against sample projects before changing formats.

Recommended next action: after bootstrap builds, create a core migration plan that starts with serialization/data objects only.
