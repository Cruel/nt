# Architecture Documentation Overview

## Purpose

Use this entrypoint before changing top-level engine/framework architecture, subsystem ownership, initialization order, runtime loop shape, asset/project loading boundaries, or dependency policy.

## Current Documents

- `docs/architecture/ENGINE_ARCHITECTURE.md` describes the current engine/runtime architecture, ownership, initialization order, asset/project loading, main loop, core runtime, runtime UI bridge, Lua status, and contrast with old NovelTea context.
- `docs/architecture/CORE_DOMAIN_MODEL.md` is the current-direction contract for authoring/compiled/runtime ownership, definitions and programs, strong IDs, flow frames, inheritance and properties, mutable state, saves, and package/JSON boundaries.
- `docs/architecture/DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md` maps every V2 collection to its authoring, compiled, mutable, or tooling disposition and fixes cross-component, startup, continuation, inheritance, Lua-yield, and save-safe-point relationships.
- `docs/architecture/COMPILED_PROJECT_WIRE_V2.md` defines the strict TypeScript-owned
  `noveltea.compiled.project` V2 contract consumed by the editor publisher and native decoder.
- `docs/architecture/AUTHORING_COMPILER.md` describes the pure staged authoring compiler and its
  deterministic diagnostic/publication rules.
- `docs/architecture/JSON_BOUNDARY_POLICY.md` defines the permanent JSON serialization boundary,
  mandatory repository checker, approved codec/adapter paths, and exception process.
- `docs/architecture/RUNTIME_CAPABILITY_DISPOSITION.md` is the durable capability-level evidence map
  for complete, deferred, rejected, duplicate, and tooling dispositions.
- `docs/rendering/PRESENTATION_STATE_AND_TRANSITION_SPEC.md` defines current presentation ownership,
  persistence, checkpoint classes, state-versus-operation boundaries, and transition behavior.
- `docs/OVERVIEW.md` maps the full documentation hierarchy.
- `docs/build/OVERVIEW.md` describes build/toolchain documentation.
- `docs/migration/OVERVIEW.md` describes migration status and legacy-reference policy.
- `docs/architecture/WORLD_AND_ROOM_PRESENTATION_SPEC.md` defines the implemented generic Room-placement,
  Character world-state, Room-local cast, Interactable/Character Interaction-subject, restricted
  Room-composition, deterministic Room-resolution, recomposition, atomic navigation, and save/restore
  contracts used by final world rendering.
- `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md` is the implemented normative contract for
  runtime-session ownership, state organization, Flow responsibility, settled transactions,
  deferred internal commands, external host requests, semantic capability profiles, Lua adaptation,
  presentation/checkpoint integration, and coherent runtime publication.
- `docs/architecture/HOST_INTERNAL_CONTRACTS.md` defines the private typed runtime-dispatch,
  RuntimeUI publication, Layout realization, preview, lifecycle, backend-notification, and frame-stage
  seams used by the extracted host owners.
- `docs/architecture/HOST_CHARACTERIZATION_MATRIX.md` maps the observable Engine/RuntimeUI lifecycle,
  dispatch, input, Layout, reload, clock, preview, and sandbox behavior protected by host tests.
- `docs/architecture/HOST_MODULE_DEPENDENCY_AUDIT.md` is the current post-cutover record of the final
  target graph, third-party visibility, public-header closure, app/tool/test links, platform
  differences, empty policy allowlists, forbidden-edge searches, and source-size review.
- `docs/architecture/HOST_MODULE_FILE_CLASSIFICATION.md` records the exhaustive primary-target
  classification for every production C/C++ source/header under `engine/include` and `engine/src`,
  including deliberate material/shader disposition and resolved mixed dependency edges.
- `docs/architecture/MODULE_BOUNDARY_POLICY.md` defines the enforced six-module include/link graph,
  exact exception format, generated-tree exclusions, and positive/negative checker-fixture coverage.
- `docs/archive/` contains completed implementation plans, pre-cutover ownership and dependency
  inventories, runtime capability baselines, migration benchmarks, and pre-consolidation history.
  Use the current documents above for implementation decisions.
- `docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md` records the dependency audit baseline and the
  authoritative admission requirements for C++ runtime dependencies.

## Code Areas

- `engine/` owns portable runtime/framework code.
- `apps/sandbox/` is the primary smoke-test app.
- `cmake/`, `vcpkg.json`, and platform folders provide build and dependency wiring.
- `editor/` owns the Electron editor but often mirrors architecture decisions in authoring/export code.

## Agent Rules

Keep architecture docs focused on current system boundaries and ownership. Detailed entity behavior belongs under `docs/engine/`; detailed runtime behavior belongs under `docs/runtime/`; renderer-specific details belong under `docs/rendering/`.

When changing top-level ownership or subsystem boundaries, update this hierarchy and any affected area overview.
