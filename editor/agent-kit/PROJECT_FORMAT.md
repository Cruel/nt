# NovelTea Workspace v1

The project root is the directory containing `project.json`. Workspace identity is `noveltea.project.workspace`, version 1. There is no normal compatibility reader for the retired monolithic project format.

Tracked roots include `project.json`, `properties.json`, `localization.json`, `editor.json`, `records/`, `scripts/`, `assets/`, and the user-owned root `AGENTS.md`. `.noveltea/` is generated ignored local state.

Record filesystem identity is derived from the stable record ID, not the label. IDs match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. Non-Layout records live at `records/<collection>/<id>.json`; Layouts live at `records/layouts/<id>/layout.json`. A record ID must match its canonical path.

Layout RML, RCSS, and dedicated Lua use contextual persisted selectors in `layout.json`: `{"sourceMode":"file"}`, `{"sourceMode":"asset","sourceAsset":...}`, or `{"sourceMode":"none"}`. File-mode companions are `layout.rml`, `layout.rcss`, and `layout.lua` beside `layout.json`.

Script Modules persist either `{"kind":"file","path":"scripts/...lua"}` or the current asset-backed source shape. Script file paths use forward slashes, remain under `scripts/`, cannot contain empty/`.`/`..` segments, and after symlink resolution must remain inside the project root. Two Script Modules cannot own the same normalized or real source file. Those containment and unique-ownership constraints are executable workspace rules beyond what JSON Schema alone can prove.

Tracked JSON is UTF-8, LF, two-space indented, and ends with one newline. Do not add timestamps, absolute machine paths, cache values, or local session state. Do not rewrite unrelated files as formatting fallout.
