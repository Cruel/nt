# #608 — Integrated native Save, recovery, conflict and lifecycle certification

Status: **eight automated integration workflow families certified** on Linux
x86_64 with the native addon. Parent #602 remains open. No physical interactive
desktop or cross-platform acceptance is claimed here; packaged/host
certification belongs to #609.

## Test provenance and trust boundary

- Baseline: `19038af3` (#607 coverage closure), Linux x86_64, Node 24.16.0.
- Native authoring addon available in `build/native-authoring-host/noveltea-authoring-node.node`,
  final tested SHA-256 `1860d1f8d80121c4f126f4ecab285ca67551c164c3dd4d439af162190f3e5350`.
- First new deterministic integration case:
  `project-save-coordinator.test.ts` — *saves only the active Room after a
  500/1,000-ms delayed field acknowledgment, leaving an independent Room dirty*.
  Both cases passed; the whole coordinator suite passed (38 tests).
- Real-addon physical regression suite:
  `editor/src/renderer/test/native-save-integration-608.test.ts` (Linux x86_64,
  Node 24.16.0, native addon SHA-256 above). The initial five cases and
  expanded suite use disposable
  copies of Feature Lab, real worker/ProjectSession, exact physical YAML bytes,
  and where applicable a fresh main controller and native worker after closing
  the prior session:
  - Scoped Save of Room A does not save Room B; Room B's acknowledged change
    remains in native recovery, reopens dirty, and can be saved separately.
  - Scoped Scene Save does not save a Dialogue changed in the same native
    session; the Dialogue recovers across worker restart and then saves.
  - A physical same-pointer external YAML edit rejects a mixed-owner Save
    atomically (the independent Room stays on its original disk bytes);
    explicit native reconcile and Keep Mine then save both, including after
    cold reopening. No implicit overwrite or false Save acknowledgment.
  - A physical conflicting Room edit followed by reconcile and Use Disk restores
    the external value without losing an unrelated unsaved Room.
  - A disjoint external `label` change reconciles with an unsaved local
    `data.displayName` field; both fields persist to the exact owner YAML.
- A failed Save is not itself an authorization to resolve an external conflict:
  the native boundary rejects Use Disk and Keep Mine against unreviewed disk
  revisions. The tests explicitly call owner-scoped `reconcile` first and
  verify revisioned resolution. This is a required CAS boundary, not a defect
  to bypass.
- Additional physical Save As regression in
  `native-project-copy-service.test.ts`: *copies two native dirty owners and an
  unacknowledged field while preserving the original Project*. It copies the
  original saved YAML bytes, reopens the copy with both native dirty owner
  projections and the unacknowledged field's local recovery draft, then Saves
  only the Scene in the copied Project. The original physical Room and Scene
  bytes remain unchanged, and reopening the original restores its independent
  native dirty Room and Scene. This exercises two Projects with the same
  content identity but different physical paths and local journals. The final
  case also includes an incomplete numeric field and native staged Lua;
  both are recoverable in the copy without changing the original files.
- Additional exact Instance ownership regression:
  `exact-instance-drafts.test.tsx` — *preserves the latest Room owner when the
  Definition view closes during a dispatched native Instance edit*. The first
  Definition patch is held, the Room takes ownership of the exact same pointer,
  the Definition view unmounts, then the older patch completes. The final
  shared projection is the Room value, the two acknowledged history entries
  retain their original correct Save units, and no dangling field draft remains.
  This is deterministic renderer/native-ack simulation, not physical native
  Instance YAML readback.
- Discovered and repaired a **native Save correctness defect**: an exact
  Interactable Instance could be edited and acknowledged in the native working
  Project, but `record:rooms:<id>` or `record:interactables:<id>` Save reported
  success without writing the dirty Instance to `project.yaml`. The native
  resolver previously selected only its record YAML plus editor metadata.
  `tools/project_authoring/room_session.cpp` now resolves dirty exact Instance
  subtrees to their physical Manifest source for matching Room location or
  Definition, preserving independent per-Instance paths rather than selecting
  the whole Project. The resolver indexes **only dirty Instance IDs**; it does
  not iterate every Instance against every patch when saving ordinary records.
  Three new real-addon regressions verify physical project.yaml and native
  restart for Room Save, two independent Rooms' Instance isolation/recovery,
  and Definition Save alongside a separately dirty Room.
- Final integration discovered an additional omission: `project:settings`
  originally excluded dirty exact Instances owned by the Project's starting
  Inventory. The native resolver now selects those exact Manifest subtrees
  using both original and current ownership, without including a separately
  dirty Room. A real-addon Project Inventory Instance addition/save regression
  proves its `project.yaml` readback.
- A further real Feature Lab regression proved a Room's authored Interactable
  placement can differ from the Instance's gameplay `location` (for example
  `scene-director` places `gate-lever-1`, while its world location names
  `rooms-interactions-workshop`). The native Save resolver previously
  acknowledged the Room's Instance edit without writing `project.yaml`.
  It now considers the Room's current and saved placement records in addition
  to world location. A failing-first native disk/cold-reopen test certifies the
  correction; uninspected Rooms are read through the same native record
  authority, and only when exact Instances are dirty.
