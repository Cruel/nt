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
- `docs/architecture/plans/TYPED_RUNTIME_MODEL_AND_JSON_BOUNDARIES_IMPLEMENTATION_PLAN.md` is the active
  canonical plan for replacing legacy-shaped JSON runtime state with AuthoringProject V2, the
  deterministic compiled-project boundary, the native `CompiledProject`, typed flow/session/save
  models, typed runtime messages, and enforced JSON isolation.
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
