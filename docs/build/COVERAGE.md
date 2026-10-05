# Informational coverage

Coverage is a hole detector, not proof that a behavior is correctly tested. Investigate uncovered
public paths alongside the behavior-focused test policy; do not add artificial assertions to raise
percentages. There is no global numeric gate, combined C++/editor percentage, or automated PR comment.
Test failures and broken report generation still fail CI.

## Boundaries and CI

The Build workflow's Linux desktop job instruments first-party native targets using GCC/gcov and runs
its normal CTest suite. Dependency targets (including embedded upstream host-tool closures) stay
uninstrumented. The report admits maintained engine headers/implementation, apps, and native editor
tooling; tests, support, dependencies, build-generated code and inactive stub implementations do not
count. The exact filter is [`cmake/gcovr.cfg`](../../cmake/gcovr.cfg). Unreachable/compiler-generated
and exception-only branches are excluded; reports are therefore compiler/configuration-specific.
Host tools are disabled in this CI job: this is native runtime/desktop coverage, not CLI certification
coverage or a claim of execution on Web/Android. Only compiled sources can contribute gcov data.

The editor job uses the matching Vitest V8 provider through Vite+. Explicit source inclusion keeps
unexecuted TypeScript modules visible at zero coverage. Tests/fixtures, declarations, generated route
code and upstream-generated UI primitives are excluded in
[`editor/vite.config.ts`](../../editor/vite.config.ts). Renderer tests may import shared/main/CLI
code, but this is not packaged Electron or native-bridge coverage. Coverage runs allow longer test
timeouts to account for instrumentation overhead without changing normal unit-test timeouts.

CI appends separate line/branch (C++) and line/function/branch (editor) tables to the job summaries.
Download `noveltea-coverage-cpp` and `noveltea-coverage-editor` artifacts for HTML plus machine-readable
reports, including per-file/branch data. C++ retains gcovr JSON, summary JSON and Cobertura; editor
retains Istanbul JSON, summary JSON and LCOV. gcovr uses repository-relative paths; Vitest's raw
Istanbul JSON uses resolved source paths (LCOV provides relative paths). These independent per-file
report sets can support a future baseline ratchet or changed-code policy; neither is selected now. Reports on test
failure can be partial and must not be mistaken for a successful baseline.

## Local commands

Keep native coverage in a separate build directory to avoid accumulated counters and incompatible
objects in normal builds. Use native GCC; cross-compilation/other compilers are rejected. With the
normal Linux prerequisites and standalone shader-compilation CLI available:

```sh
cmake --preset linux-debug -B build/linux-coverage -DNOVELTEA_ENABLE_COVERAGE=ON
cmake --build build/linux-coverage
xvfb-run -a ctest --test-dir build/linux-coverage --output-on-failure
mkdir -p build/reports/coverage/cpp
uv tool run gcovr==8.4 --config cmake/gcovr.cfg build/linux-coverage \
  --html-details build/reports/coverage/cpp/index.html \
  --json build/reports/coverage/cpp/coverage.json \
  --json-summary build/reports/coverage/cpp/summary.json \
  --xml build/reports/coverage/cpp/cobertura.xml
node scripts/coverage-summary.mjs cpp build/reports/coverage/cpp/summary.json
pnpm -C editor run test:coverage
node scripts/coverage-summary.mjs editor editor/coverage/coverage-summary.json
```

Open `build/reports/coverage/cpp/index.html` or `editor/coverage/index.html`. gcov must match the GCC
used to build (pass gcovr `--gcov-executable` if necessary). For a fresh native measurement, remove
only `.gcda` counters inside the coverage build before rerunning tests, or use a clean coverage build;
otherwise gcov accumulates executions. Do not mix counter files from different revisions/configurations.
Editor coverage cleans its report directory on each run. The gcovr tool and Vitest coverage provider
are development-only dependencies and never enter player packages.
