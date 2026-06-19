# Migration Status

Last updated: 2026-06-19 (Phase 7 text semantics complete).

## Current Core Domain Migration State

The backend-neutral old NovelTea core foundation is implemented and hardened. `noveltea_core` owns stable project/schema identifiers, old-compatible `EntityType` integer values, selected-entity `EntityRef` arrays, contained `nlohmann::json` project-document/import APIs, a normalized `ProjectDocument` default document model, typed legacy entity schema views/parsers, old save/settings/profile document APIs, project/entity graph validation, backend-neutral typed project models/stores, a runtime event bus and timer scheduler, an expanded `GameSession` runtime facade, a Phase 6-complete `RuntimeController` for room/dialogue/cutscene/script sequencing, a Phase 7-complete rich-text semantic layer, the legacy `game` JSON importer, and a read-only legacy ZIP project package reader under `noveltea::core::legacy`.

Durable report:

- `docs/migration/reports/core-domain-first-slice.md`
- `docs/migration/reports/core-domain-import-slice.md`
- `docs/migration/reports/core-domain-package-reader-slice.md`
- `docs/migration/reports/core-engine-migration-plan.md`

This slice deliberately avoids old `Game`, `Context`, `Subsystem`, save/profile behavior, ZIP package writing, Duktape/dukglue, SFML, Qt, renderer/UI classes, and concrete entity runtime migration. Current `nt` already has Lua 5.5 plus sol2/sol3-style bindings; Duktape is read-only reference material and must not be implemented or reintroduced. Old scripting behavior is deferred to a future Lua compatibility/adaptation layer. The temporary custom `JsonValue` type is absent; `nlohmann-json` is contained to `noveltea_core` project-document/import APIs and tests.

Current core decisions:

