# Bootstrap Review

Review scope: changed `nt` files, build wiring, migration docs, and local reference clone status after Stage 1 bootstrap and Stage 2 planning.

## Checks

- No files under root-tracked `NovelTea/` or `refs/` were edited by the bootstrap work. The root repository still treats both directories as untracked local reference clones.
- Nested `refs/RmlUi`, `refs/rmlui-bgfx`, `refs/bgfx`, `refs/bx`, and `refs/bimg` report clean working trees.
- Nested `NovelTea` reports a dirty `android/gradle/wrapper/gradle-wrapper.properties` changing Gradle 5.0 to 8.9. This was not touched by this bootstrap pass and remains a read-only reference-clone concern.
- No `NovelTea/` or `refs/` path was added as a CMake subdirectory, production include path, or linked target.
- No SFML dependency was introduced.
- No Qt editor migration happened.
- RmlUi remains isolated behind `NOVELTEA_ENABLE_RMLUI`; Web/Android keep the current scaffold-only path.
- Dear ImGui remains dev/debug only behind `NOVELTEA_ENABLE_DEVTOOLS`.
- bgfx resources added in this slice have explicit create/destroy paths. Additional RAII wrappers exist for future migration use.
- No large external tree was copied.
- Docs distinguish implemented bootstrap pieces from deferred RmlUi/text/font/asset-loading work.
- Stage 2 planning exists, but no old NovelTea runtime code was ported.

## Verification Reviewed

- Linux configure/build passed.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --frames 180` passed and exited through normal engine shutdown.
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180` passed and exited through normal engine shutdown.
- The previous `pure virtual method called` bgfx shutdown abort was traced to `static App` lifetime at process exit. `apps/sandbox/main.cpp` now uses automatic `App` lifetime and `App::run()` explicitly shuts the engine down before returning.
- Web configure/build passed with SDL3 experimental warnings from Emscripten.
- Android `:app:assembleDebug` passed with an Android Gradle plugin compileSdk warning.

## Risk Assessment

The base smoke path and minimal 2D substrate are stable enough for repeated Linux/Web/Android verification. Old NovelTea migration should still wait: RmlUi remains scaffold-only and the text/font lab does not yet render real font glyphs.

Recommended next action: implement the real RmlUi/bgfx runtime UI backend and minimal document demo, then either finish the text/font lab gate or explicitly re-scope it before creating `noveltea_core`.
