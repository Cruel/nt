# Project Validation and Saving Certification

Date: 2026-07-20

## Certification status

The Phase 8 code cutover, permanent documentation reconciliation, and automated certification are
complete. Human-driven manual editor acceptance remains outstanding, so the implementation plan's
Phase 8 and subphase 8C remain open.

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

The following checks passed from the Phase 8 working tree:

- editor full suite: 149 test files passed, 2 skipped; 856 tests passed, 5 skipped;
- compiler/golden/runtime/package focus: 8 files and 72 tests passed;
- save/settings/recovery/structural/preview/export focus: 11 files and 112 tests passed;
- editor formatting, typecheck, aggregate checks, renderer build, and Electron/main/preload/tool
  builds;
- Linux release `noveltea-editor-tool` build;
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

The following human-driven sequence is still required before Phase 8 can be marked complete:

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
