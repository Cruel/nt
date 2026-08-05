# Hotspot Authoring, Interaction, and Runtime Certification

Certified: 2026-08-05

Scope: completed hotspot authoring, compilation, resource preparation, prefetch, rendering, hit
testing, and activation work described by
`docs/architecture/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME.md`.

## Automated verification

- Editor format, typecheck, lint/check, schema-version policy, production build, fixture
  materialization, staging, packaging smoke, and the full Vitest suite passed. Vitest reported 184
  passed files, one skipped file, 1,140 passed tests, and four skipped tests.
- Linux threaded and no-thread builds passed. The final threaded and no-thread non-GPU matrices each
  passed 785/785 tests,
  including hotspot schema/material validation, alpha occupancy, custom-mask preparation, structured
  prefetch, residency, presentation projection, hit precedence, input consumption, exact activation,
  package loading, and runtime smoke coverage.
- The bounded unrestricted threaded matrix passed 795/803 tests. The eight remaining failures were
  X11-dependent readback captures or their downstream missing-capture verifiers. The layout-scale
  capture/verifier pair passed 2/2 under Xvfb after its stale compiled-project version-2 fixture was
  corrected to version 3; no schema, runtime, or hotspot test remained failing.
- C++ format and policy targets passed, including public-header, module-boundary, JSON-boundary,
  dependency-flag, exception/RTTI, and schema-version checks.
- The final post-correction invocation of
  `cmake --build --preset linux-debug --target format-check` passed.
- Threaded and single-thread Web builds passed after correcting cross-compiler comparison and preview
  JavaScript linkage. Android `:app:assembleDebug` passed.
- Direct native headless package export passed with empty valid shader/material metadata. The returned
  manifest, archived package manifest, and embedded `shader-materials.json` all declared
  `noveltea.shader-materials.v2`.

## Final review corrections

The final review added direct runtime projection coverage for preserved ineligible hotspots and the
passive focused-Room-preview boundary; corrected hard-coded current-schema diagnostics; corrected the
native editor tool's synthesized shader-material package schema; migrated two tracked runtime
readback fixtures to compiled-project version 3; and completed permanent Room, Interactable,
Interaction, Verb, Asset, Shader, Material, rendering, host-input, preview, package, migration,
overview, and archival documentation. These were closure corrections within Phases 10-12, not later
feature work.

## Performance and residency evidence

The native test `Representative hotspot preparation measurements retain exact residency` measures
the exact opaque-RGBA alpha occupancy loop and one-region custom-mask preparation at 1920x1080 and
3840x2160. It records total time, maximum custom-mask executor-step duration, step count, and exact
resident byte counts. On this certification host it reported:

- 1920x1080: alpha occupancy 3.848 ms; custom mask 110.208 ms total, 7.579 ms maximum step across
  17 steps; 259,200 alpha CPU bytes, 8,294,400 texture GPU bytes, and 2,073,600 mask GPU bytes.
- 3840x2160: alpha occupancy 15.094 ms; custom mask 436.059 ms total, 15.869 ms maximum step across
  34 steps; 1,036,800 alpha CPU bytes, 33,177,600 texture GPU bytes, and 8,294,400 mask GPU bytes.

These are diagnostic measurements, not platform-independent performance thresholds. The exact byte
assertions and successful cooperative completion are regression requirements.

Expected retained residency is exact:

- Alpha occupancy CPU bytes: `ceil(width / 8) * height`.
- Prepared RGBA texture GPU bytes: `width * height * 4` for the measured no-mip fixture.
- Binary custom-mask GPU bytes: `width * height`.
- Custom-mask temporary preparation reservation: `width * height`, released after finalization.

Prefetch telemetry classification is covered by the threaded and cooperative asset telemetry
matrices: ready-before-demand records a hit, demand joining unfinished prefetched work records useful
late, completed residency first demanded after prefetch records the corresponding lifecycle once, and
unpredicted demand records a miss/not-prefetched outcome without duplicate classification.

## Environment-limited verification

The current connector session has no usable X11 display, and ADB/device access is unavailable. SDL readback capture
tests therefore cannot initialize the X11 video backend, and interactive editor/Play-preview,
desktop-window, browser-visual, touch-device, Android-device, and assistive-technology manual checks
cannot be executed here. Their non-visual coordinate, ordering, routing, lifecycle, package, Web build,
and Android build contracts are covered by automated tests. These limitations do not make the
remaining implementation ambiguous or unsafe; they are explicit environment limitations rather than
product failures.

The local editor commands ran under Node 22.22.1 while the package declares Node 24.18.0. All commands
completed successfully; release CI remains authoritative for the declared toolchain.
