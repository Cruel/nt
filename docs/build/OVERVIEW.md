# Build Documentation Overview

## Purpose

Use this entrypoint before changing CMake presets, dependencies, shader compilation, platform build wiring, CI build behavior, or verification commands.

## Current Documents

- `docs/build/BUILD_AND_VERIFY.md` lists the common local verification commands for Linux, Web, Android, editor, and smoke checks.
- `docs/build/CMAKE_OPTIONS.md` lists supported CMake cache variables, dependency acquisition choices, shader tool paths, runtime asset paths, and removed options.
- `docs/build/PLATFORM_EXPORT_SUPPORT.md` records the versioned initial player-template/export target matrix and provisional compatibility floors.
- `docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md` defines the active compiler, dependency,
  custom-RTTI, host-tool exemption, and dependency-admission policy.
- `docs/architecture/plans/CXX_NO_EXCEPTIONS_IMPLEMENTATION_PLAN.md` is the completed migration record.

## Code Areas

- `CMakeLists.txt`, `engine/CMakeLists.txt`, `apps/*/CMakeLists.txt`, and `cmake/` define C++ build behavior.
- `android/` contains the Android Gradle project and native build integration.
- `.github/workflows/` contains CI/release workflows.
- `package.json` and scripts under `scripts/` may provide Web smoke and helper commands.

## Agent Rules

Keep Linux and Web builds healthy after engine/build changes. Run the smallest relevant build first, then the broader build or smoke check called out by `docs/build/BUILD_AND_VERIFY.md` when the touched area requires it.

When adding or removing a CMake option, update `docs/build/CMAKE_OPTIONS.md` and any affected command examples in `docs/build/BUILD_AND_VERIFY.md`.

When changing Android, shader, packaged-asset, or cross-platform build behavior, record the completed verification and any unavailable SDK/tool limitation in the final response.
