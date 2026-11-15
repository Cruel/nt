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

### #601 native follow-up: source-local reuse and journal preparation (2026-11-14)

The candidate native implementation adds exact-content-identified, per-record
structured Message contributions to resident localization validation. Each
changed Room contributor is decoded and projected once per new source identity;
unchanged contributors reuse their source-local projections. Without a verified
source observation, unchanged files are still read and exactly fingerprinted:
this is **not** a watcher-bypass or a substitute for source authority. The
working overlay includes staged additions and removals; a deleted source cannot
continue contributing text. Regression coverage checks cold/incremental
diagnostic parity and a same-size external source edit with its timestamp reset.

The native YAML transaction now writes and syncs blobs directly in its
unpublished staging directory, syncs the blob directories before publication,
and eliminates intermediate `writing` and per-target journal manifests. The
durable `prepared` journal contains the full exact-revision transaction;
recovery rolls back any incomplete target sequence. The durable `committed`
marker is still published after every target replacement. A real child-process
crash after the first rename certifies replay from a `prepared` manifest without
per-target progress markers. No durability, source revision, or writer lock
requirements are relaxed.

The repeatable native `noveltea-project-session-certify
--profile-presentation-edit tests/projects/feature-lab` mode measures 20 actual
patch + scoped Save/readback cycles, discards the first cycle, and reports
warm median/p95/max per owner plus structured Message work counts. It runs
against a disposable Feature Lab copy and does not stand in for the packaged
Electron input-to-paint or addon-worker benchmark. This step alone does **not**
complete #601: typed semantic invalidation, revision-aware Project snapshot
publication, the full Release-addon target, and human editor acceptance remain
independent gates. Do not infer #522 or #609 closure from these native tests.

The initial candidate measurement was taken on a Linux 6.1 x64 Debian host
(GCC 12.2, Ryzen 7 5700G), optimized `-O3 -DNDEBUG` native test executable,
against base HEAD `353c7aed` plus the uncommitted changes described here.
Command: `build/issue-601-release-ninja/tools/project_authoring/noveltea-project-session-certify
--profile-presentation-edit tests/projects/feature-lab`. Each row contains 19
warm iterations; metrics are **milliseconds, median / p95 / maximum**.

| Native operation | Patch | Scoped Save | Combined |
| --- | --- | --- | --- |
| Room display name | 52.51 / 59.40 / 59.40 | 57.36 / 81.58 / 81.58 | 109.18 / 135.01 / 135.01 |
| Project title | 25.56 / 28.59 / 28.59 | 100.80 / 127.65 / 127.65 | 127.87 / 153.25 / 153.25 |

The Room's 19 warm updates rechecked 19 structured-source owners and reused
2,717 unchanged source-local contributors. Every measured cycle was a real
native mutation and durable owner Save with YAML readback. The new executable
does not run through the earlier Node-API addon, and no same-host **previous
revision** was measured through this identical command. Therefore these values
do **not** establish a controlled before/after speedup against the 2026-11-11
120.8/75.2-ms addon baseline. The Room patch exceeds the desired 10-ms median
and 20-ms p95, and its 57.36-ms Save median exceeds the provisional 50-ms
budget; the Project title Save remains substantially slower. This is a partial
performance improvement candidate, **not an accepted #601 performance gate**.

Local verification: Linux native Project-session, Room presentation, typed
reference invalidation, dependency mutation graph, project validation, working
preparation, source watcher races, localization and YAML transaction recovery
CTests passed (including real crash/restart journal replay); the pinned C++
clang-format check passed all 730 files. `pnpm -C editor run check` passed
formatting, lint, TypeScript and schema/contract checks, with a Node engine
warning for installed 24.16.0 versus required 24.18.0. Packaged-addon/renderer
performance, Windows/macOS native regression, and physical UI acceptance were
**not** rerun for this isolated native C++ candidate.

## #630 native snapshot/publication investigation (2026-11-14; partial qualification)

The native addon now publishes the operation-produced Project snapshot plus
`affectedRecords` only. Previously it called `record_snapshots()` for **every**
resident record, even when serializing only one affected owner. An explicit
`snapshot()` request continues to return all inspected records. Native work
counters and an opt-in addon stderr profiler cover complete Project snapshot
assembly/time, record snapshots, JSON conversions/bytes, inspected record
checks, and unopened authored-Test/Interaction dependency checks without
altering the strict editor protocol or using cached data as source authority.

