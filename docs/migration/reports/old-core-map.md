# Old Core Map

Files inspected: `NovelTea/include/NovelTea/*.hpp`, `NovelTea/src/core/*.cpp`, `NovelTea/test/*.cpp`.

Backend-neutral candidates for the first migration phase:

- Data/project: `ProjectData`, `ProjectDataIdentifiers`, `Settings`, `SaveData`, `Profile`.
- Domain: `Action`, `Verb`, `Object`, `ObjectList`, `Entity`, `Room`, `Map`, `Dialogue`, `DialogueSegment`, `Cutscene`, and cutscene segment data types.
- Runtime utilities: `JsonSerializable`, `PropertyList`, `Timer`, `Event`, `Notification`, `TextLog`, `StringUtils`, `RegexUtils`, `Diff`, `FileUtils`.
- Scripting compatibility: `Script`, `ScriptManager`, Duktape, and dukglue should be a separate phase after data types are stable.

First-slice caution:

- Include-level screening is mandatory. Some files that look like data models may still pull renderer/runtime assumptions indirectly.
- Do not port `Game`, `Context`, players, renderers, or text animation until the core data target exists and has tests.

Recommended next action: create `noveltea_core` with only dependency-clean data/serialization files and smoke tests.
