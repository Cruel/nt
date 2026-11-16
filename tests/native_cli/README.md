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
`narrative_metrics.py` covers optional typed planning metadata, canonical
duration estimates, malformed values, simple route totals, missing-data
uncertainty, and public read-only/usage contracts. It is also exercised against
the installed CLI by `certify-native-cli-public-contracts.mjs`.
`narrative_routes.py` adds mutually exclusive Story ending estimates, shared
Event/Content reuse, post-convergence typed-state divergence, logical artwork
and Character tiers, hard/soft budget findings, unknown/overlapping time
allocations, invalid references, and bounded-search exhaustion. Both metrics
suites run as native CTest and installed public-CLI certification.
`narrative_git.py` additionally exercises the public `--base` Git boundary,
protected-decision status and source locations, graph impact witnesses, path
moves, modified/untracked files, invalid history and read-only failure modes.
Run both with `ctest --test-dir build/linux-debug -R '^native_cli_narrative(_git)?$' --output-on-failure`.
`narrative_coverage.py` additionally exercises read-only Story-to-Project implementation
claims, nested Choice/Scene locations, dangling/duplicate links and separate
untrusted headless Test report attachments. Run with
`ctest --test-dir build/linux-debug -R '^native_cli_narrative_coverage$' --output-on-failure`.

The `compiled_project_parity.py` and `runtime_artifact_parity.py` drivers
compare native outputs with temporary TypeScript reference implementations.
Review these for retirement after native cutover, once independent native-only
coverage replaces them. The other drivers certify ongoing CLI/runtime behavior
and should not be removed simply because the CLI migration is complete.

Keep browser/Electron-specific tests in their existing Node/Vitest suites;
keep native C++ unit tests in their existing CTest targets. Add future native
CLI black-box drivers here rather than at the root of `tests/`.