The disposable Feature Lab native certification asserts that an accepted
Room text patch assembles exactly two complete Project snapshots (before/new
working revision), a scoped Save exactly two (dirty entry/new persisted-source
state), and a stale-CAS rejection one (unchanged entry). Room text changes
perform zero unopened Test/Interaction checks. With both Room and Traits
inspected, addon publication converts only the affected Room record. The real
Node-addon benchmark exercises 20 patch/Save/readback cycles per owner, stale
rejections, cold/full snapshot parity, and invalid structured-Message repair.

Same Debian Linux 6.1 x64 / Ryzen 7 5700G, Node 24.16.0 host, Release builds,
19 warm iterations, values in milliseconds (median / p95 / max):

| Path and operation | Previously built addon (unverified provenance) | Rebuilt #630 candidate |
| --- | --- | --- |
| Room display name patch | 122.59 / 128.68 / 141.13 | 55.86 / 67.08 / 69.85 |
| Room display name Save | 78.33 / 103.09 / 103.20 | 59.65 / 64.94 / 66.82 |
| Room description patch | 122.28 / 127.54 / 128.30 | 55.30 / 57.81 / 58.30 |
| Room description Save | 76.23 / 79.69 / 120.10 | 59.26 / 64.14 / 67.94 |
| Project title patch | 28.31 / 29.39 / 29.56 | 28.81 / 31.60 / 36.41 |
| Project title Save | 122.62 / 128.27 / 128.70 | 108.33 / 114.26 / 114.29 |

The previously built addon SHA-256 was
`7ad367c6f2e693d122c8d60d707235d3adfb289b1ed9a35f5e63afbfd88cf4b5`;
the candidate was
`47946c7c2e941d9f9fd2bb206d75470451eb317a7da5eda5403de7654d49642a`.
The latter hash must be treated as a diagnostic only until the final build
identity is fixed. The former artifact's exact originating source commit was
**not independently verified**, so these are useful matched-host/entrypoint
observations, **not** a certified same-source-baseline speedup. **The apparent
large improvement in this table is superseded by the controlled comparison
below**; do not use it as the measured benefit of #630. Benchmarks were
run while the #630 diff was uncommitted on base `2f6d6466`; rerun on a clean
immutable release commit for formal performance qualification. Neither the
Room's 10-ms patch target nor end-to-end physical user-input acceptance is
met. The persisted-source/working-revision distinction, disk-authority checks,
and independent #601 journal/localization work remain unchanged.

### #630 final source-pinned comparison and closure evidence

Source commits: baseline **`2f6d64668853ce7ad1c072481e113b03e5467cf5`**
and implementation **`c6866cd347699f9904bf08be2dc8e73f826771d2`**;
the extended identical-entrypoint benchmark was committed at
**`1dc678085de4f1070ec0a2690bf96e873e9b044b`**. The baseline source
was extracted with `git archive 2f6d6466` into a separate temporary source
directory, with symlinks to the repository's pinned `node_modules` and
`editor/node_modules`. Both addons used standalone CMake/Ninja
`-DCMAKE_BUILD_TYPE=Release -DNOVELTEA_BUILD_AUTHORING_NODE_ADDON=ON`,
GCC 12.2 `-O3 -DNDEBUG`, the Electron 43.1.1 Node-API headers, and the same
locally downloaded, pinned libfyaml/jsoncons/xxHash source trees. The
Feature Lab fixture is byte-identical between the two Git commits. The
benchmark itself and its fixture were not edited between the two timed runs.

Exact Node-addon SHA-256: before
`5a493d953338c57ef41f2f4ad432fbbad82202179e3d5520045a03e51207a865`;
after `47946c7c2e941d9f9fd2bb206d75470451eb317a7da5eda5403de7654d49642a`.
Host: Debian Linux 6.1 x64, Ryzen 7 5700G, Node 24.16.0. Each case uses
an independent disposable Feature Lab copy per binary, 20 actual patch,
scoped Save/YAML readback and stale-CAS rejection cycles, discarding the
first and reporting the 19 warm cycles. Timings include addon-side Project
work, record serialization, Node-API transport and JSON parse; no renderer
or physical input latency is inferred. The same command was run sequentially
for both binaries, not concurrently:

