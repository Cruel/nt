# Project Workspace Format

NovelTea projects use workspace v1. A project's identity is its root directory; its manifest is
always `<project-root>/project.json`. Normal editor, compiler, preview, export, and workspace open
paths accept no legacy monolithic project file or alternate manifest name.

## Tracked source

`project.json` has schema `noveltea.project.workspace` at version `1` and owns project identity,
project settings, top-level export configuration, the stable Bootstrap Module reference, entrypoint,
Project-level Inventory declarations, and the infrastructure-level `interactableInstances` registry.
The Instance registry is not an Explorer collection and is not persisted under `records/`.
`/settings` is the
Project Settings subtree; `/export` is the independent Export save-unit subtree containing the
built-in Runtime Package policy and portable platform profiles. Profile selection and other execution
choices remain editor-local. `traits.json`, the tracked `i18n/` tree, and `editor.json` are required
contextual source. The canonical Message model is physically split for source-owner and locale merge
locality: `i18n/project.json` owns Source/Default/locale policy plus the managed Source-locale lock;
`i18n/messages.json` owns explicit local/named Messages, structured ownership overrides, and Message-level Context/Translator-note
guidance; `i18n/usage-notes.json` owns authored per-occurrence Usage notes; `i18n/tracking.json` owns
managed free-form source tracking; `i18n/orphans.json` owns disappeared Messages with retained work;
`i18n/locales/<locale>.json` owns sparse target translations; and `i18n/assets/<locale>.json` owns
sparse localized-Asset targets. Empty locale/Asset chunks are absent rather than placeholder files.
The composed model has one Source locale, one Supported Default locale, explicit
Supported/work-in-progress locale metadata with optional parent locale inheritance, and a nullable
`sourceLocaleLock`. Once substantive target translation or localized-Asset work exists, parsing
materializes that lock to the current Source locale; subsequent file-first edits that change
`sourceLocale` while retaining the lock are invalid. Stable UUID
identities for explicit local/named Messages, sparse target translation records keyed by stable
Message identity, sparse `structuredMessageIds` ownership overrides used only when an editor-mediated
semantic refactor must preserve an existing structured Message identity across a path change, and
`sourceMessageTracking` entries for free-form managed Lua/RML occurrences. Those entries are keyed by
source family plus semantic owner/source path and keep the last managed source/guidance occurrence
snapshot together with compact source-snapshot, structural, anchor, and source fingerprints and the
durable Message ID; they never inject opaque tracking IDs into Lua, RML, or structured gameplay JSON.
`orphanedMessages` retains disappeared free-form Message snapshots plus valuable target translation,
review, provenance, and guidance work outside the live catalog until an author relinks or discards it.
Each target translation record stores target text, the compact
semantic source fingerprint it was translated from, current-content origin (`human`, `ai`, `imported`,
or `unknown`), human review state (`needs-review` or `reviewed`), optional compact provider/model
provenance, and optional presentation/guidance acknowledgement fingerprints. Missing is represented by
absence. Current/Outdated freshness and presentation/guidance attention are derived by comparing those
fingerprints with current source/guidance; they are not additional persisted workflow enums.
Schema-designated player-facing structured text remains colocated with its owning Room, Dialogue,
Scene, Verb, Map,
archetype, or other gameplay record. Structured local Messages normally derive an opaque stable
Message identity from semantic record/nested IDs plus the field role/path; an ownership override wins
when a known refactor has moved that same Message. Source prose is therefore not copied into the detached `i18n/` Message records,
does not participate in identity, and survives prose edits, stable-ID reordering,
and editor-mediated owner renames without losing target translations or Message identity. Ordinary IDs, record labels,
developer notes, filenames, and generic gameplay strings are not localized merely because they are
strings. Direct structured-file edits are discovered read-only from the same deterministic ownership
rules. Managed Lua/RML edits are likewise analyzed read-only; `noveltea localization sync` is the
explicit mutation boundary that materializes definitely new identities and deterministic one-to-one
tracking updates. Ambiguous duplicate/many-to-many cases remain unresolved for `noveltea localization
reconcile` rather than being guessed. Reconciliation can relink a current occurrence to exactly one
prior/orphaned Message identity, create independent new identities, move valuable abandoned work to
Orphaned storage, and garbage-collect valueless stale tracking. Validation, preview, source analysis,
and passive editor watching do not
materialize tracking metadata or dirty the workspace. The editor's
Localization workspace joins these derived Messages with explicit Messages for translation and usage
views. Identical local source text is only an informational reuse hint. Promotion to a named Message
keeps the canonical stable Message ID and target/review/provenance work, then rewrites only explicitly
selected supported structured, managed Lua, and RML usages to the named key in one Project mutation.
Conflicting target work blocks linking instead of being discarded. Making one usage of a shared named
Message local rewrites that supported structured/Lua/RML usage transactionally; it gets a new stable
Message identity when other named references remain, while demoting the sole remaining usage preserves
the existing stable identity. Existing target work is only copied to a newly independent local Message
when the author explicitly selects the disclosed locale/content drafts, and every copied target becomes
Needs review. Merging an independent local or named Message into a named Message requires an explicit
per-locale choice wherever both identities carry differing target work, so no translation is silently
lost. Record duplication keeps named references as references while duplicated local structured ownership
derives an independent Message identity. Named-key rename similarly updates all recognized structured
named references, managed `Text.msg` calls, RML `<nt-tr key>` references, and typed Message Property
values without retaining an old-key alias. Human material edits through the Localization workspace create current Human + Needs review
content; reviewing unchanged AI content preserves AI origin. Accepting an unchanged target against a
new source fingerprint advances freshness without changing review. `/localization` remains the
`project:localization` logical manual save unit even though its physical file set is the derived
`i18n/` fragments above. Language, explicit Message, Usage-note, tracking, target-translation, and
localized-Asset edits therefore commit atomically through the same revisioned Project Workspace
transaction/recovery path as other tracked project content. `traits.json` owns the self-contained Trait contracts;
there is no top-level identity Property fragment. `editor.json` contains exactly collaborator-visible
`chapters`, `tags`, and `recordMetadata`, including collaborator-visible Trait color metadata.

