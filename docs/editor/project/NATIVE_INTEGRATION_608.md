# #608 — Integrated native Save, recovery, conflict and lifecycle certification

Status: **in progress** (cross-owner Save and physical native YAML/recovery gates implemented). Parent #602
remains open. No physical interactive desktop or cross-platform acceptance is
claimed here; the packaged/host certification belongs to #609.

## Test provenance and trust boundary

- Baseline: `19038af3` (#607 coverage closure), Linux x86_64, Node 24.16.0.
- Native authoring addon available in `build/native-authoring-host/noveltea-authoring-node.node`,
  SHA-256 `ec7b029a2e478a486aaec9f3bf3c26b24ca2ddecbaf772c7f29048697c9e212d`.
- First new deterministic integration case:
  `project-save-coordinator.test.ts` — *saves only the active Room after a
  500/1,000-ms delayed field acknowledgment, leaving an independent Room dirty*.
  Both cases passed; the whole coordinator suite passed (38 tests).
- Real-addon physical regression suite:
  `editor/src/renderer/test/native-save-integration-608.test.ts` (Linux x86_64,
  Node 24.16.0, native addon SHA-256 above). All five cases use disposable
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
  content identity but different physical paths and local journals.
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
- Two more native/disk tests confirm that an intervening **second external
  mutation** invalidates the earlier reviewed Keep Mine precondition and that
  a dirty Project cannot pass clean export admission; after the exact owner is
  saved, clean export admission includes the new verified native source bytes.
- The earlier deterministic coordinator fixture holds **native IPC acknowledgment** but uses a controlled
  in-memory native response and projects `savedDocument`/`document`. Its proof
  is exact Save-unit and ordering behavior, **not** that physical native YAML
  bytes have been written. Real addon/disk readback remains a required separate
  gate before #608 can close.

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
  this proves production contract qualification checks, not a packaged GUI
  run or full native CLI integration qualification.
- Following the native Instance Save fix and rebuilt addon (Linux x86_64,
  SHA-256 `23c23f53dd2faf0dbfb21c921b03d1a41e86746d2d4ec7362f715230aa053d18`):
  all **10/10** physical Save/disk/recovery integration tests passed;
  `native_authoring_project_session` and `native_authoring_interactable_inventory`
  native CTest cases passed (**2/2**).
- Full addon-backed editor suite **after the native C++ fix and all new tests**:
  **311 test files, 2,366 tests passed; 9 files / 94 tests skipped**. An earlier
  full run had one non-reproduced `native-field-drafts.test.tsx` headless Select
  option query failure (`Overscan`); its isolated retry passed, followed by
  the full clean suite. This does not qualify the still-open integrated
  lifecycle scenarios or physical packaged editor UI.

## Eight required integrated workflows

Each row records the failure mode, existing protection, new certification work
and the outstanding exact-native/disk/lifecycle evidence. A referenced unit
test is not automatically credit for full integrated native certification.

| # | Workflow and failure to prevent | Existing deterministic coverage | #608 status and outstanding proof |
| --- | --- | --- | --- |
| 1 | Active owner Save with another pending owner: stale Save or collateral dirty clearance | `project-save-coordinator.test.ts` scoped Save and dependent-owner tests; `native-field-drafts.test.tsx` field coalescer | **New addon/disk pass:** 500/1,000-ms held-IPC selective flush; actual Room/Scene/Dialogue native owner-scoped YAML Save and cold recovery of independent owner. **Still needed:** combined physical UI/renderer IPC seam under hold |
| 2 | Save All partial failure/retry: failed native patch or Save falsely marks owners clean or loses recoverable text | `project-save-coordinator.test.ts` pending-field exclusion, native refusal, all-owner atomic Save and invalid raw inputs | **New addon/disk pass:** mixed-owner Save fails atomically on real external conflict; reconcile + Keep Mine persists both; Use Disk preserves unrelated unsaved owner. **Still needed:** rejected native flush and separate physical Save failure with local draft/retry |
| 3 | Save As/copy/restart: old Project overwritten, pending drafts silently committed or copied incompletely | `project-save-coordinator.test.ts` baseline-plus-recovery copy, pending number and unmounted draft; `native-dirty-recovery.test.ts` checkpoint identity | **New addon/disk pass:** `native-project-copy-service.test.ts` reopens the physical copy with two independently dirty native owners and an unacknowledged field draft; saving in the copy does not affect original physical YAML; original reopens with its native recovery intact. Existing destination-scoped journal and stale-copy refusal also pass. **Still needed:** pending invalid numeric input coupled with source text and physical copy, lifecycle cancellation/in-flight race |
| 4 | Shared exact Instance: stale old owner dispatch, close while queued, dropped new owner intent | `exact-instance-drafts.test.tsx` ownership transfer, queued replanning, overlap and failed recovery; `dirty-close-dialog.test.tsx` duplicate-close behavior | **Native defect fixed:** exact Room/Definition Save now includes matching dirty Instance subpaths in physical project.yaml; Room and Definition physical Save, cross-Room isolation and cold recovery pass. **Deterministic pass:** close Definition during dispatched patch; Room retains latest intent. **Still needed:** combine real native IPC and UI tab close in one physical end-to-end case; cross-owner source attribution when current Room relationship is not the Instance location |
| 5 | Undo/Redo plus structural operations: stale text resurrected or wrong unit saved after create/delete/move | `native-field-drafts.test.tsx` field generations and Undo/Redo; `project-save-coordinator.test.ts` atomic closures; `project-explorer.test.tsx` structural controls | **Partial:** integrate pending field + structural move/delete + Undo/Redo + Save with a real native source round trip and persisted readback |
| 6 | External edit and cold restart: disjoint changes fail to rebase, overlapping field silently overwrites disk | `project-external-reconciliation.test.ts`, `project-save-coordinator.test.ts` Use Disk/Keep Mine and CAS, `exact-instance-drafts.test.tsx` recovery | **New addon/disk pass:** external disjoint YAML reconciliation; physical same-pointer overlap, failed atomic Save, explicit Keep Mine and Use Disk, independent owner isolation and cold reopen; **second intervening external edit** rejects stale reviewed Keep Mine and requires new review. **Still needed:** cold recovery with an *unresolved* conflicting edit |
| 7 | Close/reload/preview/test/validation/export: unsaved data dropped, preview/export consumes stale source or native error ignored | `dirty-close-dialog.test.tsx`, `native-editor-session-controller.test.ts`, preview/asset export suites and recovery tests | **New addon/disk pass:** clean export admission rejects dirty working source, then admits only a verified saved source; physical Session close/reopen preserves unsaved content. **Still needed:** integrated Preview/Test entry, validation under pending drafts, worker crash and renderer reload with staged text |
| 8 | Stale session/revision: old Project acknowledgment corrupts a newly opened Project | `native-editor-session-controller.test.ts` stale response/admission guards; `native-field-drafts.test.tsx` Project-instance isolation | **Partial:** carry real deferred old-session acknowledgment across Project reopen/Save and inspect both working and persisted sources |

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

## Remaining close-out criteria

The eight workflows still need complete deterministic end-to-end
addon/disk/readback evidence across the remaining combinations (notably
rejected patch/save, concurrent close/owner transfer, Undo/Redo with structural
edits, preview/validation/export and stale async acknowledgment), plus a
reviewed full-suite and native smoke. The new physical tests above certify only
the stated workflows; do not infer whole-workflow completion from unit tests.
Keep #602 open until #609 is accepted.
