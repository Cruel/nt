# ActiveText Font Resolver Implementation Plan

Date: 2026-06-28

## Purpose

This plan defines the next implementation slice for renderer-backed ActiveText: a real font-family resolver with a legacy-compatible `sys` system font family, styled-span shaping, and synthetic style fallback. This should happen before deeper ActiveText shader/material binding or tween/effect visual work because those later features depend on stable glyph geometry, style segmentation, and cache keys.

The goal is not full font fallback for every script yet. The goal is a concrete and testable font selection layer that supports:

- one required base/regular face per family;
- optional bold, italic, and bold-italic faces;
- synthetic fallback when a requested style face is missing;
- a `sys` system font family backed initially by the bundled Liberation Sans regular face;
- ActiveText styled-run shaping without reintroducing RmlUi glyph fallback markup.

## Current Implementation Status

Implemented in the first pass:

- Public font-family data model: `FontFamilyHandle`, `FontFamilyDesc`, `ResolvedFont`, and `TextFont*` style bits.
- `TextEngine` font-family registration, default-family selection, alias resolution, unknown-alias fallback, regular-only synthetic style fallback, and deduped diagnostics.
- `StyledText` / `TextSpan` public API plus a first styled layout path that carries resolved faces and synthetic style bits into `PositionedGlyph`.
- Renderer-facing `PositionedGlyph::synthetic_font_style` and bgfx glyph cache-key separation for synthetic bold/italic variants.
- System font family registration as `sys` in the bgfx text renderer and RuntimeUI ActiveText helper, with `Liberation Sans` and `runtime-ui` retained as transitional aliases.
- ActiveText styled-shaper overload and RuntimeUI direct ActiveText shaping through `StyledText`.
- FreeType-backed synthetic bold via `FT_GlyphSlot_Embolden` and a scoped synthetic italic transform in glyph rasterization.
- Tests for regular-only family fallback, `StyledText` synthetic style propagation, synthetic rasterization, and ActiveText shaped glyph synthetic style propagation.

Remaining follow-up work:

- Add exact multi-face and partial-face tests once additional test font faces are available or fixtures are added.
- Replace remaining renderer-side ActiveText bold/italic quad approximations once FreeType synthetic rasterization is visually validated.

## Current State

Relevant current files:

- `engine/include/noveltea/text/font.hpp`: defines `FontHandle`, `FontDesc`, and hinting mode.
- `engine/include/noveltea/text/text.hpp`: `Text` currently carries one concrete `FontHandle`.
- `engine/include/noveltea/text/text_style.hpp`: `TextStyle` currently has size/color/alpha only.
- `engine/include/noveltea/text/text_layout.hpp`: `PositionedGlyph` carries one concrete `FontHandle` and raster/logical sizes.
- `engine/src/text/text_engine.hpp` and `engine/src/text/text_engine.cpp`: `TextEngine` loads concrete FreeType/HarfBuzz faces, shapes one `Text` at a time, and rasterizes one concrete `FontHandle`.
- `engine/src/active_text_layout.cpp`: the direct ActiveText path currently derives rich-text glyph metadata and, in the shaped path, shapes one glyph at a time against one provided `FontHandle`.
- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`: the bgfx text renderer caches glyph bitmaps by concrete font id, glyph id, and raster pixel size. ActiveText bold/italic/underline/strike are currently renderer-side approximations.
- `engine/src/ui_runtime_rmlui.cpp`: RuntimeUI currently registers the `sys` family from `project:/rmlui/LiberationSans.ttf` with fallback to `system:/fonts/LiberationSans.ttf` for its ActiveText shaping helper.

Important constraints:

- Keep backend-neutral core free of renderer, SDL, bgfx, RmlUi, and Lua types.
- Do not use RmlUi as a fallback glyph renderer for ActiveText.
- Do not require bold/italic font assets for the system font. The bundled system font is currently regular Liberation Sans, and missing styles must synthesize.
- Preserve the existing single-face `Text` API for current tests and non-ActiveText callers while adding richer APIs alongside it.

## Target Model

Add a resolver layer between rich-text style metadata and concrete glyph shaping.

```text
RichTextRun font_alias + font_style + font_size
        ↓
