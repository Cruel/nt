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

Writers emit UTF-8, LF, two-space JSON with a trailing newline and deterministic key order. Every
authoritative file has an exact-byte `sha256:<hex>` revision; expected absence is `absent`. The
aggregate workspace revision hashes the sorted path/revision inventory, but Save and Save All use the
selected logical save units' exact files as their concurrency boundary. An unrelated file change does
not block a scoped save. Logical owners that share `editor.json` are merged by owned JSON paths so a
chapter save preserves independently changed tag data.

NovelTea tracked writers serialize through `.noveltea/transactions/.writer-lock/`. Multi-file saves
and structural operations stage recoverable before/after blobs and a
`noveltea.workspace.transaction` version-1 manifest before replacing targets. Journal state advances
through `prepared`, `writing`, `committed`, or `rolled-back`. Project open recovers interrupted known
states before assembly; an unknown target state or malformed journal is retained and blocks mutation
with `WORKSPACE_TRANSACTION_RECOVERY_CONFLICT`. A live, unverifiable, or malformed lock owner fails
closed with `WORKSPACE_BUSY`; a proven-dead owner is recovered before its lock is reclaimed.

## Local state

`.noveltea/` is ignored via the root-scoped `/.noveltea/` `.gitignore` rule. Optional
`.noveltea/editor/state.json` uses `noveltea.editor.local-state` version `1`; it stores recovery,
export identity, workbench, explorer, bottom panel, tab state, and drafts. It never duplicates
tracked organization fields. Missing, corrupt, or unsupported local state is discarded; it cannot
repair tracked source. Its `workspaceRevision` is a baseline marker for recovery/session payloads,
not an input to aggregate workspace identity. Local-state writes do not rewrite tracked
`editor.json`; tracked organization and ignored local/session state are persisted independently.

New projects create `records/`, `scripts/`, and `assets/` but do not add placeholder files. Save As
targets a project root and writes `project.json`; it carries tracked baseline, local editor state,
dirty-only asset bytes, and separately-owned workflows, while excluding generated agent/build/cache,
transactions, and trash state.