- `ProjectDocument::new_project()` is a normalized new in-memory model using old-compatible key names and defaults. It uses keyed objects for project fonts and textures.
- `legacy::ProjectImporter` preserves the old `game` JSON wire document as read. It accepts empty array placeholders and object maps for `fonts` and `textures`.
- `legacy::ProjectPackageReader` uses private `miniz` ZIP reading to extract `game`, `image`, `fonts/*`, and `textures/*`, then feeds `game` into `ProjectImporter`. It ignores unrelated entries and exposes no ZIP library types publicly.
- `legacy::parse_entity_record()` and `legacy::parse_project_entities()` expose typed structural views for old `Object`, `Script`, `Action`, `Verb`, `Room`, `Map`, `Dialogue`, `DialogueSegment`, `Cutscene`, and cutscene segment records. The parser validates old array sizes and field types, checks keyed collection id consistency, and reports field paths for malformed nested records. It does not validate graph references or execute scripts.
- `SaveDocument` exposes old `.ntsav` JSON shapes, reset-compatible baseline keys, selected-entity entrypoint access, current map id access, and structural diagnostics for known save fields. It preserves the old boundary by not performing project graph validation or runtime mutation.
- `SettingsDocument` exposes old `settings.conf` keys (`sizeFactor`, `profiles`, `activeProfile`) and profile-name extraction. `profile_paths` preserves old profile directory, slot filename, `settings.conf`, and `lastSave` naming without mutating the filesystem.
- `ProjectValidator` is a post-import structural/reference validator. It reports schema diagnostics plus graph issues for entrypoint refs, starting inventory object ids, action verb/object refs, room object refs and enabled path refs, map room ids and connection indices, dialogue next refs/root/link/child indices, and cutscene next refs. Import remains lossless and separate from validation.
- `ProjectModel` materializes validated `ProjectDocument` data into owned backend-neutral stores for `Object`, `Script`, `Action`, `Verb`, `Room`, `Map`, `Dialogue`, and `Cutscene`, including common entity metadata, parent ids, project properties, nested room/map/dialogue/cutscene values, parent metadata lookup, and parent-first project-property merging. It does not run scripts or apply save overrides.
- `RuntimeEventBus` preserves old-style wildcard/type listener dispatch, immediate trigger, queued dispatch, listener removal, and next-dispatch deferral for events queued by listeners. `RuntimeTimerScheduler` supports one-shot and repeating timers, cancellation, reset, callback execution, safe timer creation from callbacks, and optional `TimerCompleted` event emission. It is independent of scripting, rendering, SDL, and `Engine::tick()` integration.
- `GameSession` is a backend-neutral runtime facade. It loads a validated `ProjectDocument` into `ProjectModel`, owns a `SaveDocument`, runtime events, timers, play time, startup entrypoint resolution, current entity, current room/map ids, navigation/map flags, and an entity queue. It prefers a save entrypoint when present, falls back to the project entrypoint, restores old save metadata where possible, ignores stale saved map/queue entries with warnings, emits UI-neutral session commands plus a queued `GameLoaded` event, advances timers/play time on `tick()`, and deliberately avoids scripting, rendering, concrete mode controllers, and old service-locator behavior.
- `RuntimeController` is a backend-neutral gameplay sequencer that owns queue draining, room-entry/exit transitions, visit-count tracking, navigation-path resolution, action resolution, transient script/custom-script mode, active mode save/restore, and UI-neutral `ControllerCommand` emission. It accepts a `GameSession&`, calls `session.tick()` each frame, processes the startup entrypoint (Room entrypoint enters room mode directly; other types are queued), drains one entity per tick when not in Room mode (Room mode blocks), provides `navigate_path(direction)` to resolve a room path's target entity and exit the current room, and provides `process_action(verb_id, object_ids)` for room actions. Action processing validates object availability against the current room plus starting inventory, matches actions with old position-dependent or order-insensitive object semantics, emits project before/after action scripts, emits parent action scripts before child scripts, and falls back to the verb default script when no action matches. Room enter/leave hook commands follow the old project-before, room-before, project-after, room-after order. Runtime notification and text-log events are forwarded into controller commands. Dialogue and cutscene text commands now include parsed `rich_text` JSON payloads. Entities and hooks requiring script execution still emit `ScriptDeferred` commands. It deliberately avoids concrete script execution, rendering, and UI integration.
- `rich_text` is a backend-neutral text semantics module in `noveltea_core`. It ports old `TextTypes`-compatible enums and BBCode semantics into `RichTextDocument`, `RichTextRun`, style, animation, object-span, and page-break values. Supported tags include object shorthand `[[label|id]]`, `[o=id]`, `[p]`/`[p=seconds]`, bold/italic, color, font, size, border color/size, diff, shader ids/uniform placeholders, x/y offsets, and animation tags with old short parameter aliases. Malformed and unmatched tags recover by preserving literal text or ignoring unmatched closing tags, matching the old parser's durable behavior. The module also provides `strip_rich_text_tags()`, `diff_room_description()` for changed room-description spans, fixed-character pagination, and a text/page-break timeline model independent of SDL3, bgfx, RmlUi, ImGui, and SFML.
- `EntityType::CustomScript` is known but not project-backed. It has no collection key because old runtime resolution treats the selected-entity id string as inline script content.
- `EntityRef` remains only the old `[type, id]` selected-entity shape. It accepts `CustomScript` inline content structurally but does not validate referenced entity existence.

Core engine migration planning:

- `docs/migration/PLAN.md` now expands the old-core migration into staged work from legacy wire schemas through domain models, save/settings/profile import, runtime controllers, Lua-based scripting compatibility, text semantics, RmlUi/bgfx adapters, package asset integration, and editor preview APIs.
- `docs/migration/reports/core-engine-migration-plan.md` records the old `Game`, `Context`, `SaveData`, `Settings`, `ScriptManager`, entity schema, event/timer, text, and package analysis that informed the plan.
- Phase 7 is complete. Runtime-controller coverage now includes queue draining, entrypoint startup, room navigation, room enter/leave hook command order, active room/dialogue/cutscene save-state restore, transient script/custom-script mode, dialogue traversal/options/log commands, cutscene timeline expansion, next-entity transitions, room action resolution, notification/text-log event forwarding, UI-neutral command emission, and parsed rich-text payloads for dialogue/cutscene text commands. The next core-engine slice should start Phase 8 runtime UI adapters: consume `ControllerCommand` output in RmlUi-backed views, beginning with dialogue/cutscene/room text.