FontFamilyRegistry / TextEngine resolver
        ↓
ResolvedFont { concrete FontHandle, synthetic style bits, family alias }
        ↓
StyledText spans / shaped runs
        ↓
TextLayout / PositionedGlyph with concrete face and synthetic bits
        ↓
bgfx glyph cache and renderer synthetic style/rasterization path
```

A `FontHandle` remains one loaded FreeType/HarfBuzz face. A new logical family is a named set of optional concrete faces. A resolved font is a concrete face plus the synthetic style bits still required after the best available real face is selected.

## Public API Shape

Add these types to the text layer. Exact file placement can vary, but prefer keeping public data types in `engine/include/noveltea/text/font.hpp` or a small new `font_family.hpp` included by `font.hpp`.

```cpp
enum FontStyleBits : uint32_t {
    TextFontRegular = 0,
    TextFontBold = 1u << 0,
    TextFontItalic = 1u << 1,
    TextFontUnderline = 1u << 2,
    TextFontStrike = 1u << 3,
};

struct FontFamilyDesc {
    std::string alias;
    FontDesc regular;
    std::optional<FontDesc> bold;
    std::optional<FontDesc> italic;
    std::optional<FontDesc> bold_italic;
    bool synthetic_styles = true;
};

struct FontFamilyHandle {
    uint32_t id = 0;
    explicit operator bool() const { return id != 0; }
};

struct ResolvedFont {
    FontHandle face{};
    std::string alias;
    uint32_t requested_style = TextFontRegular;
    uint32_t synthetic_style = TextFontRegular;
};
```

Also add a styled-text input that can coexist with existing `Text`:

```cpp
struct TextSpan {
    uint32_t source_byte_begin = 0;
    uint32_t source_byte_end = 0;
    std::string font_alias;
    uint32_t font_style = TextFontRegular;
    float size = 24.0f;
    Color color{1.0f, 1.0f, 1.0f, 1.0f};
    float alpha = 1.0f;
};

