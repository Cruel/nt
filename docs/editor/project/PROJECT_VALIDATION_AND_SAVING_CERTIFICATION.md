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

### 2026-11-11 interactive attempt (not accepted)

The first scoped-Save case was **attempted and blocked** in an interactive
Feature Lab editor. Changing a Room display name visibly lagged native
acknowledgments and lost intermediate rapid input; Save was slow, Save of the
"Properties & Traits" Room failed, Save diagnostics switched the selected
bottom panel to Problems, and the tab could not be closed with Don't Save.
The visible Feature Lab Interaction-rule warnings are not evidence that the
Room itself is invalid. The actual rejection message from that packaged editor
was not captured, so the specific Save failure is not yet diagnosed.

The subsequent renderer patch adds immediately displayed, coalesced and
recoverable Room-name drafts; makes ordinary Room-name commits field-scoped;
retains exact-revision native discard after an editor failure; and stops Save
diagnostics from stealing bottom-panel selection. A full native Feature Lab
"Properties & Traits" Room edit/Save passes with the existing warning-heavy
fixture, as do mocked delayed-acknowledgment typing and dirty-close regressions.
**None of this converts the attempted human case to a pass.** Rebuild and
rerun case 1, including verifying the actual error/status if Save still fails,
before continuing with the remaining cases.

### 2026-11-11 native patch/Save latency optimization (not a UI acceptance pass)

The production native-addon performance investigation on a disposable full
Feature Lab Project identified repeated `ProjectSession::snapshot()` calls in
native patch, scoped Save, and addon response publication. Dirty Room display-name
changes also caused spurious Interaction dependency scans because sparse saved
`data.features` were compared against normalized working defaults, and they
triggered unrelated authored-Test dependency checks.

The native correction compares normalized saved and working semantic values,
avoids authored-Test dependency scans for changes confined to Room presentation
text, reuses the entry snapshot for scoped Save validation, and returns the
already-produced native operation snapshot from the addon. On the same Linux
Release-addon host, the **19 warm iterations** of 20 real patch-plus-Save cycles
measured median Room patch **292.2 → 120.8 ms**, scoped Save **253.4 → 75.2 ms**,
combined **546.9 → 196.7 ms**. Project title patch-plus-Save was **166.9 →
150.4 ms**. Every cycle wrote and read back the intended YAML, and no source
changes occurred in the checked-in fixture.

Remaining performance work is **mandatory**, not waived by these improvements:
localization validation still collects structured text from unchanged Project
records (~72–76 ms of a dirty Room snapshot), and the existing crash-safe
single-File transaction journal still performs durable filesystem syncs.
A provisional watcher-fenced reuse experiment was **rejected** because it
interfered with Save authority after an own-write; it is not part of production.
Most importantly, the renderer still must provide project-wide immediate input
and coalesced native synchronization instead of waiting for worker acknowledgment.
Do not mark #522 human or end-to-end UI-performance acceptance as passing until
those are implemented and qualified on an interactive installed editor.

## #609 packaged editing performance gate (2026-11-12; NOT CERTIFIED)

**Automated Linux/Xvfb evidence only. None of the eight human Feature Lab
cases above is newly certified, and #602/#609/#522 remain open.** This run
used a disposable copy of `tests/projects/feature-lab` and the packaged
Electron renderer, preload, native worker and C++ ProjectSession, not
jsdom/mock native operations. Source HEAD before packaging was
`c53a65d9` with the #609 benchmark changes **uncommitted**. The
development package identity was `1.0.0-dev.c53a65d9d7f4`; it is not
an immutable clean-commit release certification. The packaged build and
package smoke passed, including native tool, preview, asset and protocol
checks.

Host: Linux x64, AMD Ryzen 7 5700G, ASPEED/Vega GPUs, Node 24.18.0,
Electron 43.1.1, Chromium 150.0.7871.114; authoring Node addon SHA-256
`1860d1f8d80121c4f126f4ecab285ca67551c164c3dd4d439af162190f3e5350`.
This host has `XDG_SESSION_TYPE=tty` and no physical desktop DISPLAY;
the runner used Xvfb/software rendering. `input` below is the
input-handler-to-next-animation-frame-after-React-commit **proxy**, not
physical compositor presentation or photons.

The expanded `pnpm -C editor run benchmark:packaged-fields` suite
completed **19 cases × 20 real Chromium inserted characters**, with an
isolated ordinary controlled React input in the *same packaged renderer*.
Values exactly matched on-screen input under 0, 500 and 1,000 ms synthetic
native acknowledgment delays. Every Project Settings, Room and Character
case bounded the 20-character edit to **2–4 native patch calls**, received
native acknowledgments and passed native Save/YAML readback in the
disposable Project. The diagnostic-only Room/Character fast path separately
passed at zero added acknowledgment delay, including saved readback.

