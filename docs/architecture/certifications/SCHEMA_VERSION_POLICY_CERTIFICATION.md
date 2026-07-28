# Schema Version Policy Certification

## Certification Scope

- Certification date: 2026-07-28.
- Reviewed repository HEAD: `1bb63aee886d6c6775168a04d15526167cc219fa`.
- The certification was performed against that HEAD plus the uncommitted Phase 8 working-tree
  changes. No commit was created, as requested.
- Governing policy: `docs/architecture/SCHEMA_VERSION_POLICY.md`.
- Archived implementation history:
  `docs/archive/plans/SINGLE_CURRENT_SCHEMA_VERSION_IMPLEMENTATION_PLAN.md`.

## Contract Inventory Summary

`cmake/schema_version_policy/contracts.tsv` contains 42 inventoried normal-read contracts. Every row
records the current marker and version, owner, producer paths, consumer paths, unsupported-input
action, positive current evidence, and negative unsupported-input evidence.

Ownership distribution:

- 24 editor-owned contracts;
- 10 editor/native shared contracts;
- 5 engine-owned contracts;
- 3 build-owned contracts.

Current-version distribution:

- 30 version 1 contracts;
- 10 version 2 contracts;
- 1 version 3 contract;
- 1 version 6 contract.

The inventory covers project and compiled-project documents, runtime packages, editor metadata and
session state, every persisted tab-state and draft boundary, ComfyUI manifests and generated cache,
preview transports/documents, Shader/material documents, save/checkpoint/settings/profiler state,
resource aliases, player bootstrap/templates, platform export/profile/registry/certification data,
and the editor distribution stage manifest.

`cmake/schema_version_policy/temporary_debt.tsv` is header-only. The permanent exception file has
two exact matches, both confined to negative rejection tests for retired fields; neither permits a
production compatibility path.

## Removed Compatibility

The completed implementation removed or prohibited the following compatibility behavior:

- ComfyUI V1 and missing-version manifest acceptance, retired `outputNodeIds`, and generated cache
  entries without an exact current identity, schema version, and ComfyUI version.
- Editor project-state V1 migration, browser-local shell-state migration, and retired authoring
  export-identity extraction or stripping.
- Tab-state and draft restoration that checked only identity, ignored version, or restored Room state
  without either check.
- Optional compiled/focused-preview image sampling and decoder defaults for omitted sampling.
- Authoring Shader compiled-output string/object unions and incomplete metadata objects.
- Runtime Shader binary string/object unions, unnamespaced compiled paths, and object-shaped role
  bindings.
- Resource-alias unwrapped roots, string entries, duplicate field aliases, and enum casing aliases.
- Editor stage manifests without a stable identity and verification that ignored the manifest
  version.

## Validation Evidence

The editor commands used the repository-required Node.js 24.18.0 installation. CMake builds inherited
`CMAKE_BUILD_PARALLEL_LEVEL=6`; the value was not overridden.

| Command | Result |
| --- | --- |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run format:check` | PASS — 540 files checked. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run typecheck` | PASS. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run check` | PASS — formatting, lint with zero warnings/errors, type checking, and editor schema-policy check passed. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run test` | PASS — 168 test files passed, 1 skipped; 1,035 tests passed, 4 skipped. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run build` | PASS — renderer, Electron main/preload/tools, and bundle-policy validation completed. |
| `cmake --build --preset linux-debug --target noveltea-schema-version-policy cxx-policy format-check` | PASS — schema-policy checker and self-tests, complete C++ runtime policy, public-header/dependency/module/JSON checks, and clang-format check passed. |
| `git diff --check` | PASS after certification creation and plan archival. |

Non-failing observations from the aggregate suites were existing React `act(...)` warnings in some UI
tests, an Electron dependency-bundle cleanliness notice, and the renderer chunk-size advisory. They
did not produce test, lint, policy, or build failures.

No interactive GUI/manual smoke was performed in this final command-only certification pass. The
user-directed final matrix consisted of the policy, editor, C++ policy, formatting, and repository
hygiene commands recorded above.
