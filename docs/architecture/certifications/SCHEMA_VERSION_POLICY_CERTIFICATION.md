# Schema Version Policy Certification

## Certification Scope

- Certification date: 2026-07-28.
- Reviewed repository base HEAD: `7f77196ace33025857bd5d7aba995af7d9f3ab34`.
- This record also covers the uncommitted final-review corrections made after that HEAD. No commit was
  created, as requested.
- Governing policy: `docs/architecture/SCHEMA_VERSION_POLICY.md`.
- Archived implementation history:
  `docs/archive/plans/SINGLE_CURRENT_SCHEMA_VERSION_IMPLEMENTATION_PLAN.md`.

This is an automated-policy and command-validation certification with the explicit verification
limitations recorded below. It is not evidence that every manual, full-native, or Web smoke item in
the original Phase 8 exit gate was executed.

## Contract Inventory Summary

`cmake/schema_version_policy/contracts.tsv` contains 46 inventoried normal-read contracts. Each row
records the reviewed current marker and version, owner, known producer paths, known consumer paths,
unsupported-input action, positive current evidence, and negative unsupported-input evidence.

Ownership distribution:

- 28 editor-owned contracts;
- 10 editor/native shared contracts;
- 5 engine-owned contracts;
- 3 build-owned contracts.

Current-version distribution:

- 32 version 1 contracts;
- 12 version 2 contracts;
- 1 version 3 contract;
- 1 version 6 contract.

The final review corrected the inventory markers for the runtime-package manifest, save state,
runtime user settings, platform certification, and Shader-stage draft contracts. It also added
previously omitted player-template, player-config, Android-export, and platform-export schema paths,
and added separate rows for the Character V1, Dialogue V2, Scene V2, and legacy Layout V1 preview
documents.

The inventory covers project and compiled-project documents, runtime packages, editor metadata and
session state, persisted tab-state and draft boundaries, ComfyUI manifests and generated cache,
preview transports/documents, Shader/material documents, save/checkpoint/settings/profiler state,
resource aliases, player bootstrap/templates, platform export/profile/registry/certification data,
and the editor distribution stage manifest.

`cmake/schema_version_policy/temporary_debt.tsv` is header-only. The permanent exception file has
two exact matches, both confined to negative rejection tests for retired fields; neither permits a
production compatibility path.

## Removed Compatibility

The completed implementation and final-review corrections removed or prohibited the following
compatibility behavior:

- ComfyUI V1 and missing-version manifest acceptance, retired `outputNodeIds`, and generated cache
  entries without an exact current identity, schema version, and ComfyUI version.
- Editor project-state V1 migration, browser-local shell-state migration, and retired authoring
  export-identity extraction or stripping.
- Tab-state and draft restoration that checked only identity, ignored version, or restored Room state
  without either check.
- The retired `noveltea.editor.shader-stage-draft` positive fixture; Shader source drafts now use
  `noveltea.editor.draft.shader-stage-source` exclusively.
- Array-shaped legacy entity-record normalization in `entity.replaceRecord`; the production command
  now requires the current object form and an ID matching the collection key.
- Legacy Character, Dialogue, Scene, and Layout preview documents with missing or retired embedded
  schema identities.
- Optional compiled/focused-preview image sampling and decoder defaults for omitted sampling.
- Authoring Shader compiled-output string/object unions and incomplete metadata objects.
- Runtime Shader binary string/object unions, unnamespaced compiled paths, and object-shaped role
  bindings.
- Resource-alias unwrapped roots, string entries, duplicate field aliases, and enum casing aliases.
- Editor stage manifests without a stable identity and verification that ignored the manifest
  version.

## Validation Evidence

The editor commands use the repository-required Node.js 24.18.0 installation. CMake builds inherit
the existing `CMAKE_BUILD_PARALLEL_LEVEL`; the value is not overridden.

The original Phase 8 command-only pass recorded these successful results:

| Command | Result |
| --- | --- |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run format:check` | PASS — 540 files checked. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run typecheck` | PASS. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run check` | PASS — formatting, lint with zero warnings/errors, type checking, and editor schema-policy check passed. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run test` | PASS — 168 test files passed, 1 skipped; 1,035 tests passed, 4 skipped. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run build` | PASS — renderer, Electron main/preload/tools, and bundle-policy validation completed. |
| `cmake --build --preset linux-debug --target noveltea-schema-version-policy cxx-policy format-check` | PASS — schema-policy checker and self-tests, complete C++ runtime policy, public-header/dependency/module/JSON checks, and clang-format check passed. |
| `git diff --check` | PASS after certification creation and plan archival. |

The final-review correction pass produced these results against base HEAD `7f77196a` plus the
uncommitted corrections:

| Command | Result |
| --- | --- |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run format:check` | PASS — 540 files checked. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run check` | PASS — formatting, lint with zero warnings/errors, type checking, and schema-policy check passed. |
| `PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH" pnpm -C editor run test` | PASS — 168 test files passed, 1 skipped; 1,036 tests passed, 4 skipped. |
| `VCPKG_ROOT=/home/thomas/dev/vcpkg cmake --fresh --preset linux-debug` | PASS — restored the missing Linux debug cache using the repository's existing vcpkg checkout. |
| `VCPKG_ROOT=/home/thomas/dev/vcpkg cmake --build --preset linux-debug --target noveltea-schema-version-policy` | PASS — policy checker and self-tests passed. |
| `VCPKG_ROOT=/home/thomas/dev/vcpkg cmake --build --preset linux-debug --target cxx-policy` | PASS — complete C++ runtime, dependency, public-header, module, JSON-boundary, and schema-version policies passed. |
| `git diff --check` | PASS. |

The first direct CMake target attempt found no usable cache. A subsequent configure attempt without
`VCPKG_ROOT` expanded the toolchain path to `/scripts/buildsystems/vcpkg.cmake` and failed. These were
environment/setup failures, not policy failures; the fresh preset configuration and both requested
targets passed once `VCPKG_ROOT` was set to `/home/thomas/dev/vcpkg`.

Non-failing observations from the aggregate suites were existing React `act(...)` warnings in some UI
tests, an Electron dependency-bundle cleanliness notice, and the renderer chunk-size advisory. They
did not produce test, lint, policy, or build failures.

## Verification Limitations

The following original Phase 8 exit-gate evidence was not performed or was not recorded:

- no interactive GUI/manual smoke matrix;
- no complete Linux native CTest run;
- no Web debug/editor-preview build or focused Web preview smoke.

No environmental failure record establishes that these checks were impossible; they were outside
the command-only certification pass that was actually run. Consequently, this document certifies the
recorded automated schema-policy, editor, C++ policy, formatting, and repository-hygiene results, but
does not certify the omitted native/Web/manual portions of the original Phase 8 exit gate.