Verification:

- `cmake --build --preset linux-debug`: passed after Phase 7 rich-text changes.
- `./build/linux-debug/tests/noveltea_core_tests "Rich text*"`: passed 31 assertions in 4 test cases.
- `./build/linux-debug/tests/noveltea_core_tests`: passed 779 assertions in 101 test cases.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 179/179.
- `cmake --preset web-debug`: passed after Phase 7 rich-text changes.
- `cmake --build --preset web-debug`: passed after Phase 7 rich-text changes with the existing Emscripten SDL3 experimental warning.

## Current DPI-Aware Surface State

The engine now has a shared `SurfaceMetrics` model for logical size, framebuffer size, and device scale. Platform, Engine, Renderer, RuntimeUI/RmlUi, DebugUI/ImGui, Web shell resize, input hit testing, and the engine-owned text renderer use the model.

Implemented in this pass:

- Desktop and Android platform metrics distinguish SDL logical/window size from framebuffer pixels and display scale.
- Web exports `noveltea_preview_resize(...)`; the shell sets the actual canvas backing store to CSS size times DPR before resizing the engine.
- bgfx reset and view rects use framebuffer dimensions; orthographic projections and demo layout use logical dimensions.
- RmlUi context dimensions are logical; the bgfx RmlUi render interface uses framebuffer render targets and converts logical scissors.
- Dear ImGui receives logical `DisplaySize` and framebuffer scale.
- Engine-owned text shapes/rasterizes at physical raster size and converts metrics/quads back to logical units; glyph cache keys include physical raster size.
- Input hit testing and preview normalized coordinates use logical dimensions.

Known DPI limitations:

- Web DPR backing-store resizing is implemented but not yet proven by a real-browser capture in this environment.
- Android assemble passed; emulator visual size checks are pending because no device was attached.
- RmlUi exposes one density-independent pixel ratio, so non-uniform surfaces use `scale_x` for RmlUi density.
- Engine-owned text uses the larger axis scale as its effective raster scale on non-uniform surfaces.

## Current NovelTea Text State

The Web glyph sampling regression in the engine-owned NovelTea text path has been fixed. The confirmed primary cause was explicit point sampling on the bgfx RGBA8 grayscale glyph atlas. NovelTea atlas pages now use linear filtering with clamp addressing, deterministic transparent page initialization, and padded transparent glyph uploads. FreeType grayscale rendering remains in use; SDF/MSDF/MTSDF were not reintroduced. RmlUi's independent text path was not modified.

Text boundary handling was also corrected. NovelTea now converts UTF-8 boundary offsets to libunibreak marker indices with a single helper: interior source boundary offset `n` consults marker `n - 1`; offset `0` and `value.size()` are handled as text edges; continuation bytes are rejected. The previous raw-byte ZWJ post-process was removed after tests confirmed libunibreak 7 handles the covered ZWJ sequence.

Current text verification:

- `cmake --preset linux-debug -G Ninja`: passed.
- `cmake --build --preset linux-debug`: passed.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 55/55.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed.
- `cmake --preset web-debug -G Ninja`: passed.
- `cmake --build --preset web-debug`: passed.
- Web browser capture: passed with Playwright Chromium 149.0.7827.55 at DPR 1 and DPR 2 diagnostic settings; screenshots and metrics are under `docs/migration/reports/screenshots/`.
- `cd android && ./gradlew --no-daemon :app:assembleDebug`: passed.
- Android emulator runtime visual check: skipped because `adb devices` reported no attached devices.

Durable report:

- `docs/migration/reports/web-text-sampling-2026-06-18.md`

Known NovelTea text limitations:

