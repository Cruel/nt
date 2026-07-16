# Architecture Documentation Overview

## Purpose

Use this entrypoint before changing top-level engine/framework architecture, subsystem ownership, initialization order, runtime loop shape, asset/project loading boundaries, or dependency policy.

## Current Documents

- `docs/architecture/ENGINE_ARCHITECTURE.md` describes the current engine/runtime architecture, ownership, initialization order, asset/project loading, main loop, core runtime, runtime UI bridge, Lua status, and contrast with old NovelTea context.
- `docs/architecture/CORE_DOMAIN_MODEL.md` is the current-direction contract for authoring/compiled/runtime ownership, definitions and programs, strong IDs, flow frames, inheritance and properties, mutable state, saves, and package/JSON boundaries.
- `docs/architecture/DOMAIN_COLLECTIONS_AND_RELATIONSHIPS.md` maps every V2 collection to its authoring, compiled, mutable, or tooling disposition and fixes cross-component, startup, continuation, inheritance, Lua-yield, and save-safe-point relationships.
- `docs/architecture/COMPILED_PROJECT_WIRE_V1.md` defines the strict TypeScript-owned
  `noveltea.compiled.project` V1 contract that the future native decoder consumes.
- `docs/architecture/AUTHORING_COMPILER.md` describes the pure staged authoring compiler and its
  deterministic diagnostic/publication rules.
- `docs/architecture/JSON_BOUNDARY_POLICY.md` defines the permanent JSON serialization boundary,
  mandatory repository checker, approved codec/adapter paths, and exception process.
- `docs/architecture/RUNTIME_CAPABILITY_DISPOSITION.md` is the durable capability-level evidence map
  for complete, deferred, rejected, duplicate, and tooling dispositions.
- `docs/architecture/PRESENTATION_AND_CHECKPOINT_OWNERSHIP.md` is the durable current ownership,
  consumer, test, and persistence inventory for the presentation-coordinator and safe-checkpoint
  implementation plan. It also freezes the Phase 1B final contracts; later phases maintain it with
  implementation evidence.
- `docs/OVERVIEW.md` maps the full documentation hierarchy.
- `docs/build/OVERVIEW.md` describes build/toolchain documentation.
- `docs/migration/OVERVIEW.md` describes migration status and legacy-reference policy.
- `docs/architecture/plans/CXX_NO_EXCEPTIONS_IMPLEMENTATION_PLAN.md` records the completed migration to
  explicit errors, no C++ exceptions, no compiler RTTI, dependency-specific custom RTTI where needed,
  and enforced rejection of hidden throwing APIs. It is an implementation record, not the primary
  contributor policy.
- `docs/architecture/plans/RUNTIME_AND_PRESENTATION_ARCHITECTURE_CONSOLIDATION_OVERVIEW.md` defines the
  post-typed-runtime consolidation needed before continuing unfinished world presentation work. It
  preserves completed checkpoint/Layout/coordinator foundations while ordering the future runtime
  capability, Room/world-presentation, scoped-presentation, revised rendering, and host-boundary
  specifications and implementation plans.
- `docs/architecture/WORLD_AND_ROOM_PRESENTATION_SPEC.md` defines the target generic Room-placement,
  Character world-state, Room-local cast, Interactable/Character Interaction-subject, restricted
  Room-composition, deterministic Room-resolution, recomposition, atomic navigation, and save/restore
  contracts required before final world rendering is implemented.
- `docs/architecture/RUNTIME_EXECUTION_AND_CAPABILITY_SPEC.md` is the normative target contract for
  runtime-session ownership, state organization, Flow responsibility, settled transactions,
  deferred internal commands, external host requests, semantic capability profiles, Lua adaptation,
  presentation/checkpoint integration, and coherent runtime publication.
- `docs/architecture/RUNTIME_CAPABILITY_CHARACTERIZATION.md` records the Phase 1 capability/input
  parity matrix and focused contract evidence that later ownership cutovers must preserve.
- `docs/architecture/plans/RUNTIME_EXECUTION_AND_CAPABILITY_IMPLEMENTATION_PLAN.md` orders the
  migration from the current broad script-owned runtime facade and mixed host brokerage to the final
  runtime session, deferred command queue, semantic capability profiles, direct presentation port,
  coherent publication, lifecycle, and namespace ownership.
- `docs/architecture/plans/HOST_AND_MODULE_BOUNDARY_IMPLEMENTATION_PLAN.md` orders the final
  host/physical consolidation after semantic contracts stabilize: Engine and GameHost ownership,
  Layout realization, RuntimeUI decomposition, deterministic input routing, preview/demo isolation,
  bounded CMake targets, dependency enforcement, and public-surface cleanup.
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