```sh
node editor/scripts/benchmark-native-addon-publication.mjs "$BASELINE_BUILD/noveltea-authoring-node.node" --single-record
node editor/scripts/benchmark-native-addon-publication.mjs "$CANDIDATE_BUILD/noveltea-authoring-node.node" --single-record
node editor/scripts/benchmark-native-addon-publication.mjs "$BASELINE_BUILD/noveltea-authoring-node.node" --additional-inspected=16
node editor/scripts/benchmark-native-addon-publication.mjs "$CANDIDATE_BUILD/noveltea-authoring-node.node" --additional-inspected=16
```

**Single inspected Room, warm milliseconds (median / p95 / max):**

| Operation | Before | After |
| --- | --- | --- |
| Room display name patch | 54.91 / 57.03 / 59.07 | 55.79 / 63.57 / 76.52 |
| Room display name Save | 59.91 / 63.55 / 66.73 | 59.70 / 64.28 / 74.99 |
| Room description patch | 54.62 / 57.04 / 60.12 | 55.49 / 58.80 / 59.16 |
| Room description Save | 59.73 / 84.15 / 102.63 | 58.88 / 62.56 / 76.24 |
| Project title patch | 29.08 / 32.14 / 32.27 | 29.17 / 30.61 / 30.76 |
| Project title Save | 109.01 / 113.92 / 115.72 | 106.61 / 115.34 / 129.51 |

**With 16 additional inspected Rooms plus Traits, warm milliseconds
(median / p95 / max):**

| Operation | Before | After |
| --- | --- | --- |
| Room display name patch | 56.83 / 59.78 / 66.90 | 56.19 / 58.82 / 59.93 |
| Room display name Save | 62.02 / 66.04 / 79.24 | 62.15 / 81.99 / 103.21 |
| Room description patch | 56.72 / 67.10 / 70.65 | 56.06 / 57.68 / 58.32 |
| Room description Save | 60.87 / 64.70 / 65.07 | 60.29 / 64.43 / 80.48 |
| Project title patch | 30.53 / 34.55 / 37.17 | 30.74 / 32.95 / 34.16 |
| Project title Save | 108.63 / 114.76 / 118.83 | 110.10 / 117.71 / 125.16 |

Cold open plus explicit full snapshot: 315.17 ms before and 324.49 ms
after in the single-Room run; 292.74 ms and 307.61 ms with additional
records configured (the extra inspections occur **after** this measurement).
Rejected-CAS medians across these cases remained approximately 5–6 ms.
Both binaries passed identical source readback, full-snapshot parity,
invalid→repaired working Message, rejected Save and strict validation-DTO
checks. The native certification further asserts two Project snapshot
assemblies for an accepted patch (before/after), two for scoped Save
(working/persisted-source generations), one for rejected stale CAS, one
record snapshot for an affected-only delta, and zero unopened authored-Test
or Interaction dependency checks for Room presentation text. The addon
keeps explicit full-snapshot callers and renderer reconciliation unchanged;
an opt-in `NOVELTEA_AUTHORING_PROFILE=1` trace with 18 resident owners
confirmed an explicit full `snapshot` assembles 18 resident record snapshots,
whereas each `inspect` response and each accepted one-Room patch/Save
serializes one affected record. Project-only edits and stale-CAS rejections
assemble zero record snapshots for the delta. All mutation-result responses
serialize one addon result, without a second full Project snapshot in the
addon. The opt-in counters remain on stderr, not in the strict IPC DTO.
The project's internal full validation/diagnostic snapshot work remains
measurable and is addressed in the subsequent tickets. The real native
worker/reconciliation tests passed 58 active cases, and the
editor's full suite previously passed 2,471 active tests. Native
working-preparation, Project validation, roundtrip, presentation, typed
invalidation, watcher-race and pinned C++ formatting checks also passed.

**Interpretation:** #630 removes demonstrably redundant resident
record-snapshot assembly from addon delta publication without a protocol
or correctness regression. However, the source-pinned end-to-end addon
comparison does **not** demonstrate a meaningful median latency improvement;
the old unverified 122.59→55.86-ms comparison must not be cited as one.
The outstanding semantic dependency invalidation, localization source reads
and durable Save budgets are explicitly in #631, #632 and #633. The
10-ms Room patch goal is **not achieved**. Closing the scoped #630
publication ticket does not accept #601, #609 or #522 performance gates.

## #631 typed dirty-Project invalidation (2026-11-14; scoped acceptance)