- Web DPR backing-store resizing is implemented in the shell/export path but still needs a local real-browser proof in this pass.
- The bundled Liberation Sans demo font does not contain Hebrew glyphs, so the visual demo no longer claims mixed LTR/RTL Hebrew rendering. CPU bidi tests remain.
- Font fallback, rich text spans, BBCode, text effects, hit testing, selection/caret UI, and Lua bindings remain deferred.
- Web still uses Emscripten's HarfBuzz port while desktop and Android use the pinned newer dependency path; this was not part of the sampling fix.

## Current RmlUi bgfx State

The RmlUi 6.2 bgfx renderer is no longer a basic scaffold. It has implemented paths for compiled geometry, file and generated textures, scissor state, clip masks, offscreen layers, layer composition, saved layer textures, saved mask images, standard filters, and standard gradient shaders. Linux shader verification and the RmlUi readback capture/verify tests pass in the current local worktree.

Current local verification:

- `cmake --preset linux-debug -G Ninja`: passed after the NovelTea text subsystem replacement.
- `cmake --build --preset linux-debug`: passed after the NovelTea text subsystem replacement.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 51/51 after text tests were added.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`: passed with the boxed grayscale text demo.
- `cmake --preset web-debug -G Ninja`: passed with Emscripten FreeType/HarfBuzz ports and source-built SheenBidi/libunibreak.
- `cmake --build --preset web-debug`: passed.
- `cd android && ./gradlew --no-daemon :app:assembleDebug`: passed.
- `cmake --build --preset linux-debug`: passed after Android ImGui DPI input normalization.
- `cmake --build --preset web-debug`: passed after Android ImGui DPI input normalization; only the existing Emscripten SDL3 experimental warning remains.
- `cd android && ./gradlew :app:assembleDebug`: passed after Android ImGui DPI input normalization; Gradle still warns that Android Gradle Plugin 8.2.0 was tested up to compileSdk 34 while the project uses compileSdk 35.
- `cmake --preset linux-debug`: passed before edits.
- `cmake --preset linux-debug -DNOVELTEA_COMPILE_SHADERS=ON`: passed after shader edits.
- `cmake --preset linux-debug -DNOVELTEA_COMPILE_SHADERS=ON '-DNOVELTEA_SHADER_VARIANTS=glsl-120;essl-100;essl-300'`: passed after shader-root/list fixes.
- `cmake --build --preset linux-debug`: passed before and after edits.
- `ctest --test-dir build/linux-debug -R noveltea_shader_verify --output-on-failure`: passed.
- `ctest --test-dir build/linux-debug -R 'rmlui|RmlUi' --output-on-failure`: passed 18/18.
- `ctest --test-dir build/linux-debug -R 'rmlui|RmlUi' --output-on-failure`: passed 19/19 after stencil overflow planning coverage was added.
- `ctest --test-dir build/linux-debug --output-on-failure`: passed 43/43 after the stencil overflow fix.
- Latest checked GitHub Actions Build run: `27728367992`, SHA `dfe4557f45990a31ff6360b9fa2a9f5855d956bd`, conclusion `success`.

Changes made in this pass:

- Clip-mask commands now capture whether a transform was active and the full transform matrix, and pushed-layer replay uses the captured transform instead of the renderer's current transform.
- Stencil overflow no longer clears/discards the accumulated mask. The renderer normalizes the active mask to reference 1 with stencil-only decrement passes, applies the new intersection at reference 2, and preserves the complete clip-command history for pushed-layer replay.
- `ReleaseFilter` now detects `FilterKind::MaskImage`, releases and erases the owned saved texture exactly once, clears the resource handle, and then erases the filter.
- Fixed the bgfx color-matrix shader to apply row-major filter matrices in the same direction as the CPU parity helper.
- Fixed generated shader asset root and semicolon-list passing so all requested shader variants compile and verify as separate `shaders/bgfx/<variant>` directories.
- Expanded the readback gallery and verifier to assert transformed clipping, individual standard color filters, and repeating gradient output.
- `docs/migration/RMLUI_GL3_COMPLETION.md` was rewritten to separate verified behavior from implemented-but-unverified behavior.

Known RmlUi gaps that remain open:

- Stencil overflow normalization has deterministic unit coverage but still needs the requested visual equivalence readback against a non-overflow mask.
- Large-radius blur still uses the fixed four-weight/seven-tap shader path. GL3-style downsample, reduced-resolution blur, and upsample are not implemented.
- Capability-aware 2x MSAA layer targets and resolve scheduling are not implemented; current runtime coverage is single-sample.
- Hardware blit and shader-copy fallback both exist, but tests do not force the fallback path.
- RuntimeUI facade integration coverage is incomplete beyond event-consumption polarity and file-interface tests.
- Web headless-browser runtime smoke is not implemented.
- Android packaged shader checks exist in CI, but local Android assemble and emulator runtime smoke were not run in this pass.

## Non-RmlUi Migration Context

The repository remains the new NovelTea runtime/framework targeting SDL3, bgfx, RmlUi for runtime UI, and Dear ImGui for developer/debug UI only.

## Current CI/Release Packaging State

Normal CI and tagged releases are now split:

- `.github/workflows/build.yml` remains push/PR/manual validation only, with read-only contents permission and no GitHub Release publishing.
- Normal CI keeps the shared shader-assets fanout, Linux Debug tests plus headless sandbox smoke, Android Debug packaging smoke, editor lint/typecheck/tests, and a single Web `web-release` build that the editor packaging job reuses for the packaged preview path.
- `.github/workflows/release.yml` handles only `v*` tag pushes. Build jobs use `contents: read`; only the final publish job uses `contents: write`.
- Release jobs consume the shared shader asset artifact, build release outputs for native desktop sandbox, Web, Android, and the Electron editor, stage files under `dist/`, generate `SHA256SUMS`, and publish with `gh release create`.
- The native sandbox release job is `desktop-sandbox`, with native GitHub-hosted runner matrix entries for `linux-x64`, `windows-x64`, and `macos-arm64`.
- The Electron release job is `desktop-editor`, with native GitHub-hosted runner matrix entries for `linux-x64`, `windows-x64`, and `macos-arm64`. Each editor matrix job downloads the Web release preview and verifies `index.html`, `index.js`, `index.wasm`, and `index.data` before `pnpm make`.
- Android Gradle now has a release build type, CI-supplied `versionName`/`versionCode`, and optional secret-backed release signing. Missing signing secrets produce a clearly named unsigned internal APK.
- `cmake/PackageNovelTeaRelease.cmake` is the cross-platform packaging implementation. `.github/package-release.sh` is now a small compatibility wrapper around that CMake script.
- Desktop sandbox release packages are OpenGL shader-variant builds. Windows and macOS releases intentionally continue to use the existing OpenGL path; Direct3D and Metal shader variants are not packaged yet.

Tagged release artifact names for tag `v0.1.0-test`:

- `noveltea-sandbox-v0.1.0-test-linux-x64-release.tar.gz`
- `noveltea-sandbox-v0.1.0-test-windows-x64-release.zip`
- `noveltea-sandbox-v0.1.0-test-macos-arm64-release.zip`
- `noveltea-sandbox-v0.1.0-test-web-wasm32-release.tar.gz`
- `noveltea-sandbox-v0.1.0-test-android-universal-release-unsigned-internal.apk`, or `noveltea-sandbox-v0.1.0-test-android-universal-release-signed.apk` when Android signing secrets are present.
- `noveltea-editor-v0.1.0-test-linux-x64-release.deb`
- `noveltea-editor-v0.1.0-test-linux-x64-release.rpm`
- `noveltea-editor-v0.1.0-test-windows-x64-release.setup.exe`
- `noveltea-editor-v0.1.0-test-windows-x64-release.nupkg`
- `noveltea-editor-v0.1.0-test-windows-x64-release.RELEASES`
- `noveltea-editor-v0.1.0-test-macos-arm64-release.zip`
- `SHA256SUMS`

Dry-run tag command:

```sh
git tag v0.1.0-test && git push origin v0.1.0-test
```

Current CI/release verification:

- `bash -n .github/package-release.sh`: passed.
- `cmake -DNOVELTEA_PACKAGE_KIND=checksums -DNOVELTEA_RELEASE_TAG=v0.1.0-test -P cmake/PackageNovelTeaRelease.cmake`: passed.
- YAML parse for `.github/workflows/build.yml` and `.github/workflows/release.yml` via Python/PyYAML: passed.
- `cd android && ./gradlew --no-daemon :app:tasks --all`: passed and showed release/debug variants.
- Full release builds were not run locally in this pass. The existing local `build/linux-release` directory uses the Unix Makefiles generator, while the new CI release path configures fresh Ninja builds; the local tree was left untouched.

Implemented foundation outside the advanced RmlUi renderer:

- Backend-neutral asset layer with logical `system:/`, `project:/`, and `cache:/` mounts.
- Runtime-loaded bgfx shader assets with CMake shader compilation and verification.
- SDL3 platform/input/windowing integration.
- bgfx renderer organization with shader loader, 2D quad path, engine-owned Unicode text path, and runtime asset staging.
- Engine-owned text subsystem with boxed `Text`, backend-neutral HarfBuzz/SheenBidi/libunibreak layout, FreeType grayscale glyph rasterization, bgfx atlas/page rendering, and CPU text tests. See `docs/migration/NOVELTEA_TEXT_IMPLEMENTATION.md`.
- Lua 5.5.0 plus sol2 scripting runtime with hardened public API, exception conversion, traceback reporting, unsafe library removal, AssetManager-backed script execution, and RmlUi Lua plugin integration.
- Engine lifecycle rollback and shutdown ordering for Platform, Renderer, ScriptRuntime, RuntimeUI, and DebugUI.
- Electron editor preview scaffold and Web preview packaging hooks.
- Android Dear ImGui debug input now converts physical SDL mouse/touch-mouse coordinates into the engine's logical surface space before passing them to the ImGui SDL3 backend, matching the high-DPI-scaled ImGui draw space.

Deferred migration areas:

- Old NovelTea game-domain migration into backend-neutral models and controllers.
- BBCode/TextTypes/ActiveText migration, rich text spans, per-glyph animation, pagination, hit-testing, and render-target text caching.
- Font-family fallback, color emoji, SVG glyphs, script-specific justification, selection/caret UI, and Lua bindings for the new text API.
- RmlUi Debugger integration.
- Android emulator runtime automation and Web browser smoke automation.

## Pre-Release-Tag Final Fixes (2026-06-18)

The following changes were made before pushing the first test tag, without altering the overall release architecture:

1. **Windows MSVC developer environment**: Added `ilammy/msvc-dev-cmd@v1` (arch x64) step before the Windows desktop sandbox build in `.github/workflows/release.yml`, conditional on `runner.os == 'Windows'`. Keeps Ninja as the generator.

2. **Editor artifact collision prevention**: Updated `cmake/PackageNovelTeaRelease.cmake` to embed the original artifact basename stem in the staged filename. Multiple `.nupkg`, `.zip`, `.exe`, `.deb`, or `.rpm` files no longer overwrite each other. `RELEASES` is special-cased with a clean `RELEASES` suffix.

3. **Explicit Forge artifact discovery**: Updated `GLOB_RECURSE` patterns in `cmake/PackageNovelTeaRelease.cmake` to use `/*/RELEASES` and `/*/*/RELEASES` for nested Squirrel.Windows output directories, keeping extension-based patterns for `.deb`/`.rpm`/`.zip`/`.exe`/`.nupkg`.

4. **Removed shader-tools from release presets**: Stripped `VCPKG_MANIFEST_FEATURES: shader-tools` from `linux-release`, `windows-release`, and `macos-release` in `CMakePresets.json`. The `shader-assets` CI job installs shader tools explicitly; desktop release builds consume prebuilt shaders via `NOVELTEA_COMPILE_SHADERS=OFF`. `linux-debug` retains `shader-tools;tests` for local development.

5. **CI editor light packaging**: Changed normal CI (`build.yml`) from `pnpm make` to the lighter `pnpm package` smoke. Full `pnpm make` (Electron Forge distributables) remains only in `release.yml`.

6. **Verification expectations**: YAML parse validation via Python/PyYAML passed. `cmake -P cmake/PackageNovelTeaRelease.cmake` with `-DNOVELTEA_PACKAGE_KIND=checksums` passed. Full release builds were not run locally; CI on a test tag is the definitive verification.

## Current Phase 5 Script Compatibility State

Phase 5 (Scripting Compatibility Layer) is now largely complete. `bind_game_session` exposes old NovelTea JS globals as Lua bindings via `noveltea::script::bind_game_session`:

- **Game** table: `room`, `map_id`, `navigation`, `minimap`, `save_enabled` (read-only properties via `__index`); `prop`, `set_prop`, `push_next`, `load_room`, `exists_room`, `load_script`, `exists_script`, `save`, `load`, `autosave`, `quit`, `save_entity`, `inventory` (callable with `.method()` syntax).
- **Script** table: `rand`, `seed`, `eval_expressions`, `run`, `get_text_input`.
- **Log** table: `push` (emits `TextLogged` runtime event).
- **Timer** table: `start`, `start_repeat` (schedules `RuntimeTimerScheduler` callbacks from Lua).
- **Save** table: `reset_room_descriptions` (stub).
- **Room** usertype: `id`, `prop`, `has_prop`, `set_prop`, `unset_prop`, `description`, `visit_count`, `name`, `script_before_enter`, `script_after_enter`, `script_before_leave`, `script_after_leave`.
- **ScriptEntity** usertype: `id`, `prop`, `has_prop`, `set_prop`, `unset_prop`, `autorun`, `content`.
- Legacy globals: `thisEntity`, `prop`, `set_prop`, `toast`, `alert`.
- Seeded RNG (MT19937-64 stored in `ScriptBridge` in Lua registry).
- Expression evaluation via `sol::state_view::load("return " + expr)` with `\{\{([\s\S]*?)\}\}` pattern.

Key design decisions:
- Global tables use `set_function` closures (not `new_usertype`) to support `.method()` syntax without requiring `:` colon syntax.
- Entity types (Room, ScriptEntity) use `new_usertype` usertypes since they are returned as userdata and used with `:` syntax.
- `Game.prop` reads save properties first, falls back to project default properties via `ProjectModel::document_root()`.
- `ScriptBridge*` is stored in Lua registry as lightuserdata; the heap-allocated bridge is intentionally not freed (lifetime matches Lua state).
- Entity types are registered once (`__noveltea_types_registered` flag); global tables are rebuilt on each `bind_game_session` call.

Architecture changes:
- `ProjectModel` now stores the original project document root (`m_document_root`) for fallback property reads, exposed via `document_root()`.

Current verification:
- 30 test cases in `noveltea_script_tests` with 238 assertions covering all bindings, property access, method calls, `:` syntax on entity types, `.` syntax on globals, `{{ }}` expression evaluation, timer creation, event dispatch, `thisEntity`/`prop`/`set_prop` forwarding, and clear/rebind lifecycle.
- `cmake --preset linux-debug` passes.
- `cmake --build --preset linux-debug` passes.
- All test suites pass (core 684/86, script 238/30, text 176/13, asset 76/12).

## Next Recommended Prompt

Phase 5 script compatibility bindings are complete. The next step should wire `ScriptRuntime` into the `RuntimeController` to replace `ScriptDeferred` stubs with actual script evaluation for Action, Script, CustomScript, room lifecycle scripts, and description evaluation. Alternatively, add a mode controller for cutscene and dialogue sequencing.

Independent RmlUi renderer work remains open: stencil overflow normalization, GL3-quality blur downsample/upsample, portable MSAA/resolve planning, forced shader-copy tests, expanded readback pixel assertions, RuntimeUI facade tests, Web browser smoke, and Android runtime smoke.
