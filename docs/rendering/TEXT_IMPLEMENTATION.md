# Text Implementation

## Status

NovelTea now has an engine-owned Unicode text path that is separate from RmlUi.
RmlUi still uses its own font engine and render geometry.

Implemented:

- Public boxed `Text` primitive with UTF-8 value, font face, pixel size, bounds, color/alpha, horizontal alignment, base direction, language, wrap mode, and transform.
- Backend-neutral `TextLayout` result with source byte ranges, HarfBuzz clusters, visual bidi runs, positioned glyphs, metrics, and overflow reporting.
- FreeType face loading through `AssetManager::read_binary`; no platform-path font opening in the text path.
- Runtime systems should request prepared fonts through `AssetManager::load_font(FontAssetRequest)` rather than duplicating font-default, `sys`, or style-fallback policy. The current typed font loader is backed by `TextEngine`, which remains responsible for FreeType/HarfBuzz operations.
- HarfBuzz shaping for all engine text, including Latin.
- SheenBidi paragraph and line run resolution using UTF-8 byte offsets.
- libunibreak line, word, and grapheme boundary data for wrapping decisions, with a small ZWJ post-process so emoji ZWJ sequences are not split by NovelTea wrapping.
- On-demand FreeType grayscale glyph rasterization by shaped glyph ID at the requested pixel size.
- RGBA8 atlas pages with grayscale coverage in alpha, updated per glyph region.
- bgfx coverage shader that samples alpha coverage and multiplies by vertex/style alpha.
- CPU text tests for UTF-8 clusters, combining marks, emoji ZWJ boundary behavior, kerning, Arabic shaping, mixed bidi runs, explicit newlines, NBSP, CJK break opportunities, wrapping, alignment, overflow, stable metrics, and atlas packing.

## Dependencies

Direct text dependencies:

- FreeType 2.14.3
- HarfBuzz 14.2.1 on vcpkg desktop and Android source builds; Emscripten supplies HarfBuzz 3.2.0 through `-sUSE_HARFBUZZ=1`
- SheenBidi 3.0.0
- libunibreak 7.0

Desktop builds use vcpkg package targets:

- `Freetype::Freetype`
- `harfbuzz::harfbuzz`
- `SheenBidi::SheenBidi`
- `libunibreak::libunibreak`

Web uses Emscripten ports for FreeType/HarfBuzz and pinned source builds for SheenBidi/libunibreak.
Android uses pinned source builds for FreeType/HarfBuzz/SheenBidi/libunibreak in the existing CMake/Gradle flow.

## Pipeline

1. Load font bytes from a NovelTea logical asset path.
2. Create render-thread-owned FreeType and HarfBuzz face/font objects.
3. Analyze UTF-8 paragraph direction with SheenBidi.
4. Collect line, word, and grapheme boundaries with libunibreak.
5. Shape logical directional runs with HarfBuzz.
6. Choose line breaks at valid UTF-8, grapheme, and HarfBuzz cluster boundaries.
7. Re-resolve each final line with SheenBidi and emit visual runs.
8. Align or justify line glyph positions.
9. Rasterize missing glyph IDs on demand with FreeType grayscale rendering.
10. Upload glyph coverage into bgfx atlas pages and submit one draw batch per page.

## Offset Rules

Text source remains UTF-8. Public layout source ranges are byte offsets into the original string.
These are not code point indexes, grapheme indexes, glyph indexes, or visual-order indexes.
HarfBuzz cluster values are preserved as UTF-8 byte offsets.

## Atlas Strategy

The first atlas implementation uses a simple shelf packer with 1024x1024 RGBA8 pages and one-pixel padding.
Glyph cache keys include font handle, glyph ID, and requested pixel size. Hinting mode is owned by the font handle.
Additional pages are created when a page fills. Existing pages are updated by region; atlases are not rebuilt when a glyph is added.

## Threading

The first implementation is render-thread-owned. FreeType faces and HarfBuzz fonts are mutated when setting the requested pixel size, so callers must not use one `TextEngine` concurrently from multiple threads.

## Font Styling

Rich text style metadata for bold, italic, underline, strike, font alias, and font size is preserved through `ActiveTextFrame` and `ActiveTextLayout`. The first renderer-backed ActiveText styling checkpoint uses renderer-side synthetic styling: bold is approximated with an offset glyph pass, italic is approximated with a glyph-quad shear, and underline/strike are approximated with decoration glyphs. This makes direct ActiveText visually distinguish common styles while keeping the API path open for real font-family resolution and FreeType-backed synthetic rasterization.

The longer-term plan is tracked in [`TEXT_FONT_STYLE_PLAN.md`](TEXT_FONT_STYLE_PLAN.md). It separates concrete `FontHandle` values from logical font families, prefers registered real bold/italic faces when available, and falls back to synthetic style when only a regular TTF is provided.

## Deferred

- RmlUi/NovelTea text unification
- ICU or cpp-unicodelib
- SDF, MSDF, MTSDF, and `msdfgen`
- Generic rich text spans and styled-span layout for non-ActiveText text
- Font-family fallback and real per-style font-face resolution
- Color emoji and SVG glyph rendering
- Dictionary hyphenation
- Arabic kashida justification
- Selection, caret, and editor navigation UI
- Lua bindings for the new text API
