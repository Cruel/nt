# Architecture Documentation Overview

## Purpose

Use this entrypoint before changing top-level engine/framework architecture, subsystem ownership, initialization order, runtime loop shape, asset/project loading boundaries, or dependency policy.

## Current Documents

- `docs/architecture/ENGINE_ARCHITECTURE.md` describes the current engine/runtime architecture, ownership, initialization order, asset/project loading, main loop, core runtime, runtime UI bridge, Lua status, and contrast with old NovelTea context.
- `docs/OVERVIEW.md` maps the full documentation hierarchy.
- `docs/build/OVERVIEW.md` describes build/toolchain documentation.
- `docs/migration/OVERVIEW.md` describes migration status and legacy-reference policy.
- `docs/architecture/plans/CXX_NO_EXCEPTIONS_IMPLEMENTATION_PLAN.md` defines the repository-wide migration
  to explicit errors, no C++ exceptions, no compiler RTTI, dependency-specific custom RTTI where needed,
  and enforced rejection of hidden throwing APIs.
- `docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md` records the dependency audit baseline and the
  admission requirements for C++ runtime dependencies.

## Code Areas

- `engine/` owns portable runtime/framework code.
- `apps/sandbox/` is the primary smoke-test app.
- `cmake/`, `vcpkg.json`, and platform folders provide build and dependency wiring.
- `editor/` owns the Electron editor but often mirrors architecture decisions in authoring/export code.

## Agent Rules

Keep architecture docs focused on current system boundaries and ownership. Detailed entity behavior belongs under `docs/engine/`; detailed runtime behavior belongs under `docs/runtime/`; renderer-specific details belong under `docs/rendering/`.

When changing top-level ownership or subsystem boundaries, update this hierarchy and any affected area overview.