struct StyledText {
    std::string value;
    std::vector<TextSpan> spans;
    Rect bounds{};
    TextAlign align = TextAlign::Start;
    TextDirection direction = TextDirection::Auto;
    TextWrap wrap = TextWrap::Word;
    std::string language = "und";
    Transform2D transform{};
};
```

The existing `Text` API should be expressed internally as a single-span `StyledText` where practical, but this refactor should be incremental rather than all-at-once.

## Resolution Rules

1. A registered family must have a usable regular/base face. If the regular face fails to load, reject the registration or return an invalid handle with a structured diagnostic.
2. Empty alias resolves to the project-configured default font alias when available; until that setting is threaded through, it resolves to the runtime default family initialized to `sys`.
3. Unknown alias resolves to the runtime default family and emits one deduped diagnostic per alias.
4. Exact style face wins. Bold+italic uses `bold_italic` when present.
5. Partial real face plus synthetic missing style is valid when synthesis is enabled. Example: bold+italic may resolve to real italic plus synthetic bold if italic exists but bold-italic does not.
6. If synthesis is disabled and the exact face is missing, fall back to the family regular face and emit a deduped diagnostic.
7. Underline and strike are not face-selection bits. They remain decoration bits after shaping.
8. The initial system family alias is `sys`, backed by `project:/rmlui/LiberationSans.ttf` with `system:/fonts/LiberationSans.ttf` as a fallback where the runtime already supports that policy. Because only regular is guaranteed to exist initially, bold/italic/bold-italic resolve to regular plus synthetic style bits. The concrete backing font should be easy to replace later without changing authored project aliases.

## Implementation Slices

### Slice 1: Add font-family data model and resolver storage

Files likely touched:

- `engine/include/noveltea/text/font.hpp`
- optionally `engine/include/noveltea/text/font_family.hpp`
- `engine/src/text/text_engine.hpp`
- `engine/src/text/text_engine.cpp`
- `tests/text/text_engine_tests.cpp` or a new `tests/text/font_family_tests.cpp`

Tasks:

1. Add public family and resolved-font structs.
2. Add internal `FontFamilyResource` storage to `TextEngine::Impl`:
   - alias;
   - regular/bold/italic/bold_italic `FontHandle`s;
   - `synthetic_styles` flag.
3. Add APIs:
   - `FontFamilyHandle register_font_family(const FontFamilyDesc& desc);`
   - `FontFamilyHandle default_font_family() const;`
   - `void set_default_font_family(FontFamilyHandle family);`
   - `ResolvedFont resolve_font(std::string_view alias, uint32_t style) const;`
4. Preserve `load_font(const FontDesc&)` as the low-level concrete-face loader.
5. Add deduped diagnostics for missing alias, failed optional faces, and missing style fallback. Keep diagnostics terse and non-spammy.

Tests:

- Registering a family with regular only succeeds.
- Registering a family with no usable regular fails.
- Empty alias resolves to default.
- Unknown alias resolves to default and is diagnosed once.
- Regular-only family resolves bold, italic, and bold-italic to regular with synthetic bits when synthesis is enabled.
- Multi-face family resolves exact faces without synthetic bits.
- Partial family resolves closest real face plus missing synthetic bits.

Acceptance:

- Existing text tests still pass without requiring callers to use font families.
- No renderer or RmlUi dependency is introduced into the text model.

### Slice 2: Register the system font family centrally

Files likely touched:

- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
- `engine/src/ui_runtime_rmlui.cpp`
- possibly `engine/include/noveltea/renderer.hpp`

Tasks:

1. Replace one-off default font loading in bgfx text renderer with system family registration where possible.
2. Register alias `sys` from the existing project asset path first:
   - `project:/rmlui/LiberationSans.ttf`
3. Preserve the existing system fallback behavior in RuntimeUI:
   - try `project:/rmlui/LiberationSans.ttf`;
   - fallback to `system:/fonts/LiberationSans.ttf`.
4. Treat compatibility aliases `"Liberation Sans"` and `"runtime-ui"` as resolving to `sys`. Empty aliases should resolve to the runtime default family, currently initialized to `sys` until project `fontDefault` is threaded in.
5. Keep the old `m_default_text_font` path working until `Renderer::draw_active_text()` can consume resolved family/span data directly.

Tests:

- System family registration succeeds with the bundled Liberation Sans asset in test asset setup.
- `sys`, empty alias, `runtime-ui`, and `Liberation Sans` resolve to the same system face during the transition.
- Requesting bold/italic against the system family returns regular face plus synthetic bits.

Acceptance:

- Sandbox still renders text with Liberation Sans.
- ActiveText still renders if the family resolver is present but styled-span shaping is not yet complete.

### Slice 3: Carry synthetic style bits through layout and glyph cache keys

Files likely touched:

- `engine/include/noveltea/text/text_layout.hpp`
- `engine/src/text/text_engine.cpp`
- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
- `tests/text/text_engine_tests.cpp`
- renderer tests if practical

Tasks:

1. Extend `PositionedGlyph` with `uint32_t synthetic_style` and possibly `uint32_t decoration_style`.
2. Extend glyph cache key in `BgfxTextRenderer` with synthetic raster style bits that affect glyph bitmaps:
   - bold;
   - italic.
3. Do not include underline/strike in bitmap cache keys if they are rendered as geometry/decorations.
4. Initially map synthetic bits to the existing renderer-side approximations so behavior is preserved.
5. Keep old `ActiveTextGlyphVisual::font_style` available until ActiveText is switched to styled spans.

Tests:

- Glyph cache key distinguishes regular vs synthetic bold/italic/bold-italic.
- `PositionedGlyph` preserves synthetic bits from resolved font metadata.
- Existing layout byte ranges and glyph positions remain stable for regular text.

Acceptance:

- No visual regression for regular text.
- Synthetic-style state exists in renderer-facing glyph data, not only ActiveText metadata.

### Slice 4: Add styled-span shaping API

Files likely touched:

- `engine/include/noveltea/text/text.hpp`
- `engine/include/noveltea/text/text_style.hpp`
- `engine/include/noveltea/text/text_layout.hpp`
- `engine/src/text/text_engine.hpp`
- `engine/src/text/text_engine.cpp`
- `tests/text/text_engine_tests.cpp`

Tasks:

1. Add `TextSpan` and `StyledText` public types.
2. Add `TextLayout layout_text(const StyledText& text) const;` and scale overload.
3. Implement the first version by splitting shaping at span boundaries and bidi line ranges.
4. Preserve source byte ranges in `PositionedGlyph` as offsets into the full `StyledText::value`.
5. For v1, accept run-boundary shaping even though it may lose ligatures across style boundaries. That is better than one-glyph shaping and sufficient for ActiveText styled runs.
6. Reuse existing libunibreak wrapping. Legal break decisions should still operate on the full string, not isolated span text.
7. Preserve existing `Text layout_text(const Text&)` behavior by converting to a single span or by keeping the old path and sharing helpers.

Design note:

The current `TextEngine::Impl::shape()` takes one `Text`, one concrete font, and one byte range. Introduce an internal `ShapeRequest` or overload that takes:

- full UTF-8 string;
- range begin/end;
- concrete `FontHandle`;
- requested size;
- synthetic style bits;
- language/direction.

This avoids constructing temporary one-glyph `Text` objects in ActiveText and keeps source byte ranges valid.

Tests:

- Styled text with two spans produces glyphs with different resolved fonts or synthetic bits.
- Source byte ranges remain in the original full string coordinate space.
- Wrapping works across span boundaries.
- CJK wrapping remains valid.
- Bidi smoke tests still pass for the single-span path.

Acceptance:

- Existing `Text` callers require no behavior change.
- New `StyledText` API can shape rich text runs without per-glyph layout calls.

### Slice 5: Switch ActiveText layout to styled-span shaping

Files likely touched:

- `engine/include/noveltea/active_text_layout.hpp`
- `engine/src/active_text_layout.cpp`
- `engine/src/ui_runtime_rmlui.cpp`
- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
- `tests/ui/active_text_layout_tests.cpp`

Tasks:

1. Extend `ActiveTextLayoutOptions` to carry a default font family alias instead of only a default concrete font alias string.
2. Build one full visible/final `StyledText` from `RichTextDocument` runs:
   - span byte ranges map to `RichTextRun` ranges;
   - span font alias comes from rich text or default;
   - span font style maps from rich-text style bits to text style bits;
   - span size resolves from rich-text size or runtime default;
   - span color/alpha carry through.
3. Shape the full final string for wrapping stability, then reveal by visible glyph count, preserving the existing precomputed wrapping behavior.
4. Replace the current per-glyph shaping helper in `build_active_text_layout(document, options, FontHandle, ActiveTextShaper)` with a styled shaper path.
5. Keep the unshaped fallback layout for tests/environments where the text engine is unavailable.
6. Preserve object span hit rectangles, material ids, direct shader ids, diff flags, offsets, scale, page-break flags, and effect metadata.

Tests:

- `[font id=missing]` falls back to default family while preserving diagnostic behavior.
- `[b]`, `[i]`, `[b][i]` against `sys` produce glyphs with synthetic bits.
- Explicit font size spans affect advances and line height.
- ActiveText precomputes wrapping before reveal with styled spans.
- Object hit testing still works after styled-span shaping.
- Metadata mapping still maps material/direct-shader/object spans to the correct shaped glyphs.

Acceptance:

- Direct ActiveText no longer shapes one glyph at a time for the primary path.
- The RmlUi `nt-active-text` element remains a layout/input host only.
- Visual text spacing should improve relative to the current per-glyph path.

### Slice 6: FreeType-backed synthetic bold/italic rasterization

Files likely touched:

- `engine/src/text/text_engine.cpp`
- `engine/src/text/text_engine.hpp`
- `engine/src/render/bgfx/text/bgfx_text_renderer.cpp`
- tests under `tests/text/`

Tasks:

1. Extend `TextEngine::rasterize_glyph()` to accept synthetic raster bits, or add a new overload:
   - `rasterize_glyph(FontHandle font, uint32_t glyph_id, float raster_pixel_size, uint32_t synthetic_style)`.
2. Synthetic bold: use FreeType emboldening before bitmap extraction where available.
3. Synthetic italic: apply a scoped FreeType oblique transform before glyph load/render.
4. Ensure the transform is reset after each glyph so style does not leak between calls.
5. Adjust bitmap bounds/bearing handling to avoid clipping oblique glyphs.
6. Keep renderer-side bold/italic approximations only as a temporary fallback if FreeType synthesis fails.

Tests:

- Regular and synthetic bold/italic rasterizations produce non-empty bitmaps.
- Cache keys distinguish synthetic variants.
- Synthetic italic does not clip obvious overhangs in a basic glyph smoke test.
- Repeated regular rasterization after italic synthesis is not contaminated by transform state.

Acceptance:

- Synthetic styling moves from visual quad approximation toward correct glyph rasterization.
- The renderer can eventually remove ActiveText-specific bold/italic hacks.

### Slice 7: Cleanup and documentation

Files likely touched:

- `docs/rendering/plans/TEXT_FONT_STYLE_PLAN.md`
- `docs/rendering/TEXT_IMPLEMENTATION.md`
- `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md`
- `docs/migration/STATUS.md`

Tasks:

1. Update the text implementation docs to describe font families, the `sys` system font, project default font configuration, styled spans, and synthetic fallback.
2. Mark completed slices in this plan as they land.
3. Update the migration status once ActiveText uses styled-span shaping.
4. If old `runtime-ui` alias remains only as compatibility glue, document it as transitional.

## Suggested Implementation Order

Use this order to keep each patch reviewable:

1. Data model and resolver, with tests.
2. System font family registration, with tests.
3. Synthetic bits in `PositionedGlyph` and glyph cache key, with tests.
4. Styled-span shaping API, with tests.
5. ActiveText switch to styled-span shaping, with tests and sandbox smoke.
6. FreeType-backed synthetic rasterization, with tests.
7. Documentation/status cleanup.

Do not combine shader/material binding or glow effects into this slice. Those are next after the styled font pipeline is stable.

## Verification Commands

After model/API/test changes:

```sh
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure -R "text|active_text"
```

After renderer-facing changes:

```sh
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo none --runtime-project project:/projects/runtime_phase8.json --no-imgui
```

After touching Web-relevant text/renderer code:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
```

## Exit Criteria

This implementation slice is complete when:

- A `sys` system font family is registered and used by direct ActiveText when no project default is provided.
- Empty and unknown aliases fall back to the runtime default family with deduped diagnostics.
- A regular-only family can satisfy bold/italic/bold-italic requests through synthetic bits.
- Styled-span shaping preserves source byte ranges and wraps before reveal.
- ActiveText uses styled-span shaping for its primary direct-render path.
- Renderer-facing glyph data carries synthetic style bits in a cache-key-safe way.
- Tests cover regular-only, multi-face, partial-face, default fallback, styled-span shaping, and ActiveText metadata mapping.

FreeType-backed synthetic rasterization may land in the same milestone if the previous slices stay small; otherwise it can be the immediately following milestone. The important dependency is that synthetic style bits and cache keys are in place before deeper ActiveText material/effect work starts.
