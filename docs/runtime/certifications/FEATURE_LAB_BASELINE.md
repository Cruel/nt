# Comprehensive Feature Lab baseline

## Certification boundary

Issue #259, verified 2026-10-05 against source baseline
`82710ee4275b66a403472e6c35e80af71f88cbb8` plus the #259 changes.
The non-Map Project is certified for inventory accounting, catalog integrity, ordinary Project
validation/compilation/package loading, and the selected automated acceptance set below.
This is **not** blanket human/perceptual/platform acceptance of every check.

The owner confirmed #254–#258 are implemented prerequisites despite their open tracker state.
Outstanding catalog limitations are retained rather than converted into passing coverage.
Map-specific Lab coverage is **owner-deferred**, neither covered nor automation-only, and does not
block this non-Map baseline. No removed Map station, mixed Map expectations, focus/UI activation,
stress/platform cases or Map assets are required. Existing Map implementation/tests and ordinary
Room navigation are unaffected. New Map Lab work requires explicit owner reopening.

## Reconciliation and authority

The registered Project Data Asset
[`feature-lab.json`](../../../tests/projects/feature-lab/assets/data/feature-lab.json) is authoritative.
The exhausted population plan is archived, with active routing removed. All 162 station-table rows
in the original #249 plan (`f6995d07a`) resolve to qualified catalog checks. The three pilot scenarios
and all 16 original pilot check IDs/creation timestamps are preserved; additional shared checks
remain in the catalog rather than another inventory matrix.

Automation-only families and deferred coverage transferred into separate catalog collections with
stable IDs, titles and reasons. Blocked/provisional scenarios and checks now consistently expose
`statusReason`; explanatory metadata changes advance modification time without replacing creation
history. Timestamp validation against the pre-#259 catalog passed. No scenario/check ID was renamed.

Generate the current accounting view, rather than copying these historical totals into a maintained
matrix:

```sh
node tools/feature-lab/report.mjs --output build/reports/feature-lab-accounting.json
```

At certification: 27 scenarios / 181 checks (161 ready, 8 provisional, 12 blocked), 22 automation-only
families and one deferred Map family. 86 checks have automation links; 43 authored Tests include five
unlinked witnesses. There are no declared visual checkpoint IDs. Checks need not have automation,
and Tests need not be linked. The generated view exposes scope/expected text, reasons, assets, links,
Test step counts and unlinked Tests; links and `ready` status are **not execution results**.

The validator verifies classification separation, record identities/kinds, actual Asset source
existence, automation/visual registry references and timestamp rules. Project validation and package
admission remain responsible for the full authoring/resource contracts. Synthetic/curated boundaries
express acceptance intent: documented reuse of curated button art as a synthetic animated badge is
intentional, not a new curation claim. Placeholder Music remains a placeholder.

## Completed verification

From the repository root, using the existing Linux standalone CLI and Linux debug binaries:

- `node --test tests/ci/feature_lab_tests.mjs`: 13/13. Added red/green coverage for explicit reasons,
  exclusive accounting, actual record/source resolution, derived reporting and timestamp rules.
  Corrected a stale test that froze the first scenario to the pilot despite authored order changes.
- `node --test tests/ci/*.mjs`: 55/55, including the catalog/report contract checks.
- `node tools/feature-lab/validate.mjs --previous /tmp/259-previous-catalog.json`: passed;
  previous catalog captured from the source baseline above.
- `pnpm -C editor run check`: passed. No editor implementation changed.
- `build/cli/linux/noveltea --project tests/projects/feature-lab --json validate`: passed;
  only informational inert-Hotspot diagnostics.
- `pnpm -C editor project:compile -- --project tests/projects/feature-lab --output /tmp/259-compiled-project.json --json`: passed.
- `build/cli/linux/noveltea --project tests/projects/feature-lab --json test run`: **43/43 passed**,
  20 semantic and 23 UI; zero blocked/failed/error Tests. The updated `rooms-interactions-ui` also
  passed individually: dirty mutation survives catalog reopening, same-station re-entry resets it,
  switching to the stress warning resets defaults, and returning retires the old Scene.
- `build/cli/linux/noveltea --project tests/projects/feature-lab --json package export --output /tmp/259-final-feature-lab.ntpkg --allow-localization-warnings`: passed.
  The explicit override acknowledges linguistic quality only, not technical readiness errors.
- `xvfb-run -a ctest --test-dir build/linux-debug --output-on-failure -R 'noveltea_(rmlui|presentation|world_presentation|world_transition|layout_scale|postprocess_scope|texture_sampling)_readback_(capture|verify)$'`:
  **14/14 passed**. This selected existing composition/pixel set supplements authored UI Tests;
  it is not a new Lab golden or an audio/shaping/host certification.
- `xvfb-run -a ./build/linux-debug/apps/sandbox/noveltea-sandbox --project-assets /tmp --compiled-project project:/259-final-feature-lab.ntpkg --demo none --frames 120 --screenshot /tmp/259-lab.png`:
  package startup/rendering passed; inspected screenshot shows the normal Feature Lab title shell.
  An initial absolute-path attempt was rejected by the normal logical Asset-path boundary; the
  corrected invocation above passed. This smoke does not claim manual completion of every station.

Local machine-readable reports/logs and the inspected image are retained under
`build/reports/feature-lab-certification/`; regenerate rather than treating those disposable outputs
as a second source of truth. Certified catalog SHA-256:
`e89cc365c013a76ede8772b87f42e51a6a04544ec980cd0e3254557de0e31c5b`.
Exported package SHA-256:
`19e6dd433be1524aefe7b1eeab431565c20593e7eb003d7a028c408e855742cb`.

## Acceptance limits and follow-up

Read current catalog reasons and the [Project README](../../../tests/projects/feature-lab/README.md)
for exact workflows. The 12 blocked checks retain partial-path/authoring/runtime/procurement gaps;
none is reclassified as automation-only merely to improve the numbers. The eight provisional checks
retain language-review and listening/actual-host acceptance. Localized audio still lacks a second
reference realization; the 3.318-second Music loop still requires human seam audition. Ready manual
checks likewise require their actual player procedure: captions and desired-state queries are not
proof of pixels, audible completion/pan/orphans, HiDPI, browser persistence or mobile suspension.

No privileged engine behavior, new media, broken parser fixtures or Map content was added. Linux/Web/
Android rebuilds, the full native/editor suites and actual Web/Android/HiDPI/audio procedures were not
rerun: this slice changes catalog/tooling/tests/docs, not runtime/platform implementation. The selected
native readbacks, package startup, editor typecheck and complete authored Lab suite are the directly
relevant checks; broader host/perceptual acceptance remains explicitly unclaimed.

Final review used the code-review Standards and Spec axes locally. Independent parallel review was
unavailable because this harness exposes no subagent tool. No blocking implementation finding remained;
Spec acceptance limits are the explicit manual/provisional/blocked boundaries above, not hidden passes.
