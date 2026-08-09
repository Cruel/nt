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
`.noveltea/editor/state.json` uses `noveltea.editor.local-state` version `2`; it stores recovery,
export identity, workbench, explorer, bottom panel, tab state, and drafts. It never duplicates
tracked organization fields. Missing, corrupt, or unsupported local state is discarded; it cannot
repair tracked source. Its `workspaceRevision` is a baseline marker for recovery/session payloads,
not an input to aggregate workspace identity. Local-state writes do not rewrite tracked
`editor.json`; tracked organization and ignored local/session state are persisted independently.

New projects create `records/`, `scripts/`, and `assets/` but do not add placeholder files. Save As
targets a project root and writes `project.json`; it carries tracked baseline, local editor state,
dirty-only asset bytes, and separately-owned workflows, while excluding generated agent/build/cache,
transactions, and trash state.

## Headless CLI editing boundary

The TypeScript Node reference CLI uses `noveltea [--project <project-directory>] [--json]
<command> ...`. Without `--project`, it walks upward from the current directory and selects the
first `project.json`. Finding a malformed NovelTea manifest, the wrong workspace schema identity,
or an unsupported workspace version stops discovery at that directory; discovery never falls
through to a parent project and never considers retired manifest names. `--project` is an explicit
project-root override and is validated by the same workspace-v1 rules.

Ordinary agent edits are direct edits to tracked JSON, Lua, RML, and RCSS source files followed by
`noveltea validate`. Semantic commands are reserved for operations that need project-wide graph or
transaction semantics: `entity create`, `entity rename`, `entity delete`, and `usages`. `entity
create` uses the same authoring record defaults as the editor and does not provide a generic Asset
creator. Rename/delete source-reference policy comes from the shared dependency graph: recognized
rewriteable references are rewritten on rename, exact manual references block rename, possible
lexical references require `--allow-possible-source-references`, and delete still requires `--force`
for exact blockers independently of the possible-reference acknowledgement.

`--dry-run` performs discovery, assembly, graph/source preflight, and file projection without writing
tracked or ignored project files. If a pending transaction would require recovery, a dry run fails
closed instead of changing journal state. Non-dry-run semantic mutations persist through the same
workspace transaction service used by editor structural writes.

`noveltea validate` uses the shared authoring compiler/validation and dependency/source-analysis
pipeline. Projects with authored Shaders or Materials also run shader readiness for `glsl-120`,
`essl-100`, and `essl-300` through the existing native editor-tool subprocess boundary. Phase 6 does
not add another native transport.

In `--json` mode, expected successes and failures emit exactly one compact JSON object plus one LF on
stdout and keep stderr empty. The envelope always includes `success`, `exitCode`, and `diagnostics`;
diagnostics are deterministically ordered and carry stable code/path/message fields plus source
location when available. Exit codes are `0` success, `2` CLI usage, `3` workspace/discovery, `4`
semantic/preflight, `5` mutation/concurrency, `6` native shader-tool failure, and `70` unexpected
internal failure.
