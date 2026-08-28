# NovelTea Workspace v1

The project root is the directory containing `project.json`. Follow the generated workspace-v1 schemas and current file layout; do not create retired monolithic project files or legacy alternate shapes.

Editable project source lives in `project.json`, `traits.json`, `localization.json`, `editor.json`, `records/`, `scripts/`, and `assets/`. There is no top-level identity `properties.json`: identity Property schemas and Values/Defaults belong to their exact owner, reusable Trait, Archetype, or Interactable definition. `project.json` also owns the exact `interactableInstances` registry. Root `AGENTS.md` contains project instructions; follow it and do not edit its marked NovelTea-managed block. Never edit or track `.noveltea/` as project source.

Record filesystem identity is derived from the stable record ID, not the label. IDs match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. Non-Layout records live at `records/<collection>/<id>.json`; Layouts live at `records/layouts/<id>/layout.json`. A record ID must match its canonical path.

Current record collections include Assets, Variables, Shaders, Materials, Layouts, Archetypes, Characters, Rooms, Interactables, Verbs, Interactions, Dialogues, Scenes, Maps, Script Modules, and Tests. The generated `schemas/records/` directory contains one schema for each tracked record collection; use the focused docs first to understand semantics, then consult the schema for exact fields and variants.

Layout RML, RCSS, and dedicated Lua use contextual persisted selectors in `layout.json`: `{"sourceMode":"file"}`, `{"sourceMode":"asset","sourceAsset":...}`, or `{"sourceMode":"none"}`. File-mode companions are `layout.rml`, `layout.rcss`, and `layout.lua` beside `layout.json`.

Script Modules persist either `{"kind":"file","path":"scripts/...lua"}` or the current asset-backed source shape. Script file paths use forward slashes, remain under `scripts/`, cannot contain empty/`.`/`..` segments, and after symlink resolution must remain inside the project root. Two Script Modules cannot own the same normalized or real source file. Those containment and unique-ownership constraints are executable workspace rules beyond what JSON Schema alone can prove.

Tracked JSON is UTF-8, LF, two-space indented, and ends with one newline. Do not add timestamps, absolute machine paths, cache values, or local session state. Do not rewrite unrelated files as formatting fallout.
