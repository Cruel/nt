# Native authoring Project worker (#496)

The host-only Node-API Project adapter lives in
`tools/project_authoring/authoring_node_addon.cpp`. It owns the current
`ProjectSession` on a dedicated Node worker thread and exposes only the native
session handle plus `snapshot`, `inspect`, `observe`, `hint`, `coverageLost`,
`patch`, `save`, and `close`. Native handles never cross worker IPC and
all calls are serialized by the worker event loop.

`editor/src/main/services/native-authoring-worker.ts` polls the C++ source
observer outside the Electron main/renderer threads, initially at 200 ms.
Each observation verifies exact physical source bytes; OS watcher hints are
not evidence. The worker posts a typed initial source snapshot at sequence
zero and subsequently publishes monotonically numbered deltas with
Project-relative paths, exact SHA-256 revisions for changed/added source paths
(`absent` for removals), changed record owners and attributable invalid-source
diagnostics. Physical deltas are **not** interpreted as newly normalized or
compiled record values; resident cross-record reconciliation remains a later
native migration task. Main-thread consumers must not apply these provisional
physical changes as complete semantic Project data.
For changed Room/Map sources, the addon reopens a file only after its bytes
match the observer's exact revision and runs the native sparse-source validator.
Record-scoped diagnostics remain available until a verified repair or deletion;
a malformed record is reported without claiming the physical observer lost
coverage.
After successful normalization, the worker also runs the native Room/Map
local semantic validator (including duplicate exit directions, placement and
presentation invariants), publishing record-absolute paths for both structural
and local semantic errors. This does not substitute Project-wide cross-record
reconciliation.

`native-authoring-session-bridge.ts` is an opt-in **main-process** owner:
the caller supplies a current opaque `projectSessionId`, which it verifies
through `ActiveProjectSessionService.requireActiveProjectRoot` before creating
the worker. Only the main process supplies the canonical root and selected
addon path. No renderer path, daemon subprocess, preload capability, or
production Project writer is introduced by this ticket.
Every worker event is runtime-parsed, checked against its session ID and
generation, and checked against current main-owned Project authority.
Out-of-order deltas and command responses fail the session closed. Project
switch, close, worker crash, invalid messages or a native failure terminate
the worker, revoke pending requests, and permit a fresh authorized `open`.
Subscriber errors cannot break the transport. Native operations never block
the renderer or main-process event loop.

The project-authoring host build disables the Node addon by default. To
certify explicitly on Linux with Node headers installed alongside the Node
executable:

```sh
cmake -S tools/project_authoring -B build/native-authoring-worker \
  -DCMAKE_BUILD_TYPE=Debug -DNOVELTEA_BUILD_AUTHORING_NODE_ADDON=ON
cmake --build build/native-authoring-worker --target noveltea-authoring-node
pnpm -C editor exec vp pack
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-worker/noveltea-authoring-node.node" \
  pnpm -C editor exec vp test run src/renderer/test/native-authoring-worker.test.ts
```

The differential test copies canonical Project source fixtures from Feature
Lab into a temporary root, verifies real Node-API loading and Project
snapshot delivery, observes an independent Room-file change without a
renderer request, and exercises concurrent mutation/observation, stale
revision rejection, Project identity rotation, failure and restart. Fake
transport tests verify ordering, authority and worker-crash behavior without
the native binary. The Linux CI host-contract job builds and exercises the
real addon. The binary is **not** installed into any shipped editor or
runtime artifact; platform-specific addon distribution and production
Project model cutover remain separate tasks.

## Parallel dirty-working certification (#497)