Records live under `records/<collection>/<id>.json`; Layouts instead live under
`records/layouts/<id>/layout.json`. IDs are canonical file identity and must match the stored record
ID. Unknown `records/` collection directories and noncanonical record paths are structural errors.
Missing known collection directories mean empty collections.

File-backed Layout channels are `layout.rml`, `layout.rcss`, and `layout.lua` beside `layout.json`.
The JSON selectors use `file`, `asset`, or (only for Lua) `none`; source text is not duplicated in
the Layout record. Script Module file sources use `{ "kind": "file", "path": "scripts/...lua" }`.
Their paths are safe project-relative `scripts/` paths. Assembly presents both as the existing
internal inline Lua/Layout model, so file presence never grants autorun behavior. `bootstrapModule` names the one Script Module imported synchronously in each fresh Project VM.

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
repair tracked source. Recovery is scoped per logical save unit: each dirty recovery entry stores only
the exact physical baseline revisions for files that unit depends on. There is no root
`workspaceRevision` in local editor state. On reopen, NovelTea checks only those recovery-dependent
files; a changed dependency reopens that unit as conflicted until Use Disk or Keep Mine resolves it,
while unrelated tracked-source changes do not invalidate the recovery entry. When one successful save
changes a physical file shared by another dirty logical owner, the remaining recovery entry advances
to the newly committed exact revision before local state is persisted. Local-state writes neither
rewrite tracked `editor.json` nor adopt tracked-file revisions that the active workspace session has
not reconciled. Tracked organization and ignored local/session state are persisted independently, and
ignored local/session changes do not change in-memory or on-disk workspace identity.

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
canonical source/state namespace (`project.json`, `traits.json`, `i18n/`, `editor.json`,
`records/`, `scripts/`, `.noveltea/transactions/`, or `.noveltea/editor/`). It also
fails if an exact Asset source destination is already occupied. Save As therefore never silently
merges stale records, Layout companions, Script Module sources, local transaction/recovery state, or
unrelated bytes at an Asset path into the copied project.

## Portable Project bundle

`.ntproject` is the portable editable-Project transport and is independent from runtime-only `.ntpkg`.
Its current compatibility boundary is `noveltea.project.bundle` version `1`. Export writes a
deterministic ZIP containing `ntproject.json`, every canonical tracked workspace file, every referenced
Asset source byte file, and Project-owned `workflows/` files. The manifest records the current Project
Workspace identity/version, Project identity/name, and one sorted exact file inventory with byte size
and SHA-256 for each Project-owned payload file. Archive entry metadata is fixed rather than copied
from local filesystem timestamps or permissions.

The bundle never carries `.noveltea/`, `dist/`, VCS metadata, `.gitignore`, agent bootstrap files,
transaction/recovery state, caches, or unrelated workspace files. Import rejects malformed ZIP
structure, unsafe or duplicate paths, non-regular entries, unsupported bundle/workspace identity or
version, malformed/noncanonical manifests, undeclared or extra authoring files, size/hash mismatches,
and an invalid contained Project Workspace. Import assembles into a sibling staging directory,
reconstructs the exact current Project-owned inventory from the opened Project, and atomically activates
only a destination that still does not exist. A successful import is therefore an ordinary current
Project Workspace with no special post-import representation or compatibility mode.

Desktop handoff uses that same importer. Installed editors associate `.ntproject` with NovelTea and
normalize both operating-system file-open delivery and the custom protocol into one pending import
request. Website handoff uses the fixed form
`noveltea://import?url=<encoded-https-ntproject-url>&sha256=<64-hex-digest>&name=<optional-name>`.
Only credential-free HTTPS artifact URLs ending in `.ntproject` are admitted. Remote content is
streamed into temporary storage with a 512 MiB hard limit and SHA-256 verification before the
portable-bundle validator sees it. The temporary download is never activated directly.

