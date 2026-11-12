# #608 — Integrated native Save, recovery, conflict and lifecycle certification

Status: **in progress** (initial cross-owner Save gate implemented). Parent #602
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
| 1 | Active owner Save with another pending owner: stale Save or collateral dirty clearance | `project-save-coordinator.test.ts` scoped Save and dependent-owner tests; `native-field-drafts.test.tsx` field coalescer | **Started:** new 500/1,000-ms held-IPC test verifies selective flush, native Save owner, saved vs working projections. **Missing:** real-addon YAML bytes for Room/Scene/Dialogue and independent owner after reopen |
| 2 | Save All partial failure/retry: failed native patch or Save falsely marks owners clean or loses recoverable text | `project-save-coordinator.test.ts` pending-field exclusion, native refusal, all-owner atomic Save and invalid raw inputs | **Existing mock coverage only:** inject a failing native flush and physical Save error across multiple owners, retry and inspect exact disk + recovery |
| 3 | Save As/copy/restart: old Project overwritten, pending drafts silently committed or copied incompletely | `project-save-coordinator.test.ts` baseline-plus-recovery copy, pending number and unmounted draft; `native-dirty-recovery.test.ts` checkpoint identity | **Existing mock coverage only:** copy to disposable physical destination, reopen both paths and verify revision, bytes and original Project identity |
| 4 | Shared exact Instance: stale old owner dispatch, close while queued, dropped new owner intent | `exact-instance-drafts.test.tsx` ownership transfer, queued replanning, overlap and failed recovery; `dirty-close-dialog.test.tsx` duplicate-close behavior | **Partial:** combine Room and Definition views with cross-owner close *during* queued/dispatched patch and cold recovery; verify exact native owner and YAML |
| 5 | Undo/Redo plus structural operations: stale text resurrected or wrong unit saved after create/delete/move | `native-field-drafts.test.tsx` field generations and Undo/Redo; `project-save-coordinator.test.ts` atomic closures; `project-explorer.test.tsx` structural controls | **Partial:** integrate pending field + structural move/delete + Undo/Redo + Save with a real native source round trip and persisted readback |
| 6 | External edit and cold restart: disjoint changes fail to rebase, overlapping field silently overwrites disk | `project-external-reconciliation.test.ts`, `project-save-coordinator.test.ts` Use Disk/Keep Mine and CAS, `exact-instance-drafts.test.tsx` recovery | **Partial:** native addon external physical mutations, two consecutive overlapping edits, explicit resolution and exact YAML/revision checks |
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

The eight workflows above need deterministic end-to-end addon/disk/readback
evidence (including native rejection, mixed owner CAS, physical project copies,
recovery after restart, and Save/Undo/Redo source identity). Run the editor
`check`, full real-addon renderer suite, native smoke and review the resulting
diff before closing. Keep #602 open until #609 is accepted.
