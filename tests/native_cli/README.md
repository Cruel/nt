# Native CLI black-box certification

This directory contains Python test drivers that exercise the compiled native
NovelTea CLI and related native runtime preparation tools. CTest registers
each driver separately from `tools/editor_tool/CMakeLists.txt`; they are
automatically included when a configured native build runs CTest with
`BUILD_TESTING=ON`.

Run the native CLI cases with:

```sh
ctest --test-dir build/linux-debug -R '^native_cli_|^native_compiled_project_parity$|^native_runtime_(artifact_parity|physical)$' --output-on-failure
```

`narrative.py` exercises `noveltea narrative validate` and
`noveltea narrative context` outside a Project against pinned upstream
positive/negative catalogs, diagnostics/locations, bounded typed state,
deterministic Context Manifest selection, stage readiness and Milestone handoff
selection, status-scoped evidence and read-only filesystem behavior. Its generated expectations need no
Node or sibling checkout at test time. See
[the contract refresh procedure](../../docs/editor/NARRATIVE_CLI.md#one-upstream-contract-reproducible-native-distribution).
Run it alone with `ctest --test-dir build/linux-debug -R '^native_cli_narrative$' --output-on-failure`.
`narrative_git.py` additionally exercises the public `--base` Git boundary,
protected-decision status and source locations, graph impact witnesses, path
moves, modified/untracked files, invalid history and read-only failure modes.
Run both with `ctest --test-dir build/linux-debug -R '^native_cli_narrative(_git)?$' --output-on-failure`.

The `compiled_project_parity.py` and `runtime_artifact_parity.py` drivers
compare native outputs with temporary TypeScript reference implementations.
Review these for retirement after native cutover, once independent native-only
coverage replaces them. The other drivers certify ongoing CLI/runtime behavior
and should not be removed simply because the CLI migration is complete.

Keep browser/Electron-specific tests in their existing Node/Vitest suites;
keep native C++ unit tests in their existing CTest targets. Add future native
CLI black-box drivers here rather than at the root of `tests/`.