The native Project session accepts atomic batches of Project-absolute JSON
Pointer `add` / `replace` / `remove` operations across the manifest, Rooms,
and Maps. Its Project working revision advances **once per changed batch**,
not once per file or field. Room/Map operations route through
`/rooms/<id>/...` and `/maps/<id>/...`, validating unsaved source-space data.
The read-only `inspect` operation lazily provides a record's initial native
working snapshot before the first editor action without advancing revision.
Malformed operations roll back every owner in the batch; representable but
semantically invalid fields remain dirty working data with exact
record-absolute diagnostics. Snapshots expose the touched record working and
normalized values, plus targeted affected-record and diagnostic deltas.
Patch responses transmit only modified Room/Map snapshots; the main-owned
adapter merges those deltas with its retained working view. Manifest-only Save
does not silently commit a mixed dirty batch: it rejects while Room/Map
working owners remain dirty. Net-zero patch batches do not advance revision.
Additional record families were admitted in the subsequent #498 certification.

`native-authoring-working-project.ts` adapts the existing editor command
bus's generic forward/inverse patches, without per-UI-action native methods.
It mirrors undo/redo, history cursor and dirty status without replacing the
production TypeScript history. Partially typed or otherwise unrepresentable
form text is held separately in a main-owned pending-input map and cannot
enter native JSON/YAML.

The main-side journal retains **only acknowledged** batches. On worker
termination, an authorized reopen replays them against saved sources with
exact disk-revision preconditions per affected Room, Map and manifest owner.
A changed source fails closed, rather than silently adopting or overwriting
external edits. Replay is pinned to the original active Project session and
cannot apply to a different Project merely because source hashes match.
Replay never commits unsaved content to disk. The journal
and pending-input map are certification-session memory only, not persistent
editor recovery data, and cannot survive a terminated Electron main process.

This adapter is opt-in for certification tests: renderer edits, Project
open/Save, editor recovery, external reconciliation, daemon, CLI, and runtime
authority remain TypeScript. Full source-record admission, other record
families, durable native recovery and Project-wide native reconciliation are
still cutover work, not permanent TypeScript/native fallback paths.

## Parallel external reconciliation and scoped Save (#498)

The native resident Project now retains explicit saved and dirty source values
per loaded owner. `reconcile` opens the exact current physical source revision
and computes a three-way diff against the admitted baseline. Disjoint changes
within the same YAML record or shared tracked source are merged into the dirty
working values, preserving the local edits and advancing the verified baseline.
Overlapping fields and structural array changes remain locally edited and
expose `conflictingPaths`. `useDisk` discards exactly one owner's unresolved
local working edits after checking that its reviewed disk revision is still
current; `saveOwners` blocks conflicts unless Keep Mine is explicitly selected.

All generated-schema record families (including Layouts) are routed by their
Project-relative owner and validated using the generated native contracts.
Tracked `editor.yaml` state is supported as the `editor` owner; editor-only
ignored recovery and preferences are not source transactions.
Native certification also admits `traits.yaml` as an independent `traits`
owner. Its map-key identity, owner-kind and Property uniqueness, enum
constraints, and declared Property defaults are validated through generated
contracts and registered native refinements. Tracked editor source validates
chapters, tags, and record metadata, rejecting prototype metadata keys and
editor-local recovery/preferences. Both files are validated at admission,
separate from the Project manifest, and support generic edits and scoped Save.
Generic editor mutations also materialize omitted schema-defaulted Chapter/Tag
containers and the explicitly addressed dynamic record-metadata mappings.
Undo removes newly empty implicit containers again, so a reverted action does
not leave a spurious dirty `editor.yaml` source.

Scoped multi-owner Save uses the same #495 journaled native YAML transaction
writer, with Keep/Remove/Cancel comment decisions and exact source revisions
verified at both preparation and commit. A second overlapping external writer
cannot be silently overwritten. An invalid attributable source blocks its own
Save target without blocking unrelated targets; unknown source authority
uncertainty blocks every write. On success only committed owners have their
baseline advanced. Failed Save and canceled comment decisions leave dirty
working values intact. YAML inline empty mappings are replaced at their
own source location when adding children rather than performing an unsafe
flow-mapping peer insertion.

The main-owned certification adapter offers `reconcile`, `useDisk` and
`saveOwners` without adding renderer IPC or production authority. It rebuilds
the in-memory crash-replay journal against the newly verified disk baselines
after reconciliation, Use Disk and Save, and preserves unaffected undo/redo
history and transient pending input. All worker messages remain typed and
project-session/revision checked.