Every desktop handoff is confirmation-only until the renderer supplies a Project name and a new
destination directory. The import dialog pre-fills those values using the artifact name and the same
default Project location used by New Project, but neither a local file-open nor a remote protocol URL
may silently create a workspace. After validation and atomic activation, the editor opens the imported
Project through the ordinary Project-open/session path. A confirmed name change is applied while the
validated bundle is still staged, so the activated workspace has the user-selected Project name.

## Headless CLI editing boundary

The TypeScript Node reference CLI uses `noveltea [--project <project-directory>] [--json]
<command> ...`. Without `--project`, it walks upward from the current directory and selects the
first `project.json`. Finding a malformed NovelTea manifest, the wrong workspace schema identity,
or an unsupported workspace version stops discovery at that directory; discovery never falls
through to a parent project and never considers retired manifest names. `--project` is an explicit
project-root override and is validated by the same workspace-v1 rules.

Ordinary agent edits are direct edits to tracked JSON, Lua, RML, and RCSS source files. Managed
localizable Lua/RML edits are followed by `noveltea localization sync` and then `noveltea validate`;
all passive discovery remains read-only. Semantic commands are reserved for operations that need
project-wide graph or transaction semantics: `localization sync`, `localization reconcile`,
`localization view`, `localization accept`, `localization review`, `entity create`, `entity rename`,
`entity delete`, and `usages`.
`localization view` is read-only and joins normalized target records with current source/guidance and
derived workflow status; `localization accept` and `localization review` are independent revisioned
mutations. `localization sync --dry-run` reports the deterministic tracking plan
without writing; normal sync commits only localization tracking through the Project Workspace
revisioned writer and never rewrites the source file merely to store identity. `localization
reconcile` is read-only when producing a plan; `--apply` consumes a JSON plan/resolution object whose
expected workspace revision and reconciliation fingerprint must still match before the normal Project
Workspace writer transaction may commit the affected canonical `i18n/` fragments atomically. Stale plans are recomputed/reported and
never overwrite a newer editor or CLI decision. `entity create` uses the same authoring record defaults as the editor and does not provide a generic Asset
creator. Rename/delete source-reference policy comes from the shared dependency graph: recognized
rewriteable references are rewritten on rename, exact manual references block rename, possible
lexical references require `--allow-possible-source-references`, and delete still requires `--force`
for exact blockers independently of the possible-reference acknowledgement.

`--dry-run` performs discovery, assembly, graph/source preflight, and file projection without writing
tracked or ignored project files. If a pending transaction would require recovery, a dry run fails
closed instead of changing journal state. Non-dry-run semantic mutations persist through the same
workspace transaction service used by editor structural writes.

`noveltea validate` uses the shared authoring compiler/validation and dependency/source-analysis
pipeline. Clean disk validation may publish an immutable Project-local authoring-cache generation
containing the exact source inventory, canonical diagnostics, and a digest-protected per-source
contribution artifact. Each canonical authoring source contribution is keyed by its Project-relative
path and exact content hash and retains its normalized parsed JSON fragment or source text, schema
admission, precise semantic owner paths, and only validation diagnostics whose inputs are provably
confined to that physical source. Attribution alone does not make a cross-record/reference finding
source-local. The same artifact retains dependency-graph contributions and source-analysis products
with the exact source revisions they depend on. Source-analysis products additionally depend on the
complete analyzed-source revision set because analyzer byte/occurrence limits are snapshot-wide;
Asset-backed text sources participate through their exact external source-file revisions. A stale
whole-validation result may therefore rebuild from cached normalized fragments without rereading or
reparsing unrelated unchanged JSON sources: fresh fragments are normalized by their owning schemas,
and malformed or otherwise uncertain input falls back to the canonical full-Project parser.
Changed-source semantic contributions are filtered out. If only metadata changed, the affected source
is reread and hashed; exact byte identity re-admits the prior contribution. Added, deleted,
structurally reclassified, or otherwise uncertain candidate-source inventory disables contribution
reuse conservatively. This layer currently reuses source assembly contributions while complete
Project-wide semantic validation still runs after a partial reassembly; dependency-aware validation
consumes the retained semantic products separately.

Projects with authored Shaders or Materials also run shader readiness for `glsl-330`, `essl-300`, and
`metal` through the standalone `noveltea` native tooling boundary. The retired
`noveltea-editor-tool` executable and standalone released shaderc process are not part of the current
workspace/toolchain contract.

In `--json` mode, expected successes and failures emit exactly one compact JSON object plus one LF on
stdout and keep stderr empty. The envelope always includes `success`, `exitCode`, and `diagnostics`;
diagnostics are deterministically ordered and carry stable code/path/message fields plus source
location when available. Exit codes are `0` success, `2` CLI usage, `3` workspace/discovery, `4`
semantic/preflight, `5` mutation/concurrency, `6` native shader-tool failure, and `70` unexpected
internal failure. See `../CLI.md` for the permanent public command/protocol contract and
`PROJECT_EXTERNAL_CHANGES_AND_CONFLICTS.md` for editor/external reconciliation semantics.
