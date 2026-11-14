# Agent-editable working sources (#624)

**Status:** contract and fixtures fixed by #624; publication, import, observation and
validation are implemented separately by #625–#629. No part of this document claims
that the editor currently publishes these files. [ADR 0002](../../adr/0002-agent-editable-working-sources.md)
records why the interface is file-backed.

## Authority and layout

An agent launched by any harness, or given **Copy prompt**, can edit ordinary files
inside a selected Project without a running editor. **The saved authored sources remain
the tracked Project files.** The acknowledged native ProjectSession working state and
its atomic `.noveltea/editor/native-dirty-state.json` checkpoint remain the only durable
recovery authority for editor-acknowledged mutations. `.noveltea/editor/state.json`
continues to hold renderer-only drafts and view state. Agents must **not** change
either of these internal JSON files. The working-source tree is a **projection and an
external proposal**, not an additional canonical Project or an automatic Save.

All paths below are relative to `.noveltea/editor/working/`:

```text
manifest.json                             # editor-owned publication ledger
files/project.yaml                       # projected dirty physical source
files/records/rooms/hall.yaml             # exactly the unsaved, editable YAML
files/i18n/locales/fr.yaml               # dirty localization fragment
files/scripts/helper.lua                  # dirty freeform text
files/records/layouts/menu/layout.rml     # Layout companion source
deletions/records/rooms/old.yaml.delete.json
pending/records/rooms/hall.yaml.json      # text that cannot enter structured YAML yet
baselines/<sha256-hex>.blob                # immutable last-published byte evidence
```

`files/<source path>` uses the **same physical Project-relative path** as its tracked
counterpart (but under `files/`); there is no duplicated Save-unit namespace or
hidden owner ID. In particular, native owner `project` means `project.yaml`, `traits`
means `traits.yaml`, `editor` means `editor.yaml`, `rooms/hall` means
`records/rooms/hall.yaml`; Layout companions and freeform `scripts/`/`shaders/`
remain separate text sources. `project.yaml` includes the portions owned by Project
Settings, export, and the Interactable Instance registry. `editor.yaml` includes
chapters, tags, and record metadata. Distinct logical Save units sharing a physical
file must produce **one** working file, not competing copies. Localization includes
`i18n/project.yaml`, `messages.yaml`, `usage-notes.yaml`, `tracking.yaml`,
`orphans.yaml`, and sparse `i18n/{locales,assets}/<locale>.yaml` chunks. All ordinary
record collection YAML and `records/layouts/<id>/layout.{rml,rcss,lua}` are supported.
The exact accepted physical path inventory is
`isWorkingSourceOwner()` and `workingSourceForNativeOwner()` in
`editor/src/shared/project-workspace/working-source-contract.ts`.

**Unsupported:** binary Asset data (including uncommitted imported/edited binary
bytes), ComfyUI `workflows/`, generated media, transaction journals, caches, and
arbitrary Project files outside these authored text families. These retain their
existing save/edit interfaces. A user-facing repair prompt must state when relevant
content cannot be represented by this projection; it must not claim to expose every
binary or silently discard a dirty text source.

For a dirty owner with present content, `files/<path>` holds the **exact intended
source text**, not a normalized whole-record dump: retain comments, sparse
omissions, explicit defaults, line endings where source buffers preserve them,
malformed YAML, semantically invalid field values, and raw Lua/RML/RCSS/shader text.
Use the existing native source-aware writer over the saved text for structured
changes; where the user is editing raw malformed text, publish the raw buffer
verbatim. Never regenerate synthetic valid YAML to conceal invalid user work.
New unsaved files/records use `files/<path>` with physical `diskRevision: "absent"`.
For a pending source deletion publish **no** `files/<path>` and instead the exact
UTF-8 marker `{"deleted":true}\n` at `deletions/<path>.delete.json`.
A missing working file is **not** a deletion instruction; the marker is explicit.
Conflicting presence of file and deletion marker is invalid and preserved for
review, not arbitrarily ordered.

