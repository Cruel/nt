# Historical: Web NovelTea Text Sampling Fix - 2026-06-18

This document is historical archive material from the text-rendering investigation on 2026-06-18. Current text implementation status lives in `docs/rendering/TEXT_IMPLEMENTATION.md`.

---

## Summary

The confirmed primary cause of blocky NovelTea-owned Web text was the bgfx glyph atlas sampler using explicit point filtering:

- `BGFX_SAMPLER_MIN_POINT`
- `BGFX_SAMPLER_MAG_POINT`

The atlas stores ordinary FreeType 8-bit grayscale coverage in RGBA alpha, so it must use linear filtering. RmlUi text was unaffected because it uses its own independent font and texture path.

## Code Changes

- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
  - Removed point min/mag flags from NovelTea text atlas pages; atlas pages now retain only clamp addressing and use bgfx's normal linear filtering.
  - New atlas pages are initialized with transparent zero RGBA memory instead of null initial memory.
  - Glyph uploads now use `make_padded_glyph_upload` to upload the reserved rectangle with a transparent one-texel border around each glyph.
  - Glyph cache keys now use the normalized integral raster size, matching the FreeType pixel size actually used.
  - The demo no longer presents Hebrew tofu boxes as a successful mixed LTR/RTL visual sample.

- `engine/src/text/text_engine.cpp` and `engine/src/text/text_engine.hpp`
  - Added `normalize_raster_pixel_size` and `glyph_cache_pixel_size_key`.
  - Added `unibreak_marker_index_for_boundary` and `is_utf8_boundary`.
  - Fixed line/grapheme boundary conversion: interior UTF-8 boundary offset `n` consults libunibreak marker `n - 1`; offset `0` and `value.size()` are handled separately.
  - Removed the raw byte ZWJ post-process. libunibreak 7 handles the tested extended grapheme ZWJ sequence without it.
  - FreeType rasterization now requires `FT_PIXEL_MODE_GRAY` after `FT_RENDER_MODE_NORMAL`.
  - FreeType bitmap pitch is handled for positive and negative pitch; `pitch == width` is no longer assumed.
  - Added `glyph_index` for font coverage diagnostics/tests.

- `web/shell.html`
  - Added URL argument bridging for repeatable Web visual checks:
    - `?demo=text`
    - `?demo=all`
    - `?frames=N`
    - `?noImgui=1`

## Coordinate and DPR Diagnostics

Browser used for captures:

- HeadlessChrome 149.0.7827.55 via Playwright Chromium.
- Browser zoom for primary captures: 100%.

Primary DPR 1 capture:

- URL: `http://127.0.0.1:8123/index.html?demo=text&noImgui=1`
- `window.devicePixelRatio`: 1
- canvas CSS: 1280 x 720
- canvas backing store: 1280 x 720
- WebGL drawing buffer: 1280 x 720
- SDL/window log: 1280 x 720
- bgfx renderer log: OpenGL ES 2.0, 1280 x 720
- bgfx view rectangle/projection: renderer dimensions 1280 x 720
- requested NovelTea font sizes in demo: 18, 24, 36, 22, 24, 24, 30 logical pixels

DPR 2 diagnostic:

- URL: `http://127.0.0.1:8123/index.html?demo=text&noImgui=1`
- `window.devicePixelRatio`: 2
- canvas CSS: 1280 x 720
- canvas backing store: 1280 x 720
- shell desired dataset size: 2560 x 1440
- WebGL drawing buffer: 1280 x 720

The shell computes DPR-scaled desired dimensions, but the application has no exported Web resize entrypoint, so the actual WebGL backing store stays at the SDL/bgfx logical size. Since the reported issue showed RmlUi text smooth in the same frame while NovelTea text was blocky, and NovelTea explicitly forced point sampling, this change does not alter global canvas scaling. DPR-aware Web backing-store resizing remains a separate limitation to solve deliberately.

Diagnostic non-100% zoom capture:

- Applied CSS `body.style.zoom = 1.25`.
- The canvas CSS/backing/WebGL dimensions became 1600 x 900 while the shell dataset remained 1280 x 720.
- This was used only as a diagnostic, not as a target coordinate-space change.

Current semantics:

- `TextStyle::size` is treated as a logical renderer/UI pixel size.
- Layout metrics, FreeType raster size, glyph geometry, bgfx view rect, and orthographic projection all use the renderer dimensions.
- The renderer currently supports integral raster pixel sizes. Fractional requested sizes normalize to the nearest integral FreeType pixel size and share the same glyph cache entry.

## Visual Evidence

Screenshots and JSON metrics are saved in `docs/migration/reports/screenshots/`.

- Before, default all demo: `web-all-before-dpr1.png`, `web-all-before-dpr1.json`
- After, clean text-only demo: `web-text-after-dpr1.png`, `web-text-after-dpr1.json`
- After, DPR 2 diagnostic: `web-text-after-dpr2.png`, `web-text-after-dpr2.json`
- After, default all demo with RmlUi control: `web-all-after-dpr1.png`, `web-all-after-dpr1.json`
- After, zoom diagnostic: `web-text-after-dpr1-zoom125.png`, `web-text-after-dpr1-zoom125.json`

The after captures include 18 px, 24 px, 36 px, wrapped text, combining marks, transformed text, and an all-demo frame with RmlUi text present as the independent control.

## Font Coverage

The bundled `apps/sandbox/assets/rmlui/LiberationSans.ttf` does not contain the Hebrew code points used by the previous visual sample. `fc-query` reports no Hebrew range, and engine tests assert `FT_Get_Char_Index` returns zero for the sample Hebrew letters. The visual demo now states this limitation instead of drawing tofu boxes as a successful mixed-direction rendering sample. CPU bidi tests remain in place.

## HarfBuzz Web Version

Web still uses Emscripten's HarfBuzz port while desktop and Android use the pinned newer dependency path. This difference was not involved in the blocky glyph edges because the root defect was texture sampling and atlas initialization after shaping/rasterization. Aligning the Web HarfBuzz version may still be useful later for consistency, but it is intentionally not part of this rendering-quality fix.

## Verification

Passed:

- `cmake --preset linux-debug -G Ninja`
- `cmake --build --preset linux-debug`
- `ctest --test-dir build/linux-debug --output-on-failure` - 55/55 passed
- `./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180`
- `cmake --preset web-debug -G Ninja`
- `cmake --build --preset web-debug`
- Web browser screenshots through Playwright Chromium at DPR 1 and DPR 2 diagnostic settings
- `cd android && ./gradlew --no-daemon :app:assembleDebug`

Skipped:

- Android emulator runtime visual verification. `adb devices` reported no attached devices.

## Remaining Limitations

- Web DPR backing-store resizing is not implemented; DPR 2 diagnostics show a logical 1280 x 720 WebGL drawing buffer despite a desired 2560 x 1440 shell dataset.
- No general font fallback exists yet.
- The bundled visual demo font does not cover Hebrew.
- HarfBuzz version alignment for Web remains a separate dependency-consistency task.