### Review hardening

Worker replay also restores unresolved conflict paths as native resident
state after replaying exact-baseline patches. This preserves the ordinary
Save block until explicit Use Disk or Keep Mine, even after a worker restart.
Reconciliation selectively invalidates undo/redo entries when an externally
changed path overlaps any retained forward or inverse patch; an old ancestor
inverse therefore cannot overwrite newly merged descendant fields.

Generic editor patch operations are projected from normalized to sparse
source-space values for implicit optional fields (with baseline omission
restored by undo) and compact references. Expanded `$ref` values and
`$ref/id` edits are projected onto their physical scalar reference IDs.
Adds into schema-defaulted, physically omitted collections materialize only
the necessary empty source containers; removing the last element on undo
restores omission when the baseline default is reached.
Unsupported parent transformations are rejected without changing working
data rather than silently replacing a different source shape.

Logical Save units, such as `record:rooms:<id>`, select the complete record
owner plus only its corresponding
`/editor/recordMetadata/rooms/<id>` subtree in shared `editor.yaml`.
Other metadata remains dirty and uncommitted. `useDiskOwners` applies the
same logical selection atomically across owners; scoped `saveOwners` uses
one revision-checked journal transaction. Logical owners are lazily admitted
before Save/Use Disk when not yet resident. Full-owner certification methods
remain for independent source-owner tests.
The Traits collection Save unit selects the `traits` owner. Chapters, tags,
and record metadata remain independent logical paths within `editor.yaml`:
saving Tags does not silently save dirty record metadata or Chapter changes.
Project Settings Save/Use Disk imports the authoritative
`PROJECT_SETTINGS_OWNED_PATHS` registry, including
`/export/assetMemoryPolicies`, rather than duplicating that path list.

## Split localization and managed Messages (#491)

The certification-only Project session validates the complete split `i18n/`
workspace through the generated `WorkspaceLocalization*` contracts and
registered native locale, Message-pattern, Project-policy, and Source-lock
operations. It assembles effective policy, explicit/named Messages, structured
Message ownership overrides, usage notes, managed Lua/RML tracking, orphaned
Messages, target translations and localized Asset targets without copying the
normalized defaults or Source lock back to YAML. Fingerprints, provenance,
review state, and optional translation acknowledgements remain source-owned;
translation freshness is derived by the existing localization workflow rather
than persisted as another enum.

Native diagnostics have `/localization/...` logical pointers and identify the
owning `i18n/*.yaml` file; invalid sparse chunks, Message arguments, selector
fallbacks, locale inheritance, reserved/duplicate named keys, orphan identity,
and tracking owner keys are reported without losing unrelated Project sources.
Existing localization fragments can be inspected as individual native working
owners, patched through `/localization/...`, and saved/reopened using the same
revision-checked, comment-preserving YAML transaction service. File additions
and removals for sparse locale chunks are not yet generic native working-session
edits; the certification validator admits or rejects their physical presence.
Untouched fragments are not rewritten on validation or unrelated Save.

Repeated Project snapshots reuse the native localization validation generation
until an `i18n/` owner, contributing gameplay record, or managed Lua/RML
buffer changes (including physical source observations). Native translation
checks project structured and tracked-only Messages and Dialogue Cues from the
working sources, not saved gameplay YAML when unsaved owners exist.
Characters and Interactables contribute structured localization without
owning Lua/RML analysis. Their edits invalidate localization independently.
Managed source identity uses structural and anchor fingerprints, with ordinal
fallback permitted only when the full-source fingerprint is unchanged. RML
identity candidates exclude named `nt-tr` nodes and embedded Lua calls.
Lua/RML tracking whitespace normalization follows ECMAScript Unicode
`/\s+/gu` and `.trim()` rather than locale-dependent byte classification,
so non-ASCII whitespace cannot detach an existing tracked Message identity.
Script project-file and Layout file/inline/Asset source descriptors resolve
through current working selectors, not guessed physical paths.
Production localization sync/reconcile and the eventual
single-authority cutover remain governed by the existing Project Workspace
contract and the parent native migration specification.