| Packaged surface | 0 ms input median / p95 | 500 ms input median / p95 | 1,000 ms input median / p95 |
| --- | --- | --- | --- |
| Ordinary React controlled input baseline | 9.22 / 15.98 ms | — | — |
| Project title | 14.27 / 30.71 ms | 9.91 / 16.24 ms | 10.71 / 44.57 ms |
| Room display name | 32.60 / 40.90 ms | 34.77 / 41.19 ms | 38.26 / 61.81 ms |
| Character display name | 8.79 / 19.40 ms | 7.86 / 16.63 ms | 10.77 / 16.64 ms |

The harness also measures Project version, author and description in all
three delayed-acknowledgment conditions, and emits count, median, p95,
maximum, idle-frame distribution, native acknowledgment times and patch
counts for each. The Room's **33.33-ms idle-frame median** in the
500/1,000-ms cases signals Xvfb frame-pacing overhead, but is not
sufficient to dismiss every editor-specific latency excursion. The separate
zero-delay diagnostic run measured Character input p95 **109.14 ms** with
idle p95 **16.67 ms**, whereas the subsequent full run measured Character
p95 19.40 ms. Retain both observations as scheduling variability; neither
certifies a 16-ms physical input latency target.

The initial 19-case harness did **not** cover cold first input, paste,
selection replacement, draft switching, duplicate tabs, nested Property
Manager, exact Interactable Instance, Scene/Dialogue, Tests,
Interaction/Verb, Layout/Map/Material, typed-number/collection edits, or
separate user-handler/React-commit/compositor/native-dispatch/validation/
scoped-Save phase timing. Its subsequent expansion is recorded below.

### #609 expanded final candidate, same host (still NOT CERTIFIED)

After adding Character dialogue-name, Interactable definition display-name,
the exact `gate-lever-1` Interactable Instance editor label and Room Camera
numeric width selection-replacement, the **freshly rebuilt Linux package**
passed `package:smoke` and `benchmark:packaged-fields` with **30/30 cases**:
28 × 20 real Chromium character insertions (including one isolated React
baseline) and two single-event numeric selection replacements. Every case
displayed the exact expected value; every native field received at least
one acknowledgment with bounded patch counts (1–4 in this full run). Native
scoped Save wrote and the harness read back the intended Project Settings,
Room, Character, Interactable definition and exact Instance YAML on disk.
The same native addon and `c53a65d9` base were used; #609 changes remained
uncommitted while packaging, so the package is **not** an immutable clean
commit artifact. The full editor suite passed **311 files / 2,377 tests**
(9 files / 94 tests skipped).

One intermediate full-suite run passed 2,376 tests but encountered an
`ENOTEMPTY` cleanup race in the existing #608 two-Project native-worker
integration test. Fixture cleanup now retries transient filesystem removal
collisions without weakening the native assertions. Its targeted native-addon
suite subsequently passed **20/20 tests**, and the final full editor suite
passed **2,377/2,377 active tests**.

| Field | 0 ms median / p95 | 500 ms median / p95 | 1,000 ms median / p95 |
| --- | --- | --- | --- |
| Same-renderer React baseline | 10.27 / 15.90 ms | — | — |
| Project title | 15.49 / 64.78 ms | 9.22 / 16.28 ms | 9.79 / 15.43 ms |
| Room display name | 35.06 / 37.40 ms | 34.38 / 37.98 ms | 36.81 / 44.63 ms |
| Room Camera numeric selection-replacement | 23.46 / 23.46 ms | — | 19.50 / 19.50 ms |
| Character display name | 11.76 / 77.29 ms | 8.75 / 16.42 ms | 7.27 / 16.11 ms |
| Character dialogue name | 7.87 / 15.28 ms | 9.23 / 41.17 ms | 10.09 / 15.74 ms |
| Interactable definition display name | 11.81 / 81.55 ms | 8.63 / 81.20 ms | 10.41 / 16.36 ms |
| Exact Instance editor label | 11.24 / 65.42 ms | 11.91 / 102.72 ms | 10.56 / 66.22 ms |

All figures are **input handler to the next animation frame after a React
commit**, not verified compositor presentation or physical key-to-paint.
The numeric test has only one sample per delay: its median equals its p95
and has no valid statistical latency claim. The full JSON emitted by the
harness includes sample count, maximum, idle-frame distribution, native
acknowledgment timings and patch count for each case. Even with a 16.67-ms
idle-frame p95, Interactable input p95 reached 102.72 ms; the separate
zero-delay targeted run also observed 184.71 ms for the definition field.
These are **unresolved performance observations**, not waived by native
Save correctness. Room idle frames were often 33–50 ms on Xvfb; the
isolated baseline itself occasionally had anomalous idle frames.

Still untested in this packaged matrix: cold first input, actual OS
clipboard paste, caret/selection editing for ordinary text, draft switching,
duplicate tabs, nested Property Manager, Scene/Dialogue, Tests,
Interaction/Verb, Layout/Map/Material, collection edits, and independent
compositor, native dispatch/validation and scoped-Save phase timing. Existing
owner-scoped recovery/Save regression tests do not replace those end-to-end
measurements. None of the **eight human cases** was performed on a physical
desktop; no Windows 11/macOS/physical-Linux qualification is available.
Do not close #609 or its parents until the remaining measurements and
physical acceptance pass, or the issue owner formally resolves the gate.
