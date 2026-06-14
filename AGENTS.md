# AGENTS.md

## Project purpose

This repository is the new NovelTea runtime/framework. The current target stack is SDL3 for platform/input/windowing, bgfx for rendering across Linux, Web, and Android, RmlUi for runtime UI where appropriate, and Dear ImGui for developer/debug UI only.

The immediate long-running project is migration from the old `Cruel/NovelTea` engine into this new `Cruel/nt` framework without losing the current portable SDL3/bgfx baseline.

## Repository layout

- `engine/` contains the new portable runtime framework.
- `apps/sandbox/` is the current smoke-test application and should remain a fast verification target.
- `android/` contains the Android Gradle project that builds the native CMake project.
- `cmake/` contains toolchains and build helpers.
- `editor/`, when present, is for the future Electron/TanStack/Vite editor, not for the old Qt editor.
- `docs/migration/` is the durable memory for migration plans, reports, status notes, and command summaries.
- `NovelTea/`, when present, is a local read-only clone of the old engine used only as migration reference material.

## Non-negotiable migration rules

Treat `NovelTea/` as read-only reference code. Do not edit files under `NovelTea/`. Do not add `NovelTea/` as a CMake subdirectory, production include path, or linked target. Port intentionally selected code into the new structure instead.

Keep the new `nt` tree buildable after each implementation slice. Do not start broad rewrites that require several later fixes before the repository compiles again.

Do not directly translate old SFML drawable classes into bgfx classes. Split old behavior into backend-neutral domain/model/layout/animation code first, then add explicit SDL3/bgfx/RmlUi adapters.

Do not port the old Qt5 editor unless the user explicitly asks. The old editor is useful for understanding project format and workflows, but the new editor direction is Electron/TanStack/Vite.

Avoid new third-party dependencies unless the task explicitly justifies them. Prefer small compatibility layers, adapters, and tests over dependency expansion.

Do not paste large logs or file dumps into the parent conversation. Save durable findings under `docs/migration/` and return concise summaries.

## Intended migration order

1. Inventory and plan: map old `NovelTea` systems to new `nt` subsystems and record the plan in `docs/migration/PLAN.md`.
2. Backend-neutral core: project data, save/settings data, entity/object/action/verb/map/room/dialogue/cutscene models, JSON/file utilities, and tests or smoke checks.
3. Scripting runtime: preserve Duktape/dukglue behavior initially unless the task explicitly requests a JS engine migration.
4. Runtime integration: add a `Context`/runtime facade that can be driven by the new `Engine::tick()` loop without pulling in SFML.
5. RmlUi proof: render a minimal RmlUi document through the bgfx/SDL3 stack before moving game UI to it.
6. Text lab: port BBCode/style/effect semantics into backend-neutral text parsing/layout/animation code.
7. Text rendering: implement a bgfx-backed rich text renderer or an RmlUi custom element path after layout semantics are proven.
8. Game states/UI: migrate cutscene, dialogue, map, text log, navigation, inventory, and settings flows as controllers plus renderer/UI adapters.
9. Editor integration: expose runtime preview/project APIs for the future Electron editor.

## Build and verification commands

Use the smallest relevant command set for the touched area, but keep Linux and Web healthy during engine work.

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
cmake --preset web-debug
cmake --build --preset web-debug
```

Run the Linux sandbox when rendering, input, or runtime loop behavior changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Run the Android build when CMake, SDL3, bgfx, shader, platform, or JNI/Gradle behavior changes and the Android SDK is available:

```sh
cd android
./gradlew :app:assembleDebug
```

If a verification command cannot run in the current environment, state exactly why and record the closest completed check.

## C++ and architecture conventions

Use C++20 for new code. Prefer `noveltea` for new framework code. If old code is temporarily ported with the historical `NovelTea` namespace, isolate that compatibility choice and do not let it leak into new platform/renderer APIs without an explicit reason.

Keep backend-neutral code free of SDL3, bgfx, RmlUi, ImGui, Android, Emscripten, and SFML includes.

Keep dev/debug UI separate from runtime UI. Dear ImGui is for tooling and diagnostics, not game UI.

Keep renderer-facing APIs explicit about ownership, lifetime, viewport size, texture handles, shader handles, and platform constraints.

Prefer small, named seams:

- `core` or `runtime` for backend-neutral game/project behavior.
- `platform_sdl` for SDL3 event/window/native handle ownership.
- `renderer_bgfx` for bgfx resources and draw submission.
- `ui_runtime_rmlui` for RmlUi documents, input translation, and render backend integration.
- `ui_debug_imgui` for developer-only overlays.
- `text` or `rich_text` for BBCode parsing, style runs, text layout, animation state, and glyph draw data.

## Subagent policy

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

Keep subagent outputs concise. Detailed reports belong in `docs/migration/reports/` when a task needs durable notes.

## Durable migration memory

Use these files to avoid relying on chat context:

- `docs/migration/PLAN.md` for the current staged migration plan.
- `docs/migration/STATUS.md` for completed phases, open risks, and next recommended prompt.
- `docs/migration/reports/*.md` for focused exploration/review notes.
- `docs/migration/logs/` for summarized command output or links to local logs, not huge pasted transcripts.

Update `STATUS.md` after non-trivial migration work. Future Codex sessions should be able to resume from repository files without needing the full prior chat.