Text visible in the editor that cannot yet become authored source (e.g. `-` in
a numeric field, a still-invalid raw form draft, or uncommitted named text)
uses `pending/<path>.json` with strict
`{"fieldText":{"/logical/path":"raw text"},"namedText":{"stable-draft-id":"raw text"}}`.
The keys must identify the physical owner and stable native/renderer field or draft
owner, not a tab instance. A pending-only owner has **no** `files/` artifact and
is recorded as `pending-only` in the manifest. An unsubmitted content-bearing
draft must be flushed to native first, represented faithfully as pending text,
or explicitly reported as unprojectable before providing an AI prompt. Do not
quietly omit visible unsaved work. Ephemeral selection, cursor, layout and preview
state are not authored content and need no projection.

## Revision and publication contract

`manifest.json` is strict same-build editor-local metadata with
`schema: "noveltea.editor.working-sources"` (not a new independent Project
Workspace version), canonical `projectRoot`, `projectId`, increasing
`publication` counter and a map keyed by the canonical physical source path.
Each entry has `representation: file | deleted | pending-only`,
`publishedRevision` (SHA-256 of last published source bytes or tombstone;
null for pending-only), `pendingRevision` (SHA-256 of pending JSON bytes or
null), `diskRevision` (native exact-byte `xxh3-128:<32 hex>` or `absent`),
`checkpointRevision` (SHA-256 of the acknowledged checkpoint bytes used for
this entry), and `localStateRevision` (SHA-256 of renderer local-state bytes
when they contribute a pending draft; otherwise null). All entries must
identify the same admitted Project; root/identity must match before import.
Unknown shapes and missing revisions fail closed. File bytes are compared, never
file mtime, decoded/re-encoded text, or a global Project revision.

For each `publishedRevision` or `pendingRevision`, keep the corresponding
immutable exact-byte `baselines/<digest>.blob`. Validate that its SHA-256 equals
its filename and manifest revision **before** using it. Baselines are *comparison
evidence only*; they are neither a second recoverable native checkpoint nor
permission to overwrite Project files. The hash of a current working file can
change when an agent edits it; the publisher must not update the old baseline
or manifest hash to make the change appear editor-owned.

Publication operates per affected physical owner after a **successful durable
native checkpoint acknowledgment**. Publish immutable baseline blobs first,
then working files/markers/pending artifacts by same-directory atomic replacement
against the last observed bytes, then atomically replace and sync the manifest
last. The manifest is the commit marker, not a license to overwrite intervening
edits. For this initially minimal layout, a crash after writing an artifact but
before the manifest commit leaves an ambiguous observed revision: treat it as
an **external or torn publication**, preserve the bytes, and reconcile or warn.
An orphaned baseline blob is harmless and may be collected later only if no
manifest entry or unresolved recovery references it. Use bounded reads,
debounced per-owner publication, and avoid full-Project parsing or snapshotting.
Flush a coherent publication before **Fix**, **Copy prompt**, **Run**, close,
switch, and required durable handoffs; failure to flush must be reported, not
quietly advertised as an up-to-date working copy.

## Reconcile, Save and recover

Let **B** be the exact immutable last-published working bytes; **N** the latest
acknowledged native working value; **A** the observed agent-edited working bytes;
and **D** the current verified physical saved Project source. Use the existing
native owner/path reconciler: derive `B→N` and `B→A`, then reconcile the candidate
against `D` using the native saved-source baseline and source revision. Disjoint
logical paths may merge; equal or ancestor/descendant paths conflict, and
structural arrays conservatively conflict. For malformed/unparseable raw text,
deletions, unknown baseline evidence or incompatible source shape, retain both
variants and create a whole-owner/text conflict instead of guessing a field
merge. Retain original comments/source text and existing comment-impact review.
An agent modification becomes native working state **only after validated native
admission and durable checkpoint publication**; it is never silently saved to
the tracked file. Keep Mine must recheck the physical disk revision; Use Disk
changes only conflicting native paths; Continue Editing retains the evidence.

