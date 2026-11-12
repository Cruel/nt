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
- This fixture holds **native IPC acknowledgment** but uses a controlled
  in-memory native response and projects `savedDocument`/`document`. Its proof
  is exact Save-unit and ordering behavior, **not** that physical native YAML
  bytes have been written. Real addon/disk readback remains a required separate
  gate before #608 can close.

## Eight required integrated workflows

Each row records the failure mode, existing protection, new certification work
and the outstanding exact-native/disk/lifecycle evidence. A referenced unit
test is not automatically credit for full integrated native certification.

| # | Workflow and failure to prevent | Existing deterministic coverage | #608 status and outstanding proof |
| --- | --- | --- | --- |
| 1 | Active owner Save with another pending owner: stale Save or collateral dirty clearance | `project-save-coordinator.test.ts` scoped Save and dependent-owner tests; `native-field-drafts.test.tsx` field coalescer | **New addon/disk pass:** 500/1,000-ms held-IPC selective flush; actual Room/Scene/Dialogue native owner-scoped YAML Save and cold recovery of independent owner. **Still needed:** combined physical UI/renderer IPC seam under hold |
| 2 | Save All partial failure/retry: failed native patch or Save falsely marks owners clean or loses recoverable text | `project-save-coordinator.test.ts` pending-field exclusion, native refusal, all-owner atomic Save and invalid raw inputs | **New addon/disk pass:** mixed-owner Save fails atomically on real external conflict; reconcile + Keep Mine persists both; Use Disk preserves unrelated unsaved owner. **Still needed:** rejected native flush and separate physical Save failure with local draft/retry |
| 3 | Save As/copy/restart: old Project overwritten, pending drafts silently committed or copied incompletely | `project-save-coordinator.test.ts` baseline-plus-recovery copy, pending number and unmounted draft; `native-dirty-recovery.test.ts` checkpoint identity | **Existing real addon/disk pass:** `native-project-copy-service.test.ts` reopens physical destination with acknowledged native changes still unsaved and checks byte-exact original, destination-scoped journal, stale-source refusal. **Still needed:** multi-owner+pending-field copy and original-vs-copy roundtrip after both reopen |
| 4 | Shared exact Instance: stale old owner dispatch, close while queued, dropped new owner intent | `exact-instance-drafts.test.tsx` ownership transfer, queued replanning, overlap and failed recovery; `dirty-close-dialog.test.tsx` duplicate-close behavior | **Partial:** combine Room and Definition views with cross-owner close *during* queued/dispatched patch and cold recovery; verify exact native owner and YAML |
| 5 | Undo/Redo plus structural operations: stale text resurrected or wrong unit saved after create/delete/move | `native-field-drafts.test.tsx` field generations and Undo/Redo; `project-save-coordinator.test.ts` atomic closures; `project-explorer.test.tsx` structural controls | **Partial:** integrate pending field + structural move/delete + Undo/Redo + Save with a real native source round trip and persisted readback |
| 6 | External edit and cold restart: disjoint changes fail to rebase, overlapping field silently overwrites disk | `project-external-reconciliation.test.ts`, `project-save-coordinator.test.ts` Use Disk/Keep Mine and CAS, `exact-instance-drafts.test.tsx` recovery | **New addon/disk pass:** external disjoint YAML reconciliation; physical same-pointer overlap, failed atomic Save, explicit Keep Mine and Use Disk, independent owner isolation and cold reopen. **Still needed:** second intervening external edit and cold recovery of unresolved conflict |
| 7 | Close/reload/preview/test/validation/export: unsaved data dropped, preview/export consumes stale source or native error ignored | `dirty-close-dialog.test.tsx`, `native-editor-session-controller.test.ts`, preview/asset export suites and recovery tests | **Partial:** integrated dirty-state entrance/exit and native worker failure paths, never using headless preview as physical UI qualification |
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
