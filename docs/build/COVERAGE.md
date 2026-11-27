# Informational coverage

Coverage is a hole detector, not proof that a behavior is correctly tested. Investigate uncovered
public paths alongside the behavior-focused test policy; do not add artificial assertions to raise
percentages. There is no global numeric gate or combined C++/editor percentage. Codecov receives
separate native and editor reports for repository/PR coverage comparisons; its PR comments and checks
are controlled by Codecov settings, not a CI percentage threshold.
Test failures and broken report generation still fail CI.

## Boundaries and CI

The independent `Coverage` workflow runs on every pull request and every master push, in parallel
with required `Build`, without being a dependency or a required merge check. A single producer
instruments first-party targets using GCC/gcov (`-Og -g`) and publishes the exact test build
and CLI as run-scoped artifacts. Native CTest, native CLI CTest, Feature Lab, and Editor coverage
then execute concurrently on independent runners. The native consumers restore the exact producer
artifact by ID, verifying its checksum, source SHA, workflow run and absolute checkout path.
The compressed transfer retains executable modes, symlinks, generated test registrations,
assets, and coverage notes, but not compiler objects, static archives or live coverage counters.
Consumers do not repeat native compilation. Only the small final native report merge waits for
the three native suites; Editor coverage does not wait for native test execution or reporting.
The Feature Lab job runs the complete authored semantic/UI Test suite with an explicitly selected
instrumented native bridge and UI runner. It stages the checksum-verified, pinned FFmpeg tool separately and sets `NOVELTEA_FFMPEG` for the
Feature Lab suite so video-backed Animations can be prepared without waiting for the standalone
CLI build. The standalone release CLI is not used: its native objects are uninstrumented. The Lab measurement includes the
native preparation and playback operations exercised by that workflow, not TypeScript compiler
execution, manual station visits, or every perceptual check in the catalog.

One `noveltea-coverage-cpp` artifact contains four directories:

- `ctest/`: CTest-only HTML/JSON/Cobertura plus JUnit execution results.
- `ctest-cli/`: native CLI CTest-only coverage from isolated GCOV_PREFIX trees,
  merged offline in balanced rounds after each process exits; its JUnit results remain separate.
  Every instrumented native CLI invocation, including foreground commands and daemon workers,
  writes to a per-process counter root; per-CTest roots remain for other test executables.
  The daemon-owner certification and native broker record the exact PIDs they
  deliberately terminate with SIGTERM/SIGKILL, including broker-retired standby
  workers. Those profiles cannot be trusted to have completed libgcov shutdown,
  so only those declared PID roots are omitted from the offline merge.
  Other inputs are validated for complete GCC gcda record boundaries and terminal
  markers; unexpected truncation fails CI and preserves the bounded raw profile
  under the native coverage artifact's `diagnostics/` directory. This prevents
  a killed worker's partial gcda from crashing gcov-tool without turning genuine
  profile corruption into an accepted result.
- `feature-lab/`: Lab-only HTML/JSON/Cobertura plus the authored suite's JSON execution results.
- `combined/`: the union of covered native lines/branches from all three saved snapshots. Overlapping
  coverage counts once; percentages are not averaged or added.

Each suite starts with its own counter-free copy of the instrumented build. All tests using the
per-CTest CLI counter isolation convention run in the CLI lane, which merges their completed
counter trees before reporting. The total selected test set is unchanged. Combined reporting
reads only the three exact suite artifact IDs and frozen gcovr JSON snapshots, never live counters.
The measurements use the same configured native build and filters, so unexecuted compiled sources
remain visible and denominators are comparable. Individual suite reports remain downloadable on
failure; a combined partial report is diagnostic only, and native Codecov publication requires
all three suites to succeed. Compare the independent views to see what the authored workflows
exercise and what additional paths they cover beyond CTest.

Profile updates are atomic because runtime workers execute concurrently; ordinary shared-counter
increments can corrupt gcov branch counts. Dependency targets (including prebuilt upstream host-tool
closures) stay uninstrumented. First-party native coverage builds
use GCC `-Og -g` rather than `-O0`: generated authoring schema
projection and semantic validation become excessively slow without optimization, while `-Og`
retains debuggability and gcov counters. As with other compiler-optimized coverage builds,
individual line/branch placement can differ from `-O0`; compare reports only under the same flags.
Reports admit maintained engine headers/implementation, apps, and native editor tooling; tests, support,
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
to job summaries. Coverage also uploads `combined/cobertura.xml` under Codecov's
`native` flag and `editor/coverage/lcov.info` under its `editor` flag. Each job authenticates
through GitHub Actions OIDC (`id-token: write`), so no repository upload secret is needed.
Codecov uploads are informational (`fail_ci_if_error: false`) and are skipped for fork pull requests,
where Codecov OIDC authentication is unavailable. The repository must be enabled in Codecov
before reports are visible. Configure PR comments/status checks in Codecov itself.
Test or coverage-report generation failures still fail the respective Coverage job;
CodeCov network/upload failures do not. The normal Build runs CTest, native CLI
certification and Feature Lab without instrumentation, independent of these reports.
The editor Coverage job builds its own addon and stages checksum-verified media tools;
it does not depend on Build artifacts. Native/editor coverage caches restore vcpkg
read-only, with native instrumented compiler objects bounded to 2048M and
transported in seven-day workflow snapshots outside the shared Actions cache
quota. Only compatible snapshots from successful trusted master-push Coverage
runs are restored, using exact artifact IDs and SHA-256 verification; old cache
entries are read-only fallback inputs until a replacement exists. Maintenance
keeps the latest two successful snapshots per active compatibility prefix.
Frozen native coverage snapshots use two gcov reporter workers; the separate
suite counters, filters, reports and merged coverage union remain unchanged.
Coverage installs checksum-pinned ccache 4.14.3 and verifies an actual cache
hit reproduces both the object and coverage notes under GCC's atomic profiling
flags before building. Extended Qualification restores caches read-only to
prioritize Build's 10 GiB cache capacity.

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