When the editor is **closed**, the working files remain present. A standalone
agent edits them directly. On the next Project Open, after verifying root/ID and
restoring the native checkpoint, inspect **only manifested working owners** and
their exact revisions **before any new publication/pruning**. Import changed
artifacts through the same native reconciliation path and persist the resulting
checkpoint before the projection is refreshed. No editor connection, socket,
headless editor, provider-specific protocol, or CLI daemon is necessary.
If the checkpoint is corrupt, missing, quarantined or belongs to another Project,
retain working artifacts for explicit recovery and do **not** promote them to
trusted native state without verified attribution. Invalid working manifest,
missing artifact, changed/invalid baseline, malformed pending JSON, agent edit
during a publication, and simultaneous file/deletion marker must be reported
without deleting or clobbering any evidence. Re-read and CAS before committing.

When the editor is **open**, extend the existing Project-local file observation
and serialized native mutation lane with a **narrow working-path exception** to
the normal `.noveltea/` exclusion. Do not add another broad Project watcher or
reparse every authored file. Ignore editor-originated manifest/baseline writes;
settled changed working source/pending/deletion paths prompt the same per-owner
import and native conflict UI as offline edits. A late watcher event may never
target a different Project session.

Standalone `noveltea validate` continues to validate saved Project files by
default. The explicit working-source validation mode planned in #628 must read
the manifest and only its represented owners, overlay them onto a read-only
native validation view, and report source-located errors (including invalid
raw text and unresolved pending drafts). It must neither require a live editor
nor import, acknowledge, Save or rewrite the projection. If identity, baseline
or source revisions cannot be verified, return an indeterminate/failure result
rather than a false successful validation of just the saved Project.

**Save/Save All:** first reconcile observed external working edits. Save only
requested safe logical Save units using native source CAS; let independent units
commit while conflicted ones remain dirty. Advance or remove their working
projections only if the observed artifact still matches the reviewed revision.
**Undo/Redo or discard:** republish the resulting acknowledged native state;
never prune a file modified by an agent in the interim. Clean owners have **no
working files or pending markers**. A fully clean, reconciled Project may have
no `manifest.json` and may garbage-collect unreferenced baselines.
**Close/switch/reopen:** flush checkpoint first, then projection; failed
projection publication is a visible recoverable warning, not a reason to lose
acknowledged work or write tracked YAML. **Copy As:** snapshot native checkpoint,
working artifacts and all referenced baselines coherently and rebind the
manifest root/ID to the destination; preserve agent edits without treating them
as saved source. If a concurrent edit prevents a coherent copy, fail Copy As
without losing either Project's files, rather than copying a stale manifest.
**Failed I/O / races:** preserve original evidence, mark projection stale,
disable any claim that an agent has the latest editor state; retry with fresh
revision proofs only after reconciliation.

Editor-owned writing/cleanup may target only validated paths beneath the
canonical Project-local `.noveltea/editor/working/` tree. Reject symlink or
non-directory components (including the working root), symlinked target files,
lexical escapes, unexpected file types, and a parent replaced between check
and rename; use fail-closed handle/identity checks and target CAS, not a single
time-of-check path validation. Do **not** prohibit launching an ordinary harness
because an unrelated Project symlink exists. The agent runs under the user's
normal tool permissions; editor containment is enforced only for editor writes.

## Executable fixtures

`editor/src/renderer/test/fixtures/working-source-projection/` pins the
physical layout, SHA-256 base blobs, an unsaved commented Room, malformed raw
YAML, a new Lua file (`absent` physical revision), a deletion tombstone and
invalid pending text. `working-source-contract.test.ts` verifies their exact
bytes, mapping, revision behavior and rejection rules. These fixtures are **not**
a fake publisher; #625–#629 must exercise the actual publisher, offline/live
importer, existing source observation and independent standalone CLI behavior.