- Two more native/disk tests confirm that an intervening **second external
  mutation** invalidates the earlier reviewed Keep Mine precondition and that
  a dirty Project cannot pass clean export admission; after the exact owner is
  saved, clean export admission includes the new verified native source bytes.
- The deterministic coordinator fixture holds **native IPC acknowledgment** but
  uses a controlled in-memory response. Its proof is exact Save-unit and
  ordering behavior, **not** physical YAML writes. The independent physical
  Save/readback cases supply that separate native authority proof. Do not
  confuse the two layers or claim human desktop certification.

## Verification checkpoints

- `pnpm -C editor run check`: passed after both native regression batches
  (format, TypeScript, lint with zero warnings, native contract, source-coverage
  and schema policy checks).
- Native-addon full renderer suite after the first five disk cases: **311 files,
  2,359 tests passed; 9 files / 94 tests skipped**. Existing headless React
  `act` and canvas warnings are not physical desktop acceptance.
- After the physical Save As and dispatched-owner-close additions: focused
  `native-project-copy-service.test.ts` and `exact-instance-drafts.test.tsx`
  **15/15 tests passed** using the addon (including 7 physical-copy tests and
  8 exact Instance field tests).
- `pnpm -C editor run noveltea:certify:native-production-unit`: **23/23 passed**;
  rerun after final changes. This proves production contract qualification
  checks, not a packaged GUI run or full native CLI integration qualification.
- Following the native Instance Save fix and rebuilt addon (Linux x86_64,
  SHA-256 `23c23f53dd2faf0dbfb21c921b03d1a41e86746d2d4ec7362f715230aa053d18`):
  all **10/10** physical Save/disk/recovery integration tests passed;
  `native_authoring_project_session` and `native_authoring_interactable_inventory`
  native CTest cases passed (**2/2**).
- Full addon-backed editor suite at final source and native addon:
  `NOVELTEA_AUTHORING_NODE_ADDON=... pnpm -C editor exec vp test run
  --testTimeout=30000 --reporter=dot --no-file-parallelism`:
  **311 test files and 2,376 tests passed; 9 files / 94 tests skipped**.
  Parallel scheduling was also exercised, but did not qualify as a full pass:
  two default-concurrency runs reached 2,374 passes with one native
  source-transaction preparation failure each (the failing test passed
  separately), and a four-worker run reached 2,374 passes with an unrelated
  `workspace-new-project.test.tsx` metadata timing failure. These are
  recorded scheduling/harness limitations, **not** silently counted as
  passes. The serial full suite is a complete test-file run, not a subset.
  None of these headless runs qualifies physical packaged editor UI.
- Final native addon (SHA-256
  `1860d1f8d80121c4f126f4ecab285ca67551c164c3dd4d439af162190f3e5350`)
  **20/20 physical Save/worker/recovery
  integration cases passed**; modified Save As native copy case including
  incomplete numeric recovery and staged Lua passed; CTest
  `native_authoring_project_session`, `native_authoring_interactable_inventory`,
  `native_authoring_yaml_transaction` **3/3 passed**. `pnpm -C editor run
  check` passed before the final placement-case addition (0 lint warnings);
  full completion check is repeated at the final source state.
- Final focused run after rebuilding native addon: `native-save-integration-608`,
  `native-project-copy-service` and `exact-instance-drafts` **3 files, 35
  tests passed**. The tests use the real native addon for physical outcomes
  and deterministic renderer shims for cross-view ordering.
- The original full-suite baseline before the last native fix passed
  **311 files, 2,366 tests**. The additional ten passing integrated tests
  account for the final **2,376-test** total.

## Eight required integrated workflows — automated closure matrix

Each family is certified at two complementary seams: deterministic renderer/UI
ordering and error handling, plus a real native worker using an isolated Feature
Lab copy, scoped YAML/text readback, and cold reopening where applicable.
No synthetic renderer test is labeled a packaged desktop test. These are the
smallest trustworthy seams for the integration acceptance of #608; human input,
packaged host and cross-platform work remains in #609.