Implemented in **`8ed4a7e18332cf1fb4820370c7ac97d127f1953b`**, following
`b1aa9fab2ce40b74f48cb8e508e585e5c29740b7` (#630 baseline).
The existing native typed dependency ledger remains authoritative. Normalized
effective Project title, author and description mutations no longer invalidate
all resident record contributions. Under exact authoritative source evidence,
those metadata-only edits also reuse the global policy contribution; changing
settings or entrypoints still triggers the conservative global path. Room/Map
label, display-name and description-only effective paths no longer propagate
through broad generic-record `/data` reverse edges. Actual Feature, reference,
instance and other nonpresentation paths still propagate. Full native
validation no longer duplicates the separate unopened Interaction/Test
fallback, which remains enabled for lazy editor inspection; Room test fallback
comparisons also use normalized (not sparse-source) before/after values.

An initial Room display-name trace revealed **84 rechecked contributions and
83 typed consumer invalidations** from one presentation patch. The new
`--path-precise-room` certification asserts **one rechecked contribution,
zero typed consumer invalidations and no unrelated invalidated owner**.
`--path-precise-mutations` asserts **zero** rechecked record contributions
for Project-title changes, retained contributions across the remaining Feature
Lab records and a reused global stage. The same certification checks sparse
empty Feature defaults, inline Room description, dirty-invalid→repaired Room
target, cold authoritative diagnostic parity, scoped Save/YAML readback,
stale-CAS rejection and conservative settings invalidation. Existing typed
identity tests cover deletion/restoration, source observation, reference
retargeting and cold parity. The optional `NOVELTEA_AUTHORING_PROFILE=1`
stderr trace exposes `typedChangePaths`, `typedEdgesConsidered` and
`typedConsumerInvalidations`; these never enter the strict native editor
validation DTO.

**Source-pinned Release Node-addon comparison:** baseline binary SHA-256
`47946c7c2e941d9f9fd2bb206d75470451eb317a7da5eda5403de7654d49642a`,
candidate binary SHA-256
`d09dc7bb12831b18d4db5c27b8599c317eb3f610ae095b6418b596c7b7ba81cf`.
Same Debian Linux 6.1 x64 / Ryzen 7 5700G / Node 24.16.0 host, Release
CMake addon build with shared pinned dependency sources and Node headers;
disposable unchanged Feature Lab fixture, one inspected Room, real addon
patch→`validateWorking`→scoped Save/YAML readback/stale-CAS, 20 cycles per
owner with the first discarded (19 warm, sequential binary runs). All cases
passed invalid Message→repair/full-snapshot parity and strict validation DTO
checks. The optional `--validate-working` benchmark flag measures the native
working validation separately from patch and Save.

| Operation | Before, median / p95 / max ms | After, median / p95 / max ms |
| --- | --- | --- |
| Room displayName patch | 127.40 / 134.41 / 135.90 | 127.78 / 131.41 / 148.01 |
| Room displayName validateWorking | 533.45 / 553.08 / 559.88 | 529.91 / 549.07 / 551.45 |
| Room displayName Save | 64.97 / 66.42 / 67.31 | 61.15 / 67.99 / 84.61 |
| Room description patch | 129.33 / 136.72 / 149.77 | 128.70 / 133.53 / 133.83 |
| Room description validateWorking | 535.57 / 558.07 / 592.25 | 534.22 / 549.48 / 550.40 |
| Room description Save | 64.54 / 82.25 / 87.04 | 61.18 / 68.19 / 72.40 |
| Project title patch | 30.23 / 34.74 / 35.28 | 30.57 / 32.55 / 33.03 |
| Project title validateWorking | 552.33 / 572.81 / 625.57 | 556.03 / 571.20 / 574.63 |
| Project title Save | 120.33 / 133.39 / 154.58 | 114.17 / 123.61 / 124.10 |

Reproduction:

```sh
node editor/scripts/benchmark-native-addon-publication.mjs /path/to/b1aa9fab-addon.node --single-record --validate-working
node editor/scripts/benchmark-native-addon-publication.mjs /path/to/8ed4a7e1-addon.node --single-record --validate-working
ctest --test-dir build/issue-601-release-ninja --output-on-failure -j 2 -R 'native_authoring_(path_precise|typed_reference_invalidation|dependency_mutation_graph|project_session|project_validation|presentation_edit|source_watcher_races|working_preparation|text_stage_matrix)'
```

**Interpretation:** the invalidation closure and repeated semantic work are
smaller, but an independently controlled end-to-end addon run finds **no
material latency improvement** at this stage. The full native snapshot and
other retained stages still dominate measured validation time. The 10-ms
Room edit goal is **not certified**; do not conflate this typed-closure ticket
with the subsequent source-read (#632), durable scoped-Save (#633), packaged
input (#609), or full acceptance (#601/#522) gates.

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

## #632 verified native localization source reuse (2026-11-14)

`ProjectSession::patch()` now invokes its **existing** `SourceAuthority` physical
observation for changes that invalidate localization, then exposes the verified
generation only while rebuilding the working snapshot. This is a normal
source observation, **not** a watcher-fence shortcut or a second freshness
registry. An observed unchanged YAML record supplies the exact source revision
and already parsed JSON; an unproven generation still requires a fresh file
read and content revision check. Source-identity keys are identical for
equal verified and independently reread bytes. External changes to an edited
owner still lose its exact revision precondition; unrelated observed changes
are not automatically treated as conflicts with that owner. The usual Save
CAS and own-write acknowledgment paths are unchanged.

The scoped work counters distinguish physical YAML opens, successful reads,
parses, exact disk hashes, observed contribution reuses, changed-source
projections, localization-model passes and dialogue-cue passes. They describe
the localization collector itself, not the source authority's captures or
other native patch activity. The existing validation-work profiler separately
counts physical file reads and YAML parses throughout the patched operation.
Counters reset on each actual localization validation; a retained localization
result does not fabricate a validation pass. A warm saved Room text update
continues to validate the **whole** `WorkspaceLocalization` model and its cue
contracts: translated Message completeness, duplicate/managed Message IDs,
structured placeholders, localized references and Dialogue Cue requirements
cross record boundaries. Reusing per-record extraction cannot bypass those
checks. Room label-only presentation edits retain the earlier no-rebuild path;
structured record source-text changes are not classified as presentation-only.

Linux x64 Release `-O3 -DNDEBUG`, same host, same
`noveltea-project-session-certify --profile-presentation-edit
tests/projects/feature-lab` command, same disposable Feature Lab fixture,
first iteration discarded, 19 warm iterations per operation. The before tree
was `e8249f7a7a61f30158a04b7fc3e7da5f50c01da1`; the after candidate is
the #632 change set on that parent (exact commit recorded in the issue).
Times in milliseconds, **median / p95 / max**:

| Operation | Before | After |
| --- | --- | --- |
| Room display-name patch | 50.70 / 69.10 / 69.10 | 42.99 / 49.55 / 49.55 |
| Room display-name scoped Save | 54.32 / 80.36 / 80.36 | 54.57 / 59.92 / 59.92 |
| Room description patch | 50.36 / 52.96 / 52.96 | 42.62 / 44.56 / 44.56 |
| Room description scoped Save | 54.32 / 58.04 / 58.04 | 55.05 / 66.04 / 66.04 |
| Project title patch (control) | 24.41 / 28.10 / 28.10 | 24.80 / 28.52 / 28.52 |
| Project title scoped Save (control) | 99.08 / 132.86 / 132.86 | 101.16 / 129.67 / 129.67 |

Each of the 19 post-change warm Room display-name patches had **zero**
localization physical YAML opens, reads, parses or fallback disk hashes:
2,717 reused observed contributions, 19 changed projections, 19 full
localization-model checks and 19 Dialogue Cue checks. The before collector
rehashed physically reread YAML for every unchanged contribution; before
instrumentation did not separate file opens from contributor reuse. End-to-end
patch work still measured 76 physical file reads and 57 YAML parses across
the same 19 operations **outside** the localization collector. No consistent
Save improvement or 16-ms patch guarantee follows from these noisy timings;
this work eliminates a verified redundant-I/O source, **not** the remaining
authoring latency identified in #601. This native CLI profiling is not
equivalent to packaged-addon, renderer paint, or physical editor acceptance.

Regression tests assert that the new cached projection preserves exact
cold/effective-Message parity after same-size restored-mtime external edits,
staged new/deleted records, lost watcher authority and source re-admission;
the multi-cycle Room presentation Save/reopen test asserts no false uncertain
authority or stale own-write result. Native source-watcher and YAML transaction
tests remain independent safety gates. The CTest-registered native Node-addon
localization-generation regression additionally asserts that translation
diagnostics appear immediately after a working Character text edit, clear on
repair, remain cleared after stale revision rejection, survive consecutive
successful owner Saves, and do not resurface on reopen. The shipped Feature Lab fixture already
supplies the Room, Dialogue, translated Message and authored content used for
these certifications; no generated Project files are changed by the tests.

## #633 crash-safe native scoped Save profiling and optimization (2026-11-15)

This is the final **native #601 candidate**, not packaged-editor or #522
acceptance. Base is `0500ae0fecf624cbc6aa3a568be4929b862733d4`
(#632); the exact post-change commit is recorded on #633 after committing.
Host: Debian Linux 6.1 x64, ext4 (`/dev/mapper/cluster0--vg-root`), Ryzen 7
5700G, Node 24.16.0, GCC 12, CMake/Ninja **Release `-O3 -DNDEBUG`**.
Addon: `build/native-authoring-host/noveltea-authoring-node.node`.
Baseline SHA-256:
`39cad24dbec78609016b6fa6c96ff6e30d7817138cefacf563e78b032eb748e3`;
candidate SHA-256:
`ee648836d45300f3d697b366bb5c17a529d2c9218dd3d12bc2dcd88e4bcdb7d6`.
These are **real native Node-API addon** binaries, built on the same host
from the pinned native dependency configuration. This benchmark and the CLI
profile do not include renderer/IPC scheduling or physical UI paint.

### Durability and exact-source changes

`YamlTransactionService::prepare()` now reads one metadata-fenced exact byte
generation, rather than separately reading once for its revision and again
for the source content. Commit's selected-target precondition uses the same
single-read capture. Target installation reads the destination once for the
before/after comparison and reuses its verified journal blob when replacing.
No CAS, baseline-byte comparison, symlink containment, journal revision or
recovery conflict check is omitted. The transaction's original durable
`prepared` and `committed` states, writer lease, before/after blob fsync,
target file sync and target-parent sync remain mandatory.

Three **directory** fsyncs were provably redundant: (1) syncing the
`.preparing-*` name before journal publication (recovery ignores it), (2)
syncing the unpublished staging-parent entries before `write_journal()`
immediately fsyncs the **same** directory after publishing the manifest, and
(3) syncing the parent after deleting an already-committed journal. In the
last case the committed marker and physical targets are already durable;
if a crash restores that journal name, recovery idempotently replays the
committed state, and the writer-lock release also syncs the same parent on
ordinary return. No file fsync or protected publication fence was removed.

One native single-owner Save therefore retains **6 file syncs, 8 directory
syncs, 2 journal manifest writes and 1 target application** (previously
6/11/2/1). The physical journal tests assert one source read in Prepare,
bounded commit reads, preserved sparse YAML comments and durability counts.
Crash certification forks a real child process and terminates after staged
blobs, prepared publication, the first target, all targets, committed
publication and completed cleanup. Recovery must roll back *every* uncommitted
two-target group, retain *every* committed group and remove orphan journals
without clobbering external bytes. These are process-death/restart checks,
not a claim to have performed actual power-cut filesystem qualification.

### Controlled warm benchmark

Reproduce on a disposable unmodified Feature Lab copy with 20 sequential
patch→scoped Save/readback iterations per owner, discarding the first (19
warm), then test patch-only, semantic no-op, typed invalidation/repair,
external overlapping disk write, rejected Save and reopen:

```sh
node editor/scripts/benchmark-native-addon-publication.mjs \
  build/native-authoring-host/noveltea-authoring-node.node
NOVELTEA_AUTHORING_PROFILE=1 node editor/scripts/benchmark-native-addon-publication.mjs \
  build/native-authoring-host/noveltea-authoring-node.node 2> /tmp/native-addon-work.log
build/native-authoring-host/noveltea-project-session-certify \
  --profile-presentation-edit tests/projects/feature-lab
```

Real addon numbers in milliseconds, **median / p95 / max**, same host,
same entrypoint, same fixture, separate baseline and candidate runs:

| Operation | Before #632 | After #633 candidate |
| --- | --- | --- |
| Room displayName patch | 48.68 / 51.65 / 54.37 | 45.08 / 48.17 / 66.34 |
| Room displayName scoped Save | 60.64 / 62.75 / 84.75 | 53.85 / 57.02 / 58.18 |
| Room description patch | 48.31 / 52.41 / 55.41 | 45.28 / 47.83 / 68.87 |
| Room description scoped Save | 59.93 / 65.12 / 87.98 | 54.04 / 75.51 / 77.91 |
| Project title patch | 29.64 / 31.96 / 32.84 | 30.23 / 57.31 / 59.06 |
| Project title scoped Save | 108.78 / 116.04 / 122.83 | 104.64 / 189.85 / 207.58 |

On this candidate a separate 19-warm **in-memory-only** Room patch run
measured 45.08 / 46.51 / 46.81 ms and confirmed no YAML changed before
one final scoped Save. The no-op patch retained the working revision;
a genuine local-property type change produced invalid diagnostics and
restoration cleared them. A subsequent overlapping external Room name
edit correctly rejected Save and survived Project reopen.

Native Release **CLI** (distinct entrypoint) candidate Room display-name
patch measured 42.44 / 45.63 / 45.63 ms, scoped Save
50.61 / 67.46 / 67.46; Room description 42.04 / 44.80 / 44.80 patch and
49.02 / 57.07 / 57.07 Save. Project title Save was
96.18 / 106.99 / 106.99. The source-pinned #632 CLI measurements above
are the previous CLI baseline; do not interchange CLI and addon numbers.

`NOVELTEA_AUTHORING_PROFILE=1` sends stage counters to **stderr only**,
not the strict editor IPC. Across 19 warm Room display-name Saves the
candidate totaled 152 directory syncs, 114 file syncs, 38 journal writes,
133 transaction source reads, 57 exact checks and 19 target applications.
Phase means per warm **pre-sync-optimization** Room Save (from the
instrumented intermediate run) were transaction preparation 4.69 ms,
commit 41.56 ms, blob preparation 6.64 ms, prepared journal publication
8.50 ms, target installation 6.03 ms, committed marker 5.71 ms and
cleanup 2.95 ms. The final CLI counter run measured commit **37.05 ms**,
directory sync total **17.72 ms** vs 22.75 ms earlier, cleanup **0.20 ms**,
with all six file syncs preserved. Stages overlap; do not sum their values
as if they were independent exclusive time buckets.

Project-title Save is structurally different: YAML transaction preparation
alone takes ~33.5 ms versus ~4.5 ms for a Room; its larger source document
still requires comment-preserving YAML materialization. Optimizing this
further needs specific verified preflight and sparse YAML correctness, not
skipping source checks or reusing stale editor state. Warm Room patch latency
also still includes actual localization and native semantic validation; #632
intentionally retained global Message and Dialogue Cue passes.

**Budget is not certified.** The issue's target of ~10 ms warm Room patch
median / <=20 ms p95 remains missed, as does <=50 ms real-addon scoped Save
median on this ext4 host (53.85 ms in the controlled run). It would be
incorrect to declare #601 accepted based on these improvements without the
issue owner's explicit performance exception or further fixes. Windows,
macOS, installed-editor input-to-paint, and interactive human acceptance
remain unverified on this Linux headless host; #609 and #522 are independent.

Linux checks for this exact candidate: the ten specified native Project and
YAML CTests passed (10/10); the additive native addon-localization CTest
passed (1/1); the production-compatible Electron worker build and real native
worker/reconciliation suites passed (7 worker tests and 51 reconciliation
tests, with one reconciliation test skipped). `pnpm -C editor run check` and
the pinned clang-format 18.1.8 gate (730 files) passed. The GitHub Build
workflow has dedicated Linux/Windows/macOS native-authoring-host jobs;
their results for this candidate must be verified after pushing the commit.

The subsequent full `pnpm -C editor run test` completed with **323 test
files passed, 14 skipped; 2,471 tests passed, 214 skipped**, without a failing
test. The skips include optional native/packaged-host parity qualifications
that are not implied by the full editor run and are not counted as passed.

### #633 final native Patch/Save budget certification (2026-11-15)

The **historical budget failure above is superseded** by #635/#636's
incremental Room localization and native Patch publication, #634's durable
explicit single-file Save, and `b2412cda`'s source-fenced post-Save snapshot
and localization-generation reuse. The latter requires a verified observation
of the new persisted source generation; only the saved Room revision may
advance, the retained working Room must remain semantically identical, and
all other physical source revisions and managed text analyses must remain
unchanged. External source mutation, lost watcher coverage, semantic change,
or inability to rebase falls back to regular validation. Optional cache
maintenance cannot turn an already durable Save into an error.

Reproducible commands, run **serially** without concurrent test/build work:

```sh
node editor/scripts/benchmark-native-addon-publication.mjs \
  build/native-authoring-host/noveltea-authoring-node.node --single-record
build/native-authoring-host/noveltea-project-session-certify \
  --profile-presentation-edit tests/projects/feature-lab
build/native-authoring-host/noveltea-project-session-certify \
  --profile-unsaved-room-patches tests/projects/feature-lab
```

Both before and after use Debian Linux 6.1 x86_64, ext4 on
`/dev/mapper/cluster0--vg-root`, Node 24.16.0 and the same disposable
unmodified Feature Lab fixture. Compiler: GCC 12, CMake **Release -O3
-DNDEBUG**. Native addon SHA-256 before the final `b2412cda` change
(`1b095563` tree):
`35f61eb79ad67bfc4e0c63dd07d9b047547c8a650d36d36de2029fa34d916b55`;
after:
`cdfed8f7968cca503a77301a0874df41ff485777421806823cd9219efe36d6ba`.
The addon and CLI run the same native `ProjectSession` algorithms, but
Node-API conversion is included only in the addon measurement. All samples
are **22 warmed** real Patch→Save/readback iterations per owner (first
iteration excluded); figures below are p50 / p95 in milliseconds.

| Operation | Real addon before final rebase | Real addon after | Final native C++ |
| --- | ---: | ---: | ---: |
| Room displayName Patch after Save | 43.51 / 48.09 | 17.27 / 19.03 | **9.85 / 11.74** |
| Room displayName scoped Save | 33.27 / 34.70 | **37.67 / 40.02** | 32.08 / 37.86 |
| Room description Patch after Save | 44.30 / 48.39 | 17.23 / 19.34 | **10.13 / 11.01** |
| Room description scoped Save | 33.22 / 35.86 | 37.48 / 45.59 | 32.18 / 37.59 |
| Project title Patch | 20.61 / 21.56 | 20.45 / 24.09 | 16.86 / 21.44 |
| Project title journaled Save | 102.02 / 111.79 | 101.94 / 118.67 | 99.59 / 111.34 |

The final native Room displayName Patch max was 16.96 ms; Save max
44.15 ms. The real addon Room Patch max was 21.00 ms; Save max 41.61 ms.
The **~10 ms native warm Room Patch and <=20 ms p95** and the **<=50 ms
real-addon scoped Room Save median** targets are satisfied on this host.
The Project title is a separate, always-journaled, larger YAML workload;
its ~102 ms addon Save remains a documented residual cost, not a claimed
Room-budget pass. This does not certify UI input-to-paint or packaged Save.

Across 22 final native displayName Patch→Save cycles, Patch performed
**22 Project snapshot assemblies, 22 incremental Message validations,
0 full localization contract validations and 0 localization disk YAML reads**.
Save performed **44 file syncs, 66 directory syncs, 0 journal writes**:
exactly 2 file / 3 directory syncs per explicit Room Save, with no
durability barriers removed by the post-Save reuse. A separate 19-warm
unsaved Room Patch profile remained ~10.15 / 12.52 ms (displayName) and
~10.03 / 12.97 ms (description) without full localization validation.

New regression certification verifies reuse of the immediately preceding
Save's authoritative diagnostic snapshot, incremental localization on the
first new edit, multi-owner Save All still journaled, and an unexpected
external disk modification immediately after Save **disabling** reuse and
rejecting stale writer changes without overwriting those bytes. The
previous #633/#634 process-kill and journal rollback/roll-forward cases
remain mandatory. All ten required native CTests passed on this final
Release build; pinned clang-format 18.1.8 and editor check passed. Full
editor suite results and final closure provenance are recorded on #633.

The real-addon integration suites passed **7 native worker tests and 51
reconciliation tests**, with one reconciliation test skipped. Regenerate the
Electron worker bundle before running them; an older local `dist-electron`
bundle predating #634 rejects the `saveMode` command field even though the
current source protocol supports it:

```sh
pnpm -C editor run build:electron
NOVELTEA_AUTHORING_NODE_ADDON="$PWD/build/native-authoring-host/noveltea-authoring-node.node" \
  pnpm -C editor exec vitest run \
  src/renderer/test/native-authoring-reconciliation.test.ts \
  src/renderer/test/native-authoring-worker.test.ts
```

The complete editor suite passed **323 files / 2,472 tests** on its final
run (14 files / 214 tests skipped). One separate thumbnail prewarm-priority
test failed on an earlier full-suite run, then passed both its isolated
25-test rerun and the final full-suite run; it is unrelated to scoped Save.

**Limits:** No GitHub Actions were dispatched (CI quota unavailable).
Packaged Windows/macOS native-addon, actual power-loss filesystem behavior,
and interactive editor latency remain unverified; these are not inferred
from passing Linux process-crash tests. #601 integration and #522 product
acceptance remain separate from #633's native performance qualification.
