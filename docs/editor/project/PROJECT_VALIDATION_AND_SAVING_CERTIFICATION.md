# Project Validation and Saving Certification

Date: 2026-07-20

## Certification status

The code cutover, permanent documentation reconciliation, and automated certification are complete.
Human-driven manual editor acceptance remains outstanding, so final certification remains open.

## Cutover audit

- Project and window close have no renderer-accessible whole-document Save API. They wait for
  structural persistence and flush editor metadata/recovery only.
- Active Save and Save All use save-unit ownership and conflict-checked scoped writes.
- Save As is a copy operation over the saved baseline plus editor metadata, recovery, and dirty-only
  project assets; it does not change active project identity or dirty state.
- `savedHistoryCursor` has been removed. Command history cursors exist only for Undo/Redo traversal;
  dirty state compares logical save-unit ownership against the saved document plus pending input.
- Project Settings has no whole-form draft, Apply callback, Apply modal, or draft-only validation
  path. Focused commands update the authoritative working document immediately, while
  nonrepresentable raw input is retained per field in recovery metadata.
- Successful platform-export identity is metadata-only. No compatibility content command or
  structural auto-commit rule remains for that workflow.
- Every Explorer structural mutation is classified by the executable structural-persistence rules
  or remains an explicitly visible manual-save unit.
- The renderer IPC surface contains scoped content Save, metadata Save, and Save As copy operations;
  the obsolete whole-project Save and old Save As branches have been removed.

## Additional certification repair

Android template export initially exposed an incomplete source closure: the template packaged
`NovelTeaPublicHeaderProbes.cmake` but omitted the required `tests/public_headers` probe sources.
`cmake/package-android-player-template.mjs` now includes that directory. A freshly generated
immutable x86_64 debug template builds and exports both fixture revisions successfully.

## Automated validation

The following checks passed from the certification working tree:

- editor full suite: 149 test files passed, 2 skipped; 856 tests passed, 5 skipped;
- compiler/golden/runtime/package focus: 8 files and 72 tests passed;
- save/settings/recovery/structural/preview/export focus: 11 files and 112 tests passed;
- editor formatting, typecheck, aggregate checks, renderer build, and Electron/main/preload/tool
  builds;
- Linux release `noveltea` CLI/native-tooling build;
- packaged Linux editor verification and smoke, including renderer, preload, packaged protocol and
  traversal protection, engine preview, editor assets, native editor tool, and sharp;
- canonical Linux Desktop export: 10 tests passed, 3 host-specific tests skipped;
- canonical Web export: 3 tests passed;
- Android x86_64 debug checkout build with Java 17, NDK 28.2.13676358, CMake 3.31.6, and certified
  `essl-300` shader assets;
- fresh immutable Android template packaging;
- Android export fixture revision 1: verified APK export passed;
- Android export fixture revision 2: verified APK export passed;
- bundletool 1.18.1 archive checksum verification;
- source audit for obsolete whole-project Save, old Save As, global saved-cursor state, and
  successful-export identity compatibility symbols.

Non-failing observations:

- the host uses Node 22.22.1 while the repository declares Node 24.18.0; all listed checks passed;
- existing React test `act(...)` warnings remain in several renderer suites;
- packaged smoke emitted non-fatal WSL/DBus/GLib/GPU warnings.

## Manual editor acceptance remaining

The following human-driven sequence is still required before certification can be marked complete:

- two independently dirty tabs with one invalid tab;
- active-tab Save and partial Save All;
- Save As followed by verification of baseline-plus-recovery behavior;
- duplicate-view close semantics;
- structural auto-commit followed by persisted Undo and Redo;
- project close/reopen recovery;
- stale Play preview followed by correction without reopening;
- platform identity-change confirmation, including cancel and success behavior.

Automated renderer and service suites cover each contract, but they do not substitute for the plan's
explicit human-driven editor smoke requirement.

## Native #522 manual reconciliation (2026-11-07 UTC)

**All eight human-driven cases above remain NOT EXECUTED.** The fresh Linux
Electron/Xvfb smoke at `76b17588` used the real renderer, preload, main,
native worker and addon to create, open, enumerate sources and validate a
Project. It did **not** drive these eight interactions. The full editor suite
(2,140 passed, 148 skipped), explicit real-addon reconciliation suite
(34 passed, 1 skipped), native CTests (43 passed), ten-stage installed native
production certification and packaged editor launch smoke are separate
passing *automated* evidence, recorded in
[the #522 production ledger](../../architecture/certifications/NATIVE_AUTHORING_PRODUCTION_QUALIFICATION.md).
In particular, the new `483ac07b` save/recovery ownership handoff has
real-addon regression coverage, but no manual certification credit.

On an interactive packaged-editor host, use a **disposable copy of Feature
Lab** and record pass/fail and affected files for each item, in this order:

1. Open two distinct dirty records, make one invalid; Save the active valid
   tab, then Save All. Verify only independently valid units reach disk;
   invalid/blocked units and their recovery remain dirty.
2. Save As with another unsaved change. Reopen both original and destination:
   saved baseline stays on disk, unsaved overlay is recoverable, and the
   active Project does not switch during Save As.
3. Open two views of one dirty save unit. Close the first without a content
   prompt; close the last and exercise Save, Don't Save and Cancel.
4. Perform an Explorer structural auto-commit; Undo and Redo it and reopen
   the Project. Check persisted source and metadata, not just visible rows.
5. Close/restart the application with dirty YAML and Lua/RML buffers, then
   reopen. Verify unsaved content survives in recovery without changing
   tracked disk bytes. Exercise a disjoint external CLI edit and an overlapping
   edit, ordinary Save refusal, **Use Disk**, **Keep Mine** and a second
   intervening disk edit.
6. Open Play preview with a stale/invalid source, repair it, and verify the
   corrected preview and authored runtime/UI Test without a Project reopen.
7. Exercise the platform identity-change confirmation: Cancel must leave
   identity/output unchanged; approved confirmation must publish the expected
   export without losing unrelated dirty work.
8. Reopen after Save/Save All and after a forced worker/application restart;
   confirm the expected source bytes, comments, conflict state, native
   diagnostics and no silently committed or discarded recovery state.

These are **human acceptance**, not extra requirements to weaken the
automated matrix. The current host has no interactive desktop session
(`XDG_SESSION_TYPE=tty`); Xvfb automation cannot certify hand-driven
selection, visual feedback or preview usability. #522 must remain open until
the eight cases are observed and recorded, alongside the separate end-to-end
performance and exact-commit host qualification in the #522 ledger.