| Family | Renderer, ordering and failure regression | Native addon, disk and restart evidence |
| --- | --- | --- |
| **1. Active owner Save** | `project-save-coordinator.test.ts`: active Room Save with 500/1,000 ms held native acknowledgment, selective field flush, exact owner and no premature success; `native-field-drafts.test.tsx` covers immediately visible unrelated drafts | `native-save-integration-608.test.ts`: scoped Room A Save leaves Room B dirty through cold restart; scoped Scene Save leaves Dialogue dirty, later saved. Physical YAML of unrelated owners stays byte-identical |
| **2. Save All failure / retry** | `project-save-coordinator.test.ts`: invalid raw numeric, failed/blocked pending native field, dependent-group isolation, partially saved result and diagnostics; `native-field-drafts.test.tsx`: rejected worker patch retains recoverable input | `native-save-integration-608.test.ts`: missing native owner patch rejected without revision advancement; mixed-owner YAML conflict atomically rejects Save All; independent Room + Scene persist on retry; conflict retains local state until explicit reconcile and Keep Mine; exact files and cold reopen checked |
| **3. Save As and relocation** | `project-save-coordinator.test.ts`: saved baseline plus local recovery, unmounted field, invalid numeric value, unattributable/unrecordable draft rejected | `native-project-copy-service.test.ts`: two dirty native owners, unacknowledged field, incomplete numeric draft and staged Lua in one physical copy. Both roots reopen independently; original and copy keep byte-identical saved YAML/Lua until their own explicit Saves; destination-bound recovery journal and stale-copy refusal tested |
| **4. Two-view exact Instance ownership** | `exact-instance-drafts.test.tsx`: same-pointer Room/Definition edits, replanning of queued owner, Definition close while earlier native patch is dispatched; latest Room intent wins and no stale field remains; `dirty-close-dialog.test.tsx` protects duplicate views | `native-save-integration-608.test.ts`: actual Room/Definition physical Instance Save to `project.yaml`, isolated two-Room Instance ownership and cold recovery; Definition-origin value followed by Room-origin value persists only latest; starting Project Inventory Instance Save remains separate from another dirty Room; **containing Room whose authored placement disagrees with gameplay world location** persists exact Instance bytes correctly |
| **5. Undo/Redo and structural changes** | `native-field-drafts.test.tsx`: flush barrier before structural commands/Undo, grouped typing Undo, rejected incomplete numeric input; `project-explorer.test.tsx` and `project-save-coordinator.test.ts` protect atomic group ownership | `native-save-integration-608.test.ts`: atomic Room create → inverse delete → redo create → atomic remove/add move, each physical native Save, source existence readback and cold reopen. Independent unsaved Room edit never commits or disappears |
| **6. External disk + restart** | `project-external-reconciliation.test.ts` and `project-save-coordinator.test.ts`: disjoint rebase, overlapping conflict, Use Disk and Keep Mine expected-revision CAS | `native-save-integration-608.test.ts`: physical same-field conflict refuses Save without write, reviewed Keep Mine and Use Disk, disjoint merge, second external edit invalidates prior review, *unresolved* conflict survives cold restart with both local and disk values and remains blocked until explicit resolution |
| **7. Lifecycle / Preview / Test / validation / export** | `dirty-close-dialog.test.tsx` protects close/Don't Save and duplicate views; native error/recovery tests protect interrupted worker and source identity; existing preview/Test suites protect renderer entrance states | `native-save-integration-608.test.ts`: real worker termination preserves acknowledged unsaved YAML through reopen; staged Lua and dirty invalid Room enter native validation, Preview and Test readiness without physical writes; repaired Room and Lua survive reopen and commit together; clean Export is blocked while dirty then admits verified saved bytes |
| **8. Session and revision scoping** | `native-editor-session-controller.test.ts`: superseded admission, stale revisions and late response revocation; `native-field-drafts.test.tsx`: Project-instance isolation | `native-save-integration-608.test.ts`: hold acknowledgment *after* real native patch acceptance, deactivate old Project, open and Save a new independent Project, release old acknowledgment. Old result is rejected as superseded; neither Project's working view nor disk is contaminated |

Feature Lab qualification: **automated integration covered** — the disposable
certification runs use the in-tree Feature Lab and never mutate its sources.
Editor-only lifecycle and Save authority require no authored gameplay example.
Physical desktop, packaged and cross-platform Feature Lab exercises are
separately owned by #609.

## Initial integration finding

Calling `saveActiveSaveUnit()` directly with an unresolved native field is
**deliberately rejected** (`editor.native-save.pending-field-rejected`). The
workspace Save action first invokes `flushNativeFields(selectedOwner)`; after
native acknowledgment, the coordinator may persist that owner alone. The new
two-owner test reproduces both the hold and expected scoped Save: the active
Room is saved, while an independently authored Room remains dirty and visible.
The suite checks no premature native Save during the IPC hold and no false
dirty clearance of the unrelated Room. Do not weaken the coordinator's guard
to make its direct low-level invocation accept unsent input.

## Automated acceptance and qualifications

The eight required #608 integration families have complementary deterministic
UI/ordering tests and real-addon physical readback/restart evidence as mapped
above. This is **not** a claim that headless tests replace human interaction,
packaged editor, platform-specific validation or latency certification:
those remain the distinct #609 gate. The native YAML transaction preflight
intentionally refuses unsupported multi-line mapping-field removals rather than
silently saving; a failed Save is actionable, not an acknowledgment of commit.
Feature Lab fixture sources were never modified. Keep parent #602 open until
#609 is accepted.
