# AGENTS.md

## Project Purpose

This repository is the new NovelTea runtime/framework. The target stack is SDL3 for platform/input/windowing, bgfx for rendering across Linux, Web, and Android, RmlUi for runtime UI, Dear ImGui for developer/debug UI only, and Lua for runtime scripting.

This is a new engine/editor, not a compatibility fork of the old `Cruel/NovelTea` engine. The old engine is a reference for selected behavior and workflows only; new runtime, editor, and project-format decisions should choose the best new-engine design rather than preserve old formats or APIs.

## Repository Layout

- `engine/` contains the portable runtime framework.
- `apps/sandbox/` is the current smoke-test application and should remain a fast verification target.
- `android/` contains the Android Gradle project that builds the native CMake project.
- `cmake/` contains toolchains and build helpers.
- `editor/` is for the Electron/TanStack/Vite editor direction, not the old Qt editor.
- `docs/` contains current architecture, build, runtime, UI, rendering, editor, migration, and archive notes.
- `docs/migration/` contains current migration status and the next migration-plan index.
- `docs/archive/` contains historical reports that must not be treated as current implementation direction.
- `refs/` contains local read-only clones used solely as migration/implementation reference. Currently: `NovelTea/` (old engine), `bgfx/`, `bimg/`, `bx/`, and `RmlUi/` (upstream library snapshots).

## Non-Negotiable Migration Rules

Treat `refs/NovelTea/` as read-only reference code. Do not edit files under `refs/NovelTea/`. Do not add `refs/NovelTea/` as a CMake subdirectory, production include path, or linked target. Port intentionally selected behavior into the new structure instead.

Do not assume old NovelTea project formats, entity layouts, APIs, or editor workflows are compatibility requirements. They are examples to study, not contracts to preserve. New schema and editor work should be new-engine-first, and old-format import/export should only be implemented when explicitly requested or when a narrow migration tool is intentionally scoped.

The same read-only policy applies to all `refs/` entries (`bgfx/`, `bimg/`, `bx/`, `RmlUi/`). These are upstream snapshots for reference; do not edit them or add them as CMake subdirectories.

Keep the new `nt` tree buildable after each implementation slice. Do not start broad rewrites that require several later fixes before the repository compiles again.

Lua is the only runtime scripting target. Do not implement JavaScript, Duktape, dukglue, embedded JS engines, or JS compatibility shims. Imported legacy script text is either valid Lua or it fails as Lua with diagnostics surfaced to tools/runtime users.

Do not directly translate old SFML drawable classes into bgfx classes. Split old behavior into backend-neutral domain/model/layout/animation code first, then add explicit SDL3/bgfx/RmlUi adapters.

RmlUi is the general runtime UI layer. Complex game widgets such as ActiveText, MapView, TextLog, and similar components should be implemented as C++-backed RmlUi custom elements/components where generic RML/buttons are insufficient.

Do not port the old Qt5 editor unless the user explicitly asks. The old editor is useful for understanding project format and workflows, but the new editor direction is Electron/TanStack/Vite.

Avoid new third-party dependencies unless the task explicitly justifies them. Prefer small adapters and tests over dependency expansion.

Do not paste large logs or file dumps into the parent conversation. Save durable findings under `docs/migration/` or `docs/archive/` when needed and return concise summaries.

## Current Migration Direction

The previous 11-phase backend-neutral core migration is complete for the current repository target. The next plan should focus on runtime state/playback, Lua execution, RmlUi runtime components, ActiveText/map/text-log rendering, editor preview/testing, save/autosave/object placement, packaging/export, and real project fixtures.

## Build and Verification Commands

Use the smallest relevant command set for the touched area, but keep Linux and Web healthy during engine work.

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
cmake --preset web-debug
cmake --build --preset web-debug
```

Run tests when core/runtime behavior changes:

```sh
ctest --test-dir build/linux-debug --output-on-failure
```

Run clang-format for touched C/C++ files before final verification. The project provides CMake targets:

```sh
cmake --build --preset linux-debug --target format-check
cmake --build --preset linux-debug --target format
```

Prefer checking first. Use `format` when the touched files need mechanical cleanup, but do not reformat unrelated files as part of a behavior change unless the user explicitly asks for a formatting-only pass.

Run the Linux sandbox when rendering, input, runtime loop, or UI behavior changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Run the Android build when CMake, SDL3, bgfx, shader, platform, JNI/Gradle, or packaged asset behavior changes and the Android SDK is available:

```sh
cd android
./gradlew :app:assembleDebug
```

If a verification command cannot run in the current environment, state exactly why and record the closest completed check.

## C++ and Architecture Conventions

Use C++20 for new code. Prefer `noveltea` for new framework code. If old code is temporarily ported with the historical `NovelTea` namespace, isolate that compatibility choice and do not let it leak into new platform/renderer APIs without an explicit reason.

Follow the repository `.clang-format` for C/C++ formatting. Formatting is an enforceable project convention; when adding or editing C/C++ files, keep the touched files clang-format clean or clearly report why the formatter could not be run.

Keep backend-neutral core code free of SDL3, bgfx, RmlUi, ImGui, Lua, Electron, Android, Emscripten, SFML, and Qt types.

Keep dev/debug UI separate from runtime UI. Dear ImGui is for tooling and diagnostics, not game UI.

Keep renderer-facing APIs explicit about ownership, lifetime, viewport size, texture handles, shader handles, and platform constraints.

Prefer small, named boundaries:

- `core` or `runtime` for backend-neutral game/project behavior.
- `script_lua` or equivalent Lua-facing layers for runtime scripting.
- `platform_sdl` for SDL3 event/window/native handle ownership.
- `renderer_bgfx` for bgfx resources and draw submission.
- `ui_runtime_rmlui` for RmlUi documents, input translation, custom runtime components, and render backend integration.
- `ui_debug_imgui` for developer-only overlays.
- `text` or `rich_text` for BBCode parsing, style runs, text layout, animation state, and glyph draw data.

## Subagent Policy

This repo intentionally allows `agents.max_depth = 2`. Use it for controlled delegation, not uncontrolled recursion.

Root tasks may spawn planner, explorer, worker, reviewer, and researcher agents. A first-level agent may spawn only narrow read-only explorer/researcher subagents when blocked by a concrete codebase or API question. First-level agents must not spawn implementation workers unless the parent explicitly asked for that chain.

Second-level agents must not spawn more agents. They should answer the narrow question and stop.

Use subagents heavily for read-only exploration, mapping, and review. Use only one writer agent per implementation slice.

When delegating, require each subagent to return:

- files inspected
- key symbols or decisions
- risks found
- recommended next action
- whether it changed files
- verification performed or skipped

Keep subagent outputs concise. Detailed historical reports belong under `docs/archive/`; current planning/status belongs under `docs/migration/`.

## Durable Project Memory

Use these files to avoid relying on chat context:

- `docs/migration/PLAN.md` for the next migration-plan placeholder/index.
- `docs/migration/STATUS.md` for completed foundation, active gaps, current verification, and next planning task.
- `docs/migration/COMPATIBILITY.md` for historical import/export notes only; it is not a requirement to preserve old project formats.
- `docs/ARCHITECTURE.md`, `docs/BUILD_AND_VERIFY.md`, `docs/runtime/`, `docs/ui/`, `docs/rendering/`, and `docs/editor/` for active technical direction.
- `docs/archive/` for historical analysis.

Update `STATUS.md` after non-trivial migration work. Future Codex sessions should be able to resume from repository files without needing the full prior chat.
