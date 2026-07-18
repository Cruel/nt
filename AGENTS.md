# AGENTS.md

## Project Purpose

This repository is the new NovelTea runtime/framework and editor. The target stack is SDL3 for platform/input/windowing, bgfx for rendering across Linux, Web, and Android, RmlUi for runtime UI, Dear ImGui for developer/debug UI only, and Lua for runtime scripting.

This is a new engine/editor, not a compatibility fork of the old `Cruel/NovelTea` engine. The old engine is a reference for selected behavior and workflows only; new runtime, editor, and project-format decisions should choose the best new-engine design rather than preserve old formats or APIs.

## Documentation Routing

Use `docs/OVERVIEW.md` as the top-level documentation map. `AGENTS.md` should stay focused on root repository rules and route agents to top-level documentation entrypoints; detailed subsystem references belong in the area overview files.

Read the relevant area overview before changing code in that area:

- Build, CMake, CI, toolchains, shaders, platform build wiring: `docs/build/OVERVIEW.md`
- Engine/runtime architecture and C++ framework direction: `docs/architecture/OVERVIEW.md`
- Authoring project/entity schemas and component behavior: `docs/engine/OVERVIEW.md`
- Electron editor work: `docs/editor/OVERVIEW.md`
- Runtime state, Lua, playback, preview/debugger/recorder, package export: `docs/runtime/OVERVIEW.md`
- Rendering, text, shaders/materials, bgfx, render perf: `docs/rendering/OVERVIEW.md`
- RmlUi runtime UI and custom UI components: `docs/ui/OVERVIEW.md`
- Asset loading/import/export and typed asset manager work: `docs/assets/OVERVIEW.md`
- Migration planning/status and legacy-reference decisions: `docs/migration/OVERVIEW.md`
- Historical reports only: `docs/archive/OVERVIEW.md`

When a task materially changes behavior, update the narrowest relevant document or explicitly report why no documentation change was needed.

## Repository Layout

- `engine/` contains the portable runtime framework.
- `apps/sandbox/` is the current smoke-test application and should remain a fast verification target.
- `android/` contains the Android Gradle project that builds the native CMake project.
- `cmake/` contains toolchains and build helpers.
- `editor/` is the Electron/TanStack/Vite editor direction, not the old Qt editor.
- `docs/` contains current architecture, build, runtime, UI, rendering, editor, migration, and archive notes.
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

Any new shipped C++ runtime dependency must pass the admission gate in
`docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md` before it is added to the production graph. The
change must document its transitive C++ objects, exact no-exceptions configuration, exact
no-compiler-RTTI or custom-RTTI configuration, recoverable failure mechanism, supported platforms,
representative failure-path tests, and binary-size impact. “It builds with `-fno-exceptions`” is not
sufficient evidence. Build-host tools may be exempt only when they are kept on the host graph and are
not linked, copied, or packaged into players.

Do not paste large logs or file dumps into the parent conversation. Save durable findings under the relevant docs area when needed and return concise summaries.

## Current Migration Direction

The previous backend-neutral core migration is complete for the current repository target. Current work should focus on runtime state/playback, Lua execution, RmlUi runtime components, ActiveText/map/text-log rendering, editor preview/testing, save/autosave/object placement, packaging/export, real project fixtures, and documentation that lets agents navigate these systems without chat history.

## Editor Policy

When working under `editor/`, read `docs/editor/OVERVIEW.md` first. That overview routes to the editor agent guide, tech stack/component standards, workbench/tab/preview docs, localization docs, ComfyUI workflow docs, project explorer/settings docs, and export/packaging docs.

Keep stable editor behavior documented in the editor docs hierarchy. Do not reintroduce detailed editor policy into `AGENTS.md` unless it is truly repository-wide.

## Build and Verification Commands

Use the smallest relevant command set for the touched area, but keep Linux and Web healthy during engine work. `docs/build/BUILD_AND_VERIFY.md` and `docs/build/OVERVIEW.md` are the source of truth for build and verification details.

Common engine verification:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy
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

When changing code under `editor/`, verify the editor package directly before finishing the task:

```sh
cd editor
pnpm lint
pnpm typecheck
pnpm test
```

Run the editor application or the narrowest relevant UI smoke check when the change affects editor rendering, interaction, routing, or preview behavior. If a verification command cannot run in the current environment, state exactly why and record the closest completed check.

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
- `ui/rmlui/runtime_ui` for the private RuntimeUI facade, with focused RmlUi document, input, component, and render-backend owners beside it.
- `ui_debug_imgui` for developer-only overlays.
- `text` or `rich_text` for BBCode parsing, style runs, text layout, animation state, and glyph draw data.

## Subagent Policy

This repo intentionally uses `agents.max_depth = 1`. Only the root task may delegate; subagents must not spawn other agents. This avoids recursive fan-out, duplicated exploration, and unnecessary token use.

Subagents are optional specialists, not a default workflow. Use one only when independent parallel work, a bounded specialist task, or an isolated review is likely to save more effort than the extra context and coordination cost. Most small or already-understood tasks should remain single-agent.

The root agent owns planning, architecture, integration, and final judgment because it has the complete user conversation and project decisions. Do not delegate those merely to create a role boundary.

Available project agents:

- `nt_scout`: GPT-5.6 Terra/low for one bounded read-only code-mapping or version-specific research question.
- `nt_worker`: GPT-5.6 Terra/medium for one well-specified implementation slice after ownership and acceptance criteria are clear.
- `nt_verifier`: GPT-5.6 Luna/medium for scoped builds, tests, acceptance checks, and failure triage without tracked-file edits.
- `nt_reviewer`: GPT-5.6 Terra/high for independent semantic review at a meaningful integration boundary.

Treat `agents.max_threads = 5` as a safety ceiling, not a target. Most tasks should use zero or one subagent; use two only when the work is genuinely independent. Use only one writer for an implementation slice. Do not run verification against files another agent is actively editing. Keep final integration and critical high-risk review in the root task, using Sol when its additional depth is justified.

When delegating, require each subagent to return:

- files inspected
- key symbols or decisions
- risks found
- recommended next action
- whether it changed files
- verification performed or skipped

Keep subagent outputs concise. Detailed historical reports belong under `docs/archive/`; current planning/status belongs under the relevant active docs area.

## Durable Project Memory

Future sessions should be able to resume from repository files without needing prior chat history.

Use `docs/OVERVIEW.md` for the current documentation hierarchy. Use `docs/migration/OVERVIEW.md` and `docs/migration/STATUS.md` for migration resumption. Use the relevant area overview for active implementation details.
