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
until an `i18n/` owner changes or the native source watcher observes an
`i18n/` change. Production localization sync/reconcile and the eventual
single-authority cutover remain governed by the existing Project Workspace
contract and the parent native migration specification.

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
