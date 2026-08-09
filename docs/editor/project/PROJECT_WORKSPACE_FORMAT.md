# Project Workspace Format

NovelTea projects use workspace v1. A project's identity is its root directory; its manifest is
always `<project-root>/project.json`. Normal editor, compiler, preview, export, and workspace open
paths accept no legacy monolithic project file or alternate manifest name.

## Tracked source

`project.json` has schema `noveltea.project.workspace` at version `1` and owns project identity,
settings, startup hook, and entrypoint. `properties.json`, `localization.json`, and `editor.json`
are required contextual fragments. `editor.json` contains exactly collaborator-visible `chapters`,
`tags`, and `recordMetadata`.

Records live under `records/<collection>/<id>.json`; Layouts instead live under
`records/layouts/<id>/layout.json`. IDs are canonical file identity and must match the stored record
ID. Unknown `records/` collection directories and noncanonical record paths are structural errors.
Missing known collection directories mean empty collections.

File-backed Layout channels are `layout.rml`, `layout.rcss`, and `layout.lua` beside `layout.json`.
The JSON selectors use `file`, `asset`, or (only for Lua) `none`; source text is not duplicated in
the Layout record. Script Module file sources use `{ "kind": "file", "path": "scripts/...lua" }`.
Their paths are safe project-relative `scripts/` paths. Assembly presents both as the existing
internal inline Lua/Layout model, so file presence never grants autorun or hook behavior.

Assets remain complete Asset records in `records/assets/`; their project source bytes remain at the
explicit Asset source path, normally under `assets/`. Project-local `workflows/` is owned by the
ComfyUI workflow service and is not AuthoringProject input.

Writers emit UTF-8, LF, two-space JSON with a trailing newline and deterministic key order. Saves
project the complete canonical tree, use one aggregate workspace-revision freshness check, and only
write or delete files whose canonical bytes/existence changed.

## Local state

`.noveltea/` is ignored via the root-scoped `/.noveltea/` `.gitignore` rule. Optional
`.noveltea/editor/state.json` uses `noveltea.editor.local-state` version `1`; it stores recovery,
export identity, workbench, explorer, bottom panel, tab state, and drafts. It never duplicates
tracked organization fields. Missing, corrupt, or unsupported local state is discarded; it cannot
repair tracked source. Its `workspaceRevision` is a baseline marker for recovery/session payloads,
not an input to aggregate workspace identity; tracked writes carry the loaded aggregate revision and
are rejected when it is stale.

New projects create `records/`, `scripts/`, and `assets/` but do not add placeholder files. Save As
targets a project root and writes `project.json`; it carries tracked baseline, local editor state,
dirty-only asset bytes, and separately-owned workflows, while excluding generated agent/build/cache,
transactions, and trash state.
