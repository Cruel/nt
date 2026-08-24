# Schema Version Policy Certification

## Certification Scope

- Certification date: 2026-08-24.
- Reviewed repository base HEAD: `52bc8d9828cbd0ec3125c3984753e81f02aa1ef3` plus the current uncommitted schema/version refactor.
- Governing policy: `docs/architecture/SCHEMA_VERSION_POLICY.md`.

This record certifies the automated compatibility-boundary inventory, static policy, editor tests,
native non-display tests, and production builds exercised during the refactor. It does not certify
interactive GUI behavior or display-dependent pixel readback tests on this shell.

## Contract Inventory Summary

`cmake/schema_version_policy/contracts.tsv` contains 10 independently versioned compatibility
boundaries. Every development boundary is version 1:

| Boundary | Owner |
| --- | --- |
| Project Workspace | editor |
| Compiled Project | editor + engine |
| Save File | engine |
| Player Template | build |
| Player Runtime API | editor + engine |
| User Config | editor |
| ComfyUI Workflow Manifest | editor |
| Editor Runtime Protocol | editor + engine |
| Runtime User Settings | engine |
| CLI JSON Protocol | editor |

Authoring Project documents, nested editor/tab/view state, focused preview document kinds,
shader/material metadata, resource aliases, asset-profiler payloads, template-registry records,
platform export profiles, Agent Kit generated manifests, and same-run certification/signing/alignment
reports are current-only schemas or generated records rather than independent compatibility epochs.
They retain stable identity/discriminant fields where useful but do not carry standalone numeric
versions.

The policy checker also rejects `.vN` current schema tags and `Vn` current source symbols in the
governed production trees. Version suffixes are reserved for code that intentionally supports more
than one historical version at the same time.

## Refactor Outcomes

- Compiled Project is Format V1 with stable `compiledProjectWire*` source names and cross-language
  version agreement.
- Save persistence has one physical Save File V1 envelope with stable `NTSAVE` magic. Inner runtime
  save-state JSON is unversioned; checkpoint metadata does not duplicate the file format version.
- Player compatibility uses exactly Player Template Format V1, Compiled Project Format V1, and
  Player Runtime API V1. The redundant runtime-package/player-config API ranges were removed.
- Editor runtime/focused-preview traffic uses one protocol version at the transport seam. Nested
  preview documents do not carry independent schema versions.
- Durable editor user preferences, shared ComfyUI settings, and export configuration are owned by
  `noveltea.user-config` V1 at `<NovelTea user config>/config.json`.
- Disposable/local editor state is governed by its owning persistence boundary or strict current
  shape rather than independently versioning every nested payload.
- Generated certification, signing, browser, Android-alignment, and dependency-audit reports that
  are consumed only within the producing workflow no longer define shadow compatibility versions.
- Resource Alias and Shader/Material schemas use stable current identities without numeric suffixes.

## Validation Evidence

The following commands passed against the current working tree:

| Command | Result |
| --- | --- |
| `pnpm -C editor run typecheck` | PASS. |
| `pnpm -C editor exec vp test run --reporter=dot` | PASS — 221 test files passed, 2 skipped; 1,587 tests passed, 5 skipped. |
| `cmake --build build/linux-debug-schema-refactor -j 8` | PASS — complete native debug/test graph, 1,163 build steps. |
| `build/linux-debug-schema-refactor/tests/noveltea_host_tests` | PASS — 104 test cases, 1,512 assertions. |
| `ctest --test-dir build/linux-debug-schema-refactor -E 'readback|capture|feature_fixtures_verify' --output-on-failure` | PASS — 877/877 non-display tests. |
| `cmake --build build/linux-release -j 8` | PASS. |
| `cmake --build build/linux-release --target noveltea-schema-version-policy` | PASS — policy checker and checker self-tests. |
| `git diff --check` | PASS. |

A native CTest run through test 894 initially exposed refactor-sensitive stale fixtures and one real
Save File implementation inconsistency. The stale Editor Runtime Protocol and Compiled Project
fixtures were updated to V1. The filesystem save store was corrected so metadata-less `write_slot`
writes are still wrapped in the Save File V1 envelope that `read_slot` expects. The corrected tests
pass directly, and the complete `noveltea_host_tests` executable is green.

## Verification Limitations

Display-dependent readback capture/verification tests beginning at CTest 895 cannot execute in the
current shell because SDL reports `x11 not available`. Their verifier failures follow from the absent
capture files. This is an environment limitation rather than a schema/version failure; the ordinary
native UI/host tests compile and pass. Interactive GUI/manual and Web-browser smoke matrices were not
performed as part of this certification.

Existing React test warnings about updates not wrapped in `act(...)` remain non-failing observations
and are unrelated to the compatibility-boundary refactor. A later full editor rerun also hit one
unrelated image-thumbnail scheduler timing failure; that exact test passed immediately in isolation.