## Native Lua/RML source analysis and dirty buffers (#492)

The certification-only native Project session independently indexes admitted
Lua source files, Layout RML/RCSS companion files, inline Lua Script/gameplay
sources, Asset-backed Layout RML/RCSS, and declared script/template dependencies.
The host-side analyzer scans Lua literals and managed Text.tr,
Text.msg, Text.plural, and Text.select calls, including inline RML scripts and
event-handler attributes. RML external script/template references are also
represented in source-analysis results. Invalid literal/case/metadata uses,
unresolved named Messages, and undeclared RML script references produce
authoring diagnostic codes with physical source paths and line/column
locations. References and occurrences retain a source revision so dependency
and localization adapters can reconcile their provenance. Managed occurrences
also preserve selector branches, translator guidance, runtime argument names,
and source spans; unsupported Lua escapes mark analysis incomplete. This is a static
authoring adapter: it does not execute Lua or instantiate RmlUi. Lua decimal
and hexadecimal escapes are decoded as Unicode scalar values and encoded
as UTF-8, matching the TypeScript managed-source analyzer.

The resident session exposes sourceAnalyses, textSourceOverlays and
stageTextSource through its opt-in Node-API certification addon. A dirty
Lua/RML/RCSS buffer remains private to the working session, guarded by the
working revision and its admitted physical byte revision. Validation uses the
buffer without Save; a separate disk-authoritative session sees only the file.
Reverting to exact disk content discards the overlay. Content caches invalidate
only the edited or externally observed source; contributions are attributed to
consuming Script/Layout/gameplay owners, not rewritten into YAML. Canonical
sparse template Asset references are indexed alongside expanded references;
dirty Asset source-path retargeting reindexes consuming Layouts without
opening them as working owners. Trait/Variable dependents are discovered
through decoded YAML scalar references rather than physical substrings.

This slice does not replace the richer TypeScript source analyzer, authoring
dependency graph, managed localization synchronization, or production editor
source editor/CLI paths. Complete RML template and Asset-backed dependency graph
differential certification remains part of the atomic native cutover under #474.

## Dirty native preview and authored Tests (#499)

The opt-in native session provides a revision-checked prepareWorking operation
for preview and authored Tests. Its output contains normalized working Manifest
and localization values, only dirty record overrides (including Layout companion
sourceText), exact physical source revisions, text/shader overlays and native
diagnostics. A bad working source or stale revision blocks preparation without
writing Project files. Standalone CLI sessions remain disk-authoritative.

The certification-only main-process adapter checks that the native revisions
match a separately admitted saved workspace generation, combines its unchanged
records with the native working overrides, and sends that effective Project
through the **existing** runtime artifact compiler and authored Test spec
builder. Lua/RML sources are read from the native overlays; temporary physical
copies required for native runtime asset handoff live outside the Project root
and have an explicit disposal lifecycle. The adapter does not publish canonical
or preview runtime cache generations and does not change export Save policy.
Authored Tests dispatch through the current run-test/run-ui-test native operation,
not an authoring-worker interpreter. A superseded working revision is rejected
before returning the prepared artifact.

An optional per-session preparation cache keys runtime inputs independently of
working revision and authored Test records. A Test-only edit reuses the compiled
runtime while rebuilding the selected Test spec. Changed runtime source
revisions/text overlays or other runtime-owned data invalidate that cache
entry, leaving unrelated source-analysis contributions intact. Cache leases
retain temporary source overlays until borrowers finish; the owning session
clears its cache explicitly on close.

Saved shader files and shared includes beneath the Project shaders directory
contribute exact-byte revisions to cache identity. The main-process adapter
also rechecks their physical bytes before returning a cached artifact.

