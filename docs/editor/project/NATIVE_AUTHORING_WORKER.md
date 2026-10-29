# Native authoring Project worker (#496)

The host-only Node-API Project adapter lives in
`tools/project_authoring/authoring_node_addon.cpp`. It owns the current
`ProjectSession` on a dedicated Node worker thread and exposes only the native
session handle plus `snapshot`, `inspect`, `observe`, `hint`, `coverageLost`,
`patch`, `save`, `semanticGraph` (the opt-in #536 query), and `close`.
Native handles never cross worker IPC and
all calls are serialized by the worker event loop.

## Revision-pinned semantic graph query (#536)

`semanticGraph(handle, expectedWorkingRevision)` returns native-derived read-only
records, trait and nested identities, localization Message realizations, role-aware
structural edges, exact source occurrences and candidate lexical occurrences.
The worker attaches its trusted Project session ID and generation; its strictly parsed
DTO is `nativeSemanticGraphSchema` in
`editor/src/main/services/native-authoring-worker-contract.ts`. The main-owned
controller refuses stale, cross-project and post-switch results. This query does
not publish or mutate the Project, compile gameplay or write source files.

The C++ session verifies native Project working revision and observed source inventory
at query entry/exit. For some Asset-backed sources, native source observation uses
`physical:<size>:<mtime>` identities while source analysis uses SHA-256 of content:
the query separately verifies the exact source bytes before and after extraction.
File-backed occurrences have `project:/` source URLs and native line/column evidence;
only simple single-owner, UTF-16-verified recognized physical literals may carry an
automatic source rewrite range. Missing or invalid owners are reported separately
without synthesizing edges from ambiguous strings; destructive preflight requires
complete current evidence.
The main bridge additionally verifies the inner DTO's session ID and worker
generation against the outer response, and the working adapter deep-freezes
all nested node, edge and occurrence objects before publication.

`native-semantic-graph-queries.ts` exposes presentation-only usage counts, lookup,
preview-impact filtering and preflight gating. It does not validate authoring semantics
or build a second graph. `noveltea-semantic-graph-certify` exercises a copied canonical
Feature Lab Project with real native records, dirty working revision changes and
physical mutation denial; `native-authoring-worker.test.ts` verifies the actual addon
and worker transport. The renderer's existing TypeScript graph is unchanged until the
atomic #521 cutover.

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
and removals for sparse locale chunks also use generic revisioned native
working-session edits, including whole-fragment create/delete and one atomic
multi-owner Save; the validator independently verifies their physical presence.
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

## Verified native clean validation reuse (#502)

The certification-only `ProjectSession::validate_clean_project()` is shared by
the existing CLI daemon Project owner and the editor's opt-in Node-API worker
(`validateClean`). Both read and publish
`.noveltea/cache/authoring/native-clean-current.json`, separate from the
existing TypeScript `current.json` and its semantic key. The native document
stores the complete diagnostic result, canonical Project root, semantic key,
exact per-source revision manifest, and an optional **clean-only** native
contributor bundle (per-owner valid flags and diagnostics, plus spatial
validation findings). It never persists editor working source, unsaved text,
mutable Project sessions or parsed record instances. Imported contributors
are materialized into session RAM by reopening each physical record and
rechecking its exact source revision. Legacy TypeScript manifests and older
native cache formats are rejected without a migration reader.
An inspected clean editor record with a superseded disk revision cannot
override the physical contributor and does not trigger repeated recomputation
after the new disk diagnostic is cached. Regression coverage asserts zero
rechecked records and semantic contributions on successive unchanged reads;
dirty inspected owners still retain their independent conflict semantics.

Clean cache admission verifies native physical-source authority and exact
source identities before and after reuse. For referenced binary Assets it
hashes bytes rather than using watcher size/mtime observations as proof.
Missing/changed files, uncertain authority, corrupt or incompatible payloads,
and unavailable cache paths fall back to ordinary full native validation.
Publication additionally matches the source manifest captured **before**
validation to the manifests re-proved after validation. Two matching
post-validation manifests cannot authorize an earlier result; an interrupted
source-revision diagnostic is never persisted. Only a clean disk Project publishes: dirty native record patches and unsaved
Lua/RML or shader buffers remain exclusively working-session diagnostics and
cannot publish or replace disk generations. Ordinary warm sessions retain
unaffected validation contributors on single-source edits. Imported cache
hits avoid initial full semantic validation, but native Project admission
and physical source proof are still mandatory. General Room, other record,
and external Lua/RML edits after import reuse unchanged native per-owner
contributions and recompute the affected semantic dependency closure. An
older result-only entry without a contributor bundle can still reuse a
strictly verified presentation-only Room/Map edit; otherwise it falls back
to full validation rather than pretending to have incremental evidence.
A lost watcher authority
coverage event also forbids an unvalidated cache hit until a fresh full
validation has completed, even when the physical rescan finds unchanged bytes.

This is an opt-in certification seam, not the coordinated production cutover
of #474. Feature Lab Project-session certification covers reuse between
independently opened CLI/editor-style sessions, dirty isolation, single-Room
rechecks (including substantive edits and Lua changes after an imported hit),
eviction/restart re-admission, watcher recovery, and legacy-cache rejection;
the editor worker test exercises the
typed response including source-aware diagnostics.

## Editor migration adapter certification (#504, in progress)

`NativeAuthoringWorkingProject` maps logical editor Save units to native
physical owners instead of treating a collection or Localization tab as one
manifest file. In addition to individual records and Project Settings, it
selects dirty record owners in Assets, Materials, Tests, Variables and Traits
collections, their tracked editor metadata, changed Localization `i18n/`
fragments, runtime export profiles and Project Explorer metadata. The selected
owners are saved with the existing native revision-checked transaction;
unrelated dirty owners remain in the native working session. Source-file Save
and other production coordination paths are not yet admitted by this adapter.

Unsaved Lua/RML/RCSS buffers staged in the native working session retain their
exact admitted disk-source revisions in the main-owned replay journal. On
worker restart, the authorized same-Project session verifies each text
source's original disk revision before restaging its last acknowledged
overlay. Returning to the saved bytes removes the overlay. A changed or
missing source rejects replay and closes the new worker rather than losing
unsaved text or overwriting the external edit. This is memory-only recovery,
not durable recovery after Electron main-process termination.

The `prepareCompleteWorking` worker operation provides a self-contained
effective native Project instead of only the manifest and dirty record
overrides. It performs full native validation, gathers normalized contributors
for every tracked record family, overlays dirty records including Layout
companion text, and re-observes physical source authority before returning.
Invalid records, stale revisions, or uncertain authority fail closed. The
older `prepareWorking` remains a cheap lazy-dirty projection; neither operation
writes source. The editor-side projection supplies only non-authored local
editor defaults and checks against the existing typed runtime contract.
The Feature Lab differential compares both entire saved Projects and mixed
dirty manifest/Test/RML edits against the independently loaded TypeScript
Workspace. Optional Layout dependencies preserve the old reader's omission
semantics.
For self-contained native preview/Test certification, the complete response
also includes the source authority's exact physical revision manifest,
including referenced binary Assets. `prepareNativeWorkingRuntime` accepts
this native-only input without a TypeScript saved-Project baseline, rehashes
the full manifest before compilation, and repeats those checks even on
runtime-cache hits. An externally modified Asset fails rather than returning
a stale cached artifact. Physical input pinning across the later compiler
execution and production editor migration remain part of the coordinated
cutover, rather than a second competing production authoring authority.

These additions are certified through the real addon and worker, **not** an
independent production editor authority. The current renderer Command Store,
Save coordinator, source watcher, validation, and runtime preparation still
use the existing TypeScript Project model until one coordinated production
handoff can guarantee the complete editor corpus and recovery behavior.

The Electron main process now has a **real Open/Create/Close lifecycle** for
native editor sessions, enabled for cutover testing with
`--certify-native-authoring-open`. On successful Project activation it opens
the main-authorized native worker, requests the complete effective native
Project, and compares tracked saved content to the existing editor Workspace.
Disagreement, unavailable native binaries, invalid native source and worker
failure reject admission without falling back to a second authoring writer.
Project switching, close and app exit revoke the native session; superseded
asynchronous opens cannot close a newer activation. Development launches use
`NOVELTEA_AUTHORING_NODE_ADDON`; packaged editor certification uses
`resources/authoring/noveltea-authoring-node.node`. A failing new Open does
not discard a still-active previous Project. Both mock lifecycle and real
Feature Lab worker tests exercise the gate.

The flag is **read-only certification**, not native editing mode: it does not
publish native patches to the renderer, run parallel Save transactions, or
replace the production TypeScript command/recovery/watch pipeline. Those
operations must be routed together before enabling native ownership by
default. Full native Project validation at Open is too expensive to impose
on regular editor starts before the migration's performance gates pass.

The separate `--certify-native-authoring-edit` flag now enables the real
renderer-to-main `NATIVE_PROJECT_PATCH` route for migration testing. Native
mutation requests carry trusted active Project session identity, exact working
revision and a strictly bounded JSON Patch batch; the native worker remains
the only accepted mutation authority. The main-owned bridge serializes edits,
preserves acknowledged replay evidence, rejects stale/out-of-order requests,
and refuses replies for closed or superseded sessions. The renderer's new
`executeCommandAsync`, `undoAsync` and `redoAsync` methods use the current
TypeScript command handlers only to **construct edit intent**; documents and
history publish only after native acknowledgment and exact changed-value
comparison against affected native source owners. Native refusal leaves the
current editor unchanged; a missing, contradictory, or lost accepted reply
freezes further native edits instead of silently falling back to TypeScript.
Uncommitted interactive transactions remain unavailable in this mode; the
native scoped structural auto-commit path is described below (#508).

The old synchronous command methods explicitly refuse changes under the
native-edit flag. Renderer record editors, the New Entity wizard, Room
composition, Project Explorer, Project Settings, assets, Localization, Test
record editing and shared Property dialogs now submit through
`executeCommandAsync`. Pending commands are serialized by Project session,
constructed against the latest *accepted* revision and cannot be replayed
into another Project instance; command batches retain atomic undo history.
Pending dialogs wait for acceptance rather than closing on a speculative
TypeScript projection. In particular, multi-selection Room ID renames remap
their selection/expansion state at the accepted generation.

Native certification Save has a separately authenticated
`NATIVE_PROJECT_SAVE_UNIT` IPC. It accepts one or multiple logical Save-unit
IDs and an exact working revision. The main-owned native worker resolves
physical owner scopes, combines linked owners into one atomic YAML
transaction, checks the revision again inside the native worker serialization,
and returns its acknowledgment. The renderer's Save coordinator updates
only the saved units' baselines and retains unrelated dirty recovery overlays.
Rejection does not invoke the old TS writer, and lost/uncertain acknowledgment
freezes native editing. The source editor now stages dirty Lua/RML/RCSS buffers
through `NATIVE_PROJECT_STAGE_TEXT` (coalescing rapid typing) and saves
through `NATIVE_PROJECT_SAVE_TEXT`. Native main validates the current session,
working revision, path, and exact disk baseline; the native worker first stages
the text and then durably publishes the exact bytes through the shared Project
transaction journal. The renderer accepts the new source content hash only
after native acknowledgment. Before Validation, Play or authored Tests,
the renderer drains debounced text staging into the same serialized native
Project mutation queue and captures the resulting working revision; stale
or rejected staging blocks consumption. Logical YAML Save adopts its scoped
saved-document/recovery baseline before releasing the native mutation queue
so a concurrent editor command cannot race it. Disk conflicts preserve unsaved source text,
including across native worker recovery. Neither operation falls back to
`writeProjectSource`.

The trusted IPC registrar continues to block legacy Project Save, source and
Asset writers, validation, preview, Tests and export operations in
native-edit certification mode where they could act on divergent Project
state. Separate native-only validation, Play preparation, and authored
Test/Tests-suite IPC paths now use the fully native-prepared working Project,
including accepted dirty overlays and exact working-revision guards, instead
of passing an independently mutable renderer Project to legacy handlers.
Prepared runtime inputs are reverified after compilation; the limited
native runtime cache owns temporary overlay roots through eviction and
Project close. Existing Test UIs and Play select the native endpoints while
native editing is enabled. Native Play and Test certification remains distinct
from the actual production cutover.

Native-edit certification now persists a current-only, main-owned replay checkpoint
under `.noveltea/editor/native-dirty-state.json`. Only worker-acknowledged
generic patches, staged text with exact physical source revisions, unresolved
conflict paths and pending-field text enter that checkpoint. It is atomically
published and synced before a successful mutation IPC response is returned.
The tracked Project source remains untouched until native scoped Save.
On Project reopen or editor restart, native admission first proves that clean
disk Project content agrees with the existing Workspace, then replays the
checkpoint under native exact-source preconditions. The renderer adopts the
recovered native content as dirty against current saved baselines, restores
unresolved conflict actions and preserves independently persisted local-only
drafts and pending input from `.noveltea/editor/state.json`. Stageable source
text is rehydrated into the existing source-buffer UI using its physical file
identity, including Layout companion sources. Changed sources, invalid or
partial journals, and mismatched Project identities fail closed without
discarding the journal or altering tracked source.

Worker failure revokes renderer mutation authority immediately. Main may
reopen and replay only the last durable checkpoint; the renderer must reopen
the Project to resynchronize revision, working projection and undo/redo intent.
Unacknowledged in-flight edits are not guessed or promoted. Native edit mode
can write local editor session metadata but still cannot write tracked Project
source through the TypeScript authoring engine. This remains a certification
route, not an enabled-by-default production migration.

Native generic record creation now stages
new YAML owners in the working Project, supports edits and cancellation before
Save, and journals their physical creation through the existing revision-checked
transaction. Use Disk discards an unsaved new owner. The native Project session
also stages persisted-record deletion as an explicit tombstone retaining its
exact physical source baseline. Generic remove/add batches can rename record
identities without altering disk before Save; a scoped multi-owner Save journals
the YAML deletion and new-source creation together under revision checks.
Whole-owner Use Disk restores a pending deletion. Reopen/replay retains its
deletion intent and source precondition, while native working runtime preparation
excludes deleted owners instead of accidentally falling back to their still-
present disk files. Layout deletion and identity changes now journal existing
RML/RCSS/Lua companions with the metadata. Deletion preserves those bytes in
`.noveltea/trash/layouts/<id>/` until a same-owner Undo restores them, even
across a native worker restart; the restore consumes the archive atomically and
rejects changed archived bytes. Duplicates and renames carry bounded, validated
source-owner hints through the generic patch boundary rather than guessing
among Layouts with identical source selectors; source companions are
byte-pinned through Save and external edits reject the entire journal.
Structural editor commands can now stage YAML-owner patches and commit their
scoped native Save atomically before publishing UI/history. The editor can undo
or redo those committed changes and restores a rejected candidate through an
explicit checked inverse patch. Deletion of commented records uses the normal
comment-review dialog before destructive Save; native source CAS is rechecked
on confirmation. Logical localization edits resolve to their owning
`i18n/*.yaml` fragments (not the manifest), so structural reference and
message-identity updates commit in the same journal as record changes. The
native route also updates script identity mappings and
recovery selection for structural remaps. Existing copied Asset imports and
deletions now journal source-byte moves into generated Project trash paths with
the associated YAML changes. A successful journal returns the exact trash
identity for native undo/redo restoration; an occupied restore destination or
changed physical source rejects the entire operation. In legacy mode, a
previously copied import with rejected metadata is moved to trash. Native
certification instead discards unpublished staged files; an Asset import may
not fall back to a metadata-only manual Save. Other eligible commands may
still use *native manual Save*, never a legacy writer.

Issue #511 extends the native editor Asset lifecycle with a **private,
main-process-owned staging area** under `.noveltea/native-asset-import/`.
Picker-selected image, animation and binary imports are byte-hashed and staged
without creating active `assets/` files. A renderer structural command can
only select staged Project-relative destinations: the native worker verifies
their physical hashes and journals creation of both the Asset records and the
exact binary bytes in one transaction. Rejected Saves leave no active unowned
Asset file; accepted imports support native trash/restore Undo and Redo.
The native patch boundary permits an otherwise valid new Asset record to be
dirty while its source file is not yet published; Save accepts that missing
source only when the same journal publishes that record's exact destination.
Other validation errors and missing sources without matching publication
remain blockers. Session revocation and rejected imports discard their staged
bytes, not live Asset files.
Reimport in certification mode is deliberately non-destructive: it publishes
a new versioned source path and changes the existing Asset record's source
descriptor, retaining the previous physical file for Undo. A later untracked
Asset audit may find the former file. Support-file attachments under `support/`
use the same stage/publish journal; standalone Asset trash and restore IPC
operations and untracked Asset organization also use native transactions in
certification mode.

Project Explorer source files now use the same native revision-checked journal
for Lua/Shader creation, deletion, relocation, and Material shader copying.
Relocations atomically save their affected Script/Material/Layout references
and rewritten shader includes alongside the physical files. Referenced
attachment moves between `support/` and `assets/` also save their Asset
references in that transaction. An exact-path match to a journal-created
shader or attachment source may defer only the corresponding missing-source
diagnostic until commit; unrelated validation failures still block the Save.
Empty-folder operations are native-session checked, and a populated folder
relocation prunes its old empty shells afterward. Staged, unsaved source buffers
and symlinked physical sources are not silently overwritten.

Native Save Copy As now copies verified **saved** Project files and byte-exact
authored YAML into the selected destination instead of using the legacy
TypeScript Project serializer. Unsaved local editor recovery metadata is carried
separately; externally changed native sources, linked source entries, and
occupied Project destinations are rejected. Existing unrelated destination
files are preserved.

Runtime package and playable platform exports in certification mode now obtain
the **saved and clean** Project from the admitted native session rather than
trusting the renderer's submitted Project. Dirty, conflicted or stale
native source revisions block export before publication. Native mode prepares
runtime packages and platform builds from the native-selected content and
rechecks admission before committing outputs. Normal editor operation remains
on its existing authoring paths until the coordinated production cutover.
Native mixed Save All now sends selected YAML owners and previously staged
Lua/RML/RCSS buffers through **one** physical transaction. Native staging
retains the original source revision even when later file observation changes
the current disk revision. The renderer must prove its submitted source text
matches the native worker's accepted staged bytes before publishing a saved
baseline; a mismatch fails closed. Native scoped reconciliation and Use Disk
have authenticated IPC boundaries, and the renderer's external-change workflow
publishes verified native working/saved source baselines and conflict state.
Use Disk prunes affected native UI history only after native and renderer
acknowledgment; the legacy history helper is not used in native mode.
Whole-locale translation and localized-Asset YAML fragments can be staged,
created or removed under native revision-checked multi-owner transactions.
Whole translation-collection replacement expands to one atomic per-locale
patch batch instead of writing the logical collection to project.yaml.

This flag **remains certification-only, not yet a usable complete native
editor**: the coordinated production cutover, including final parity for
remaining auxiliary Project file utilities, is not
authorized by this implementation. Structural source operations and the
clean native export path do not themselves authorize the production cutover.
Native external-delta publication and conflict resolution are owned by the
preceding #509 migration; #511 does not replace that reconciliation path.
No production cutover should enable the flag by default before all
coordinated ownership paths are certified.

## Native CLI compatibility and physical Asset transactions (#501)

The certification-only native CLI command boundary supports atomic Project
creation using the generated Workspace source-file codec (including the managed
`AGENTS.md` bootstrap and `.gitignore`), read-only scoped Asset audits, and
Asset imports with explicit dry-run plans. Destination publication is exclusive
and cannot overwrite an existing Project. Asset audits inspect only Project
identity, canonical Asset records and contained Asset-directory files: unrelated
invalid Room/Scene records do not block the inventory. Scoped admission still
requires the current workspace schema and version, a structurally valid Project
identity, and settled YAML transactions; pending native Asset-import staging
also blocks the audit. Certification compares both rejection codes and paths
with the installed CLI, as well as successful scoped inventory output.

Native Asset import validates canonical record metadata and source bytes before
publishing. Image and font inputs use the host's native decoders; audio/video
inputs must produce a decoded sample/frame through a bounded FFmpeg process.
No shell evaluates supplied paths. External source files are first copied to
the same-filesystem local staging area and linked into absent final Asset
paths, then the Asset YAML records are published through the revision-checked
native transaction service. An exact publication manifest in
`.noveltea/asset-import-staging/` supports conservative crash recovery;
`.noveltea/asset-import.lock/` identifies the owning process. A dead owner is
recovered only after the YAML journal is settled: complete records preserve
their binaries, absent records trigger deletion solely of exact staged hard
links, and any mixed/changed revisions fail closed. Both directories block
native clean-cache reuse while unsettled. These local-state files are not
Project source and are excluded from Project exports.

The installed-headless CLI continues to own the full Runtime Package compiler
until the coordinated #474 cutover. Its package-export certification now
cross-checks the parallel native `runtime-package-preparation` boundary against
the same exact source revision manifest and selected runtime profile, and
passes that native-selected profile into the installed compiler/export path.
The resulting `.ntpkg` must be byte-identical to the implicit-profile oracle
export. A second, stricter certification also takes the **native-prepared
effective Project**, reconstructs only omitted schema defaults, and feeds it
through the installed ScriptC compiler with the standard shader and media
adapters. It compares the SHA-256 of the compiled gameplay bytes against the
actual `game` entry in the exported `.ntpkg`, thereby exercising authored
localization, runtime lowering, scene/material/resource closure and shader
resolution rather than merely comparing selected export options. Native
preparation does not replace the existing compiler or change public commands.

Run `pnpm -C editor run noveltea:certify:native-project-commands` after
building `noveltea-tooling-bridge` and the standalone CLI to compare the
parallel native Project create, Asset import (dry-run and commit), and Asset
audit against disposable Projects created through the installed public CLI.
The differential compares parsed Project and Asset source semantics, exact
Asset bytes, resolved import outputs and untracked inventory, normalizing
only the import timestamp because the operations occur in separate processes.

## Native-only editor admission preparation (#521)

The cutover's new `openNativeEditorProject` path stages a physical Project
through `ActiveProjectSessionService.stageNativeProjectFile` and the native
worker's complete Project preparation. It deliberately does not construct
`ProjectWorkspaceService`, consume a TypeScript-saved Project as an oracle,
or run a second whole-Project parser. Session identity and Asset capabilities
are published only from the accepted native Project. Local
`.noveltea/editor/state.json` contributes editor-only recovery, view and
draft state; the Chapters, Tags and record metadata come from native-tracked
`editor.yaml`. Malformed local state is preserved and blocks Open rather
than being silently reset. A new Project uses a private staged native session
while the incumbent Project and its dirty worker remain live. Only after
successful admission and local recovery may the candidate be promoted
atomically; a failure or superseded activation discards only the candidate.
The eventual main-process wiring must use an independent candidate worker,
never reopen the active worker before promotion.
The `NativeEditorProjectHandoff` service now owns this distinct
per-attempt worker lifetime; it disposes rejected/superseded workers without
touching the incumbent and revokes the old worker only after native promotion.
Its real-addon regression rejects a malformed second Project while the
admitted Feature Lab incumbent continues answering native reads.
The complete native Project adapter also passes through authoritative native
record values without invoking the old TypeScript Zod Project validator or
materializing authored defaults a second time. Only the host transport shape,
omitted empty collection containers and local-only editor presentation defaults
are handled in TypeScript. The real-addon Feature Lab test separately checks
that these native values already satisfy the generated authoring contract.

Physical source hints for the eventual production watcher can be projected
from the existing native worker's exact-byte observations through
`NativeEditorObserverWatchService`. Only a still-current native session
with scoped authoritative source proof may report changed authoring files;
unsafe paths and missing Asset hashes fail closed. Renderer reconciliation
must still call the native worker on each changed owner. Reference usages
are a post-admission presentation query, split from the old TypeScript
workspace transaction service.

These are **tested preparatory boundaries, not a new production mode**.
Until the coordinated editor/CLI routing and legacy module retirement are
delivered atomically, the existing production owner remains unchanged.
The native-only Feature Lab addon tests exercise Open without a TypeScript
Workspace; further production invocation, watcher wiring and bundle closure
remain part of #521, not a fallback to the old engine.

The separate `runNativeOnlyNovelTeaCli` application boundary is also
available for cutover integration. It uses a single shared native dispatch,
with Project command grammar split into pure parsers so native Project
create/import/export no longer import the retired TypeScript constructors
merely to validate flags. Unclaimed operations fail closed; the installed
ScriptC/daemon production entrypoint has **not** switched to this function.
Ignored editor-only JSON serialization likewise no longer requires the
legacy YAML/Project codec. Its old machine.json bytes are regression-tested.

## Candidate-only editor lifecycle wiring (#532)

`--certify-native-authoring-lifecycle` selects the separate full native
**candidate** path in `editor/src/main.ts`. Normal editor launches still use
the legacy Project routes, and `--certify-native-authoring-open` / `-edit`
retain their existing differential certification behavior. This flag is not
a supported production mode or an intermediate release. It exists to
exercise the native editor independently before the atomic #521 editor/CLI
cutover.

The guarded main-process `OPEN_PROJECT` IPC stages an independently owned
native worker through `NativeEditorProjectHandoff`. The trusted main process
selects the canonical Project root and addon path; the renderer cannot supply
a worker handle. Admission, tracked `editor.yaml`, local-only recovery,
acknowledged native dirty checkpoint and source revisions must succeed before
the staged identity is committed. Invalid or superseded candidates dispose
their own workers without revoking the incumbent. Reopening the same physical
root creates a fresh candidate, restoring native dirty edits without first
destroying the previous worker. Close revokes all candidate and active native
workers, and all native command, text, Save, Test and export IPC calls continue
to validate the active session ID and working revision.

Production `CREATE_PROJECT` uses the private `native-project-commands` editor
bridge operation with action `project-create`, which dispatches one native
transaction with an absolute destination and returns its native identity.
The UI then opens the created Project normally via candidate `OPEN_PROJECT`.
No TypeScript Workspace creator, validator or YAML writer is invoked by this
candidate path. The internal bridge extension does not change the public
CLI/daemon production routing.
`COMPLETE_PROJECT_IMPORT` similarly uses the same native bridge with action
`project-import`; it reuses
the desktop handoff's bounded HTTPS/SHA-256 download but delegates archive
validation, source containment, exact file revisions and destination publication
to the native transaction. A confirmed display-name override is applied to
the **staged** `project.yaml` only after original archive validation; the
stable Project ID is preserved and the renamed candidate is natively validated
before atomic publication. Import failure or destination conflict cannot
silently fall back to the legacy Workspace importer.

`START_PROJECT_WORKSPACE_WATCHER` and `STOP_PROJECT_WORKSPACE_WATCHER` remain
the existing authenticated renderer capability names but dispatch to
`NativeEditorObserverWatchService` in this candidate mode, never to the
legacy chokidar/Workspace watcher. Its events retain the renderer's stable
source-event envelope while representing only native-authoritative exact-byte
observations; unsafe or incomplete observation proof yields diagnostics and
cannot be treated as an admitted semantic Project. Native Layout RML/RCSS/Lua
source entries are inventoried from native-admitted Layout IDs and physically
verified files, rather than the old Workspace snapshot.

Regression entrypoints are
`src/renderer/test/native-editor-project-handoff.test.ts` (incumbent,
same-root reopen, rejected admission, dirty Save and physical observer)
and `native-editor-project-create.test.ts` (private native Create, bundle
import with a confirmed name, newly created/imported native Project Open).
The additional
`native-editor-candidate-ipc.test.ts` exercises the actual guarded IPC
registrar, sender validation and revision-checked Open/Patch/Validate/Save/
reopen/Close with real Feature Lab workers, rather than a mock Project store.
`native-editor-runtime-equivalence.test.ts` admits a native-created minimal
Room/Test fixture, runs a successful authored Test in the actual player, and
compares native compiled-game content, manifest previews, package options and
**exact exported `.ntpkg` bytes** with a separate saved-Project baseline.
These focused tests exercise real workers and CLI with:

```sh
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  pnpm -C editor exec vp test run \
  src/renderer/test/native-editor-project-handoff.test.ts \
  src/renderer/test/native-editor-project-create.test.ts \
  src/renderer/test/native-editor-candidate-ipc.test.ts \
  src/renderer/test/native-editor-runtime-equivalence.test.ts
```

The optional Linux assembled-app smoke script runs Electron under Xvfb with
the explicit candidate flag and connects through Chromium's debugging
protocol. It waits for the real renderer/preload to load, authenticates native
Create/Open/Validate/source-inventory/Close through preload IPC, then clicks
the React New Project button, enters form values, submits and verifies that
the resulting Project is visible in the workspace/Explorer. This script does
not use an in-process mock window or worker:

```sh
node editor/scripts/certify-native-editor-lifecycle.mjs
```

### Editor consumer and final-gate inventory

The candidate uses the existing authenticated preload API and main-process
channel names. Its source authority routes are:

| Editor consumer | Native candidate ownership / IPC route |
| --- | --- |
| Create | `CREATE_PROJECT` -> private native `project-create` transaction, then candidate `OPEN_PROJECT` |
| Desktop bundle import | `COMPLETE_PROJECT_IMPORT` -> private native `project-import` archive/rename transaction; UI opens the resulting physical Project through candidate Open |
| Open, same-root reopen, close | `OPEN_PROJECT` and `CLOSE_ACTIVE_PROJECT` -> staged `NativeEditorProjectHandoff` and independent worker lifetimes |
| Inspector, record edits, undo/redo | Initial complete native working Project, revision-checked `NATIVE_PROJECT_PATCH`, renderer-local inverse patch intents; no second TypeScript Project normalization |
| Explorer and source buffers | `LIST_PROJECT_SOURCE_FILES`, `READ_PROJECT_TEXT_SOURCES`, `PROJECT_SOURCE_USAGES`, `MUTATE_PROJECT_SOURCES`, `NATIVE_PROJECT_STAGE_TEXT`, `NATIVE_PROJECT_SAVE_TEXT`; native source journal and main-owned physical file capabilities |
| Comment policy, structural Save/Save All | `NATIVE_PROJECT_SAVE_UNIT` with scoped owners and Keep/Remove/Cancel; `NATIVE_PROJECT_RECONCILE`, `NATIVE_PROJECT_USE_DISK_UNIT` for conflicts and external changes |
| Save As / Project Copy | `SAVE_PROJECT_COPY_AS` consumes the admitted saved native source inventory and carries local-only editor recovery; it never creates a TypeScript Workspace authority |
| Asset operations | `AUDIT_PROJECT_ASSETS`, `IMPORT_UNTRACKED_PROJECT_ASSETS`, `ORGANIZE_UNTRACKED_PROJECT_ASSET`, attachment import/inspection, `TRASH_PROJECT_ASSET_FILES` and `RESTORE_PROJECT_ASSET_FILES`; main owns path and Asset capabilities, native authority owns Project mutations |
| Preview and authored Tests | `NATIVE_PROJECT_PREPARE_RUNTIME`, `NATIVE_PROJECT_VALIDATE`, `NATIVE_PROJECT_RUN_TEST`, `NATIVE_PROJECT_RUN_SUITE`; `LIST_PLAYBACK_TESTS` in candidate enumerates native-admitted Test records rather than validating renderer Project values |
| Package/platform export | `EXPORT_PACKAGE`, `STAGE_PLATFORM_EXPORT`, `EXPORT_PROJECT_TO_PLATFORM` demand `prepareCleanExport` and native source proof; binary source observation uses native physical fingerprints and tracks actual admitted Asset hashes |
| External edits and invalidation | Existing watcher START/STOP and event IPC -> native worker's exact-byte observer; no legacy filesystem watcher in candidate |

### Verification and environment notes (2026-10-23)

- `pnpm -C editor run check`: passed (schema policy, formatting, lint with
  zero warnings, typecheck). `pnpm -C editor run build:renderer` and
  `pnpm -C editor run build:electron`: passed. The private CLI was rebuilt
  successfully with Node 24.18.0 and `VCPKG_ROOT=/home/dev/dev/vcpkg`.
- `NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" pnpm -C editor exec vp test run --maxWorkers=4`:
  final complete rerun **350 passed files, 3,103 passing tests, 124 skipped**.
  Focused real-addon Create/import, handoff, runtime equivalence and
  authenticated IPC integration tests passed. Two initially exposed test
  contract regressions (the static IPC registration inventory and the
  physical-source error string) were corrected and the full rerun is green.
- `ctest --test-dir build/native-authoring-host --output-on-failure -j 2 -R '^native_authoring_(working_preparation|asset_animation|tests|source_analysis|project_session|project_validation|yaml_transaction|layout)$'`:
  8/8 passed.
- Feature Lab native Open, dirty patch/checkpoint, failed and same-root
  reopen, physical Save, verified clean export source, Layout inventory,
  external Room observation, authenticated IPC validation and preview
  artifact preparation were exercised without a TypeScript Workspace.
- `node editor/scripts/certify-native-editor-lifecycle.mjs`: passed on Linux
  with Xvfb, actual Electron renderer/preload native calls and React New
  Project dialog creation/Open/Explorer presentation. Assembled Electron and
  renderer builds pass. `clang-format --dry-run --Werror` also passes for the
  native bundle importer. A redundant broader, CPU-intensive CLI native
  certificate was stopped after native Create/import integration and dedicated
  CTests already provided positive evidence; no incomplete certificate was
  counted as a pass.

An actual authored Feature Lab Test reached the native player but returned
`compiledProjectAdmissionRejected` for its experimental video motion and
missing gameplay materials. This fixture's negative case is deliberately
retained and is **not** counted as a passing Test run. The independent minimal
native-created Room/Test fixture instead **passes** its authored runtime Test,
and the package-equivalence check compares emitted archive bytes rather than
merely comparing an abstract runtime profile. The semantic runner now passes
the main-owned Project root so the player can resolve Project Lua sources.
An assembled Electron candidate and React Project Create/Open sequence also
passed under Xvfb; platform-native manual GUI checks outside Linux remain
out of scope for #532's preparatory certification and belong to #522.

The actual final **#521-only deletion gate** is the removal of the legacy
`openProject`/`createProject`/`saveActiveProjectContent` and
`requireActiveWorkspace` authoring branches in `editor/src/main.ts`, the
legacy IPC channel handlers (`SAVE_PROJECT_CONTENT`, `WRITE_PROJECT_SOURCE`,
`VALIDATE_PROJECT`, `PREPARE_EDITOR_RUNTIME`, `RUN_PLAYBACK_TEST`/
`RUN_PLAYBACK_SUITE`/`RUN_PLAYBACK_SPEC`/`RUN_UI_PLAYBACK_SPEC`, and
`PURGE_PROJECT_TRASH`), the obsolete `--certify-native-authoring-open`,
`--certify-native-authoring-edit` and `--certify-native-authoring-lifecycle`
mode forks, and the retired TypeScript Workspace/watcher/schema/cache graph
specified in `NATIVE_AUTHORING_CUTOVER_READINESS.md`. The editor preload and
renderer must then expose only native authority calls, while retaining UI
drafts and editor-local state. This inventory is a deletion contract, **not**
permission to delete production routes in #532.

The full production module and bundle-closure gate and the editor/CLI
production authority transition remain **#521**, followed by the independent
production lifecycle qualification in **#522**. The candidate deliberately
retains old routes in the assembled production bundle; it must not be used
to claim production independence or satisfy that final closure gate.
