# Project Workspace Format

NovelTea projects use workspace v1. A project's identity is its root directory; its manifest is
always `<project-root>/project.json`. Normal editor, compiler, preview, export, and workspace open
paths accept no legacy monolithic project file or alternate manifest name.

## Tracked source

`project.json` has schema `noveltea.project.workspace` at version `1` and owns project identity,
project settings, top-level export configuration, startup hook, and entrypoint. `/settings` is the
Project Settings subtree; `/export` is the independent Export save-unit subtree containing the
built-in Runtime Package policy and portable platform profiles. Profile selection and other execution
choices remain editor-local. `properties.json`, `localization.json`, and `editor.json`
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

Privileged editor reads do not treat those stored source paths as renderer capabilities. The Electron
main process resolves Project-scoped access from the current opaque `projectSessionId` and admitted
Asset identity. Original Asset access accepts only normalized forward-slash paths beneath `assets/`,
canonicalizes the Project root and target with realpath, allows symlinks only when their real target
remains beneath the canonical Project root, requires a regular file, and verifies admitted size and
SHA-256 revision. Project-relative lexical escape, alternate/backslash spellings, symlink escape,
non-regular files, stale sessions, and changed source identity fail closed before bytes are published.

Writers emit UTF-8, LF, two-space JSON with a trailing newline and deterministic key order. Every
authoritative file has an exact-byte `sha256:<hex>` revision; expected absence is `absent`. The
aggregate workspace revision hashes the sorted path/revision inventory, but Save and Save All use the
selected logical save units' exact files plus their exact changed JSON paths as the concurrency
boundary. An unrelated file change does not block a scoped save, and a disjoint change to another
field inside the same physical record is preserved by rebasing selected paths over the newest disk
fragment. Logical owners that share `editor.json` are likewise merged by owned JSON paths so a
chapter save preserves independently changed tag or record-metadata data.

NovelTea tracked writers serialize through `.noveltea/transactions/.writer-lock/`. Multi-file saves
and structural operations stage recoverable before/after blobs and a
`noveltea.workspace.transaction` version-1 manifest before replacing targets. Journal state advances
through `prepared`, `writing`, `committed`, or `rolled-back`. Project open recovers interrupted known
states before assembly; an unknown target state or malformed journal is retained and blocks mutation
with `WORKSPACE_TRANSACTION_RECOVERY_CONFLICT`. A live, unverifiable, or malformed lock owner fails
closed with `WORKSPACE_BUSY`. Reclaiming a proven-dead owner first acquires the exclusive
`.writer-lock-reclaim` guard, revalidates the stale owner token and process liveness, then atomically
renames the stale lock to a unique `.writer-lock.claimed-*` path. Only that claimant may recover
journals while the active lock path is absent; competing reclaimers or writers return `WORKSPACE_BUSY`.
The claimant publishes its new owner before deleting the claimed stale directory and reclaim guard,
and every removal verifies the expected owner token.

## Local state

`.noveltea/` and `dist/` are ignored via the root-scoped `/.noveltea/` and `/dist/` `.gitignore`
rules. Optional
`.noveltea/editor/state.json` uses `noveltea.editor.local-state` version `3`; it stores recovery,
export identity, workbench, explorer, bottom panel, tab state, and drafts. It never duplicates
tracked organization fields. On open, `ProjectWorkspaceService` composes those ignored fields with
tracked `editor.json` chapters/tags/recordMetadata into the internal `AuthoringProject.editor` state;
callers that need project content receive the complete composed editor state separately from the
editor-free content projection. Missing, corrupt, or unsupported local state is discarded; it cannot
repair tracked source. Its `workspaceRevision` is the tracked source baseline against which recovery
was produced, not an input to aggregate workspace identity. If the marker differs from the current
workspace on reopen, recovered values remain visible but are marked conflicted until Use Disk or Keep
Mine resolves them. Local-state writes neither rewrite tracked `editor.json` nor adopt tracked-file
revisions that the watcher has not reconciled. Tracked organization and ignored local/session state
are persisted independently, and ignored local/session changes do not change in-memory or on-disk
workspace identity.

New projects create `records/`, `scripts/`, and `assets/` but do not add placeholder files. Editor and
CLI creation use one transactional service: it stages and validates the complete workspace before
activating a new destination path that does not exist. Every existing file, directory, or symlink is
rejected, and paths containing spaces are supported. The editor's Browse action selects a parent
directory and derives a new child directory from the project name.
When `.gitignore` is absent, creation and Save As create it with `/.noveltea/` and `/dist/`; an existing file is
user-owned and preserved exactly. Save As reports a warning when that existing file does not mention
`.noveltea` or `dist`, leaving the user to choose the appropriate ignore rule. Save As
targets a project root and writes `project.json`; it carries tracked baseline, local editor state,
dirty-only asset bytes, and separately-owned workflows, while excluding generated agent/build/cache,
transactions, and trash state. A non-empty destination may contain unrelated user files, `.git`,
documentation, workflows, or unrelated assets, but Save As rejects any pre-existing NovelTea-owned
canonical source/state namespace (`project.json`, `properties.json`, `localization.json`,
`editor.json`, `records/`, `scripts/`, `.noveltea/transactions/`, or `.noveltea/editor/`). It also
fails if an exact Asset source destination is already occupied. Save As therefore never silently
merges stale records, Layout companions, Script Module sources, local transaction/recovery state, or
unrelated bytes at an Asset path into the copied project.

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
`essl-100`, and `essl-300` through the standalone `noveltea` native tooling boundary. The retired
`noveltea-editor-tool` executable and standalone released shaderc process are not part of the current
workspace/toolchain contract.

In `--json` mode, expected successes and failures emit exactly one compact JSON object plus one LF on
stdout and keep stderr empty. The envelope always includes `success`, `exitCode`, and `diagnostics`;
diagnostics are deterministically ordered and carry stable code/path/message fields plus source
location when available. Exit codes are `0` success, `2` CLI usage, `3` workspace/discovery, `4`
semantic/preflight, `5` mutation/concurrency, `6` native shader-tool failure, and `70` unexpected
internal failure. See `../CLI.md` for the permanent public command/protocol contract and
`PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md` for editor/external reconciliation semantics.