This is deliberately a parallel certification seam; the current renderer,
editor Play/Test coordinator and CLI/export remain unchanged. Later migration
work will replace the saved-baseline projection with fully unified native
working record admission, and close the remaining source/dependency
incrementality and compiler-overlay differential gates before production cutover.
Focused certification compares actual Feature Lab native dirty Room, Test, and
RML projections against its separately loaded saved Workspace.

Full production editor cutover, the existing renderer Save coordinator and
watcher replacements, Project-wide dependency reconciliation, and durable
restart recovery remain future coordinated migration work; the native
certification operations do not invoke the TypeScript Project authoring engine.

## Typed Variables, Properties, and Traits (#483)

The parallel native Project session now applies the existing generated
Property/Traits schemas and checks Variable enum declarations (including
ECMAScript-trimmed choices), typed Values, nullability, and dirty working
diagnostics. Its native cross-record checks compare attached Trait schemas and
Defaults against owner-local/definition Properties, resolve typed Variable and
Trait references from inspected records, and validate concrete Trait requirements.
Interactable Instance Values take precedence over Definition and Trait Defaults;
Instance Trait add/remove deltas and inherited Property-schema mismatches are
diagnosed at manifest-absolute paths. An Interactable's sparse YAML omissions
and compact authored references are projected to their typed effective shape,
without rewriting or expanding source on read.

Native snapshots recheck loaded dependents when a referenced Variable, Trait, or
Definition changes; edited manifest Instances are checked independently, using
their referenced Definition on demand. This certification slice does **not**
construct the entire effective Project or eagerly load every uninspected record.
Invalid dirty edits remain visible in the working session, and scoped Saves
reject typed invalidity or known invalid dependents without publishing partial
source. The Feature Lab Project-session certification exercises repair/diagnostic
deltas, cross-owner reference invalidation, Instance overrides, and exact
save/reopen behavior. Full-project dependency indexing and coordinated
production cutover remain under the subsequent migration tickets.

## Resident full-Project validation certification (#493)

`ProjectSession::validate_project()` is a separate certification-only boundary
from `snapshot()`: editor snapshots remain lazy, while a full check retains
native sessions for every tracked record and fixed/sparse YAML fragment. The
dedicated `validate_cold_project()` entrypoint inspects physically attributable
malformed saved fragments for cold diagnostic comparison; normal mutable
`ProjectSession::open()` retains its strict workspace admission contract.
Its result is a read-only diagnostic snapshot; malformed sources cannot become
editable or writable through this boundary.
The resident generation observes verified physical source revisions, compares
working record owners with their admitted baselines, and revokes local and
cross-record diagnostic contributions for changed dependencies. Unchanged
contributors retain their diagnostic codes, severities and navigation paths;
changed Lua/RML/RCSS files reanalyze their indexed consumers. Changes to Asset
sources and Layout companions also invalidate their physical-source-dependent
validation; those two record families cannot use YAML-only local memoization.

A full validation includes locally normalized record checks, referenced
Property/Trait/Variable, Interaction/Verb, Material/Shader, Test, Localization,
and the assembled Room/Map/Hotspot spatial graph. The spatial graph is reused
when unrelated sources change and still reports independent findings when an
unrelated tracked source is invalid. Malformed or missing current tracked sources
revoke their previous record evidence rather than publishing the stale
normalized value; missing declared Lua/RML files fail closed. Source-owner
navigation uses Project-relative physical paths and sparse YAML source
locations when the diagnostic has an attributable saved node. A general loss of
watcher authority invalidates prior certified results until a new physical
observation succeeds. The complete output remains diagnostic-only; it never
writes source or becomes the editor/CLI's production validator before #474's
coordinated cutover.

The native Project-session CTest exercises Feature Lab cold/warm equality,
unchanged contributor reuse, a single Room YAML edit, malformed and repaired
YAML, and changed, missing and restored Lua source. The Project record
normalization differential additionally compares native Feature Lab sparse
records across families with the authoritative TypeScript/Zod reader before
the compiler boundary. Other existing family-local and editor/CLI validation
certifications remain necessary for the final cutover.
