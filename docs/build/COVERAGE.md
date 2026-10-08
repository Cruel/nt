# Informational coverage

Coverage is a hole detector, not proof that a behavior is correctly tested. Investigate uncovered
public paths alongside the behavior-focused test policy; do not add artificial assertions to raise
percentages. There is no global numeric gate or combined C++/editor percentage. Codecov receives
separate native and editor reports for repository/PR coverage comparisons; its PR comments and checks
are controlled by Codecov settings, not a CI percentage threshold.
Test failures and broken report generation still fail CI.

## Boundaries and CI

The Build workflow's Linux desktop job instruments first-party native targets using GCC/gcov. It
runs the normal CTest suite and the complete Feature Lab authored semantic/UI Test suite through the
Node CLI driver, with an explicitly selected instrumented native bridge and UI runner. The job
stages the checksum-verified, pinned FFmpeg tool separately and sets `NOVELTEA_FFMPEG` for the
Feature Lab suite so video-backed Animations can be prepared without waiting for the standalone
CLI build. The standalone release CLI is not used: its native objects are uninstrumented. The Lab measurement includes the
native preparation and playback operations exercised by that workflow, not TypeScript compiler
execution, manual station visits, or every perceptual check in the catalog.

One `noveltea-coverage-cpp` artifact contains three independent directories:

- `ctest/`: CTest-only HTML/JSON/Cobertura plus JUnit execution results.
- `feature-lab/`: Lab-only HTML/JSON/Cobertura plus the authored suite's JSON execution results.
- `combined/`: the union of covered native lines/branches from both saved snapshots. Overlapping
  coverage counts once; percentages are not averaged or added.

Execution counters are cleared before each suite. The CTest snapshot is captured **before** clearing
its counters for the Lab; combined reporting reads only the saved gcovr JSON snapshots, never the
last suite's live counters. Both measurements use the same configured native build and filters, so
unexecuted compiled sources remain visible and denominators are comparable. Reports on test failure
can be partial and must not be mistaken for a successful baseline. Compare the two independent views
to see what the authored workflows exercise and what additional paths they cover beyond CTest.

Profile updates are atomic because runtime workers execute concurrently; ordinary shared-counter
increments can corrupt gcov branch counts. Dependency targets (including prebuilt upstream host-tool
closures) stay uninstrumented. Reports
admit maintained engine headers/implementation, apps, and native editor tooling; tests, support,
dependencies, build-generated code and inactive stub implementations do not count. The exact filter
is [`cmake/gcovr.cfg`](../../cmake/gcovr.cfg). Unreachable/compiler-generated and exception-only
branches are excluded; reports are compiler/configuration-specific. Only compiled sources can
contribute gcov data. This is Linux native coverage, not standalone CLI certification coverage or a
claim of execution on Web/Android. The prebuilt compiler closure avoids a second upstream tool build;
first-party native wrappers and the runtime remain instrumented.

The separate editor job uses the matching Vitest V8 provider through Vite+. Explicit source inclusion
keeps unexecuted TypeScript modules visible at zero coverage. Tests/fixtures, declarations, generated
route code and upstream-generated UI primitives are excluded in
[`editor/vite.config.ts`](../../editor/vite.config.ts). Renderer tests may import shared/main/CLI
code, but this is not packaged Electron or native-bridge coverage. Coverage runs allow longer test
timeouts to account for instrumentation overhead without changing normal unit-test timeouts.

CI appends three labeled native line/branch tables and a separate editor line/function/branch table
to job summaries. The Build workflow also uploads `combined/cobertura.xml` under Codecov's
`native` flag and `editor/coverage/lcov.info` under its `editor` flag. Each job authenticates
through GitHub Actions OIDC (`id-token: write`), so no repository upload secret is needed.
Uploads are informational (`fail_ci_if_error: false`) and are skipped for fork pull requests,
where Codecov OIDC authentication is unavailable. The repository must be enabled in Codecov
before reports are visible. Configure PR comments/status checks in Codecov itself.

Download `noveltea-coverage-editor` for editor HTML, Istanbul JSON, summary JSON and LCOV. gcovr uses repository-relative paths; Vitest's raw Istanbul JSON uses resolved source paths
(LCOV provides relative paths). These per-file report sets can support a future baseline ratchet or
changed-code policy; neither is selected now.

## Local commands

Keep native coverage in a separate build directory to avoid accumulated counters and incompatible
objects in normal builds. Use native GCC; cross-compilation/other compilers are rejected. With the
normal Linux prerequisites, pnpm dependencies, uv and standalone shader-compilation CLI available:

```sh
cmake --preset linux-debug -B build/linux-coverage \
  -DNOVELTEA_ENABLE_COVERAGE=ON -DNOVELTEA_BUILD_HOST_TOOLS=ON
cmake --build build/linux-coverage
pnpm -C editor exec vp pack

node scripts/native-coverage.mjs reset build/linux-coverage
mkdir -p build/reports/coverage/cpp/ctest
xvfb-run -a ctest --test-dir build/linux-coverage --output-on-failure \
  --output-junit "$PWD/build/reports/coverage/cpp/ctest/test-results.xml"
node scripts/native-coverage.mjs report build/linux-coverage build/reports/coverage/cpp/ctest

node editor/scripts/private-media-tools.mjs build/coverage-media
node scripts/native-coverage.mjs reset build/linux-coverage
mkdir -p build/reports/coverage/cpp/feature-lab
NOVELTEA_FFMPEG="$PWD/build/coverage-media/tools/ffmpeg/bin/ffmpeg" \
NOVELTEA_NATIVE_TOOL_BRIDGE="$PWD/build/linux-coverage/tools/editor_tool/noveltea-tooling-bridge" \
NOVELTEA_UI_TEST_RUNNER="$PWD/build/linux-coverage/tools/editor_tool/noveltea-ui-test-runner" \
  xvfb-run -a node editor/dist-electron/tools/noveltea.mjs \
    --project tests/projects/feature-lab --json test run \
    > build/reports/coverage/cpp/feature-lab/test-results.json
node scripts/native-coverage.mjs report build/linux-coverage build/reports/coverage/cpp/feature-lab
node scripts/native-coverage.mjs merge build/reports/coverage/cpp

node scripts/coverage-summary.mjs cpp build/reports/coverage/cpp/ctest/summary.json CTest
node scripts/coverage-summary.mjs cpp build/reports/coverage/cpp/feature-lab/summary.json 'Feature Lab'
node scripts/coverage-summary.mjs cpp build/reports/coverage/cpp/combined/summary.json 'Combined (union)'
pnpm -C editor run test:coverage
node scripts/coverage-summary.mjs editor editor/coverage/coverage-summary.json
```

Open each native directory's `index.html` or `editor/coverage/index.html`. The native reporter pins
gcovr through uv; gcov must match the GCC used to build. Run from the repository root. Counter reset
requires a coverage-enabled build, removes only `.gcda` files, preserves `.gcno` compilation notes,
and does not follow directory symlinks. Wait for every suite/child process to exit before capturing
or resetting counters. Do not run unrelated instrumented binaries between resets and snapshots, or
mix reports from different revisions/configurations. Editor coverage cleans its directory each run.
Coverage tooling is development-only and never enters player packages.
