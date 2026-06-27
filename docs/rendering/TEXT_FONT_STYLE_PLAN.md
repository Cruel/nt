# Text Font Style and Synthetic Styling Plan

Last updated: 2026-06-26.

## Goal

NovelTea rich text already parses font style metadata such as bold, italic, underline, strike, font alias, and font size. The renderer-backed ActiveText path must preserve that metadata and render it through the engine text pipeline instead of relying on RmlUi fallback classes.

The API must support both project styles:

- a single TTF where bold/italic are synthesized by the engine; and
- multiple TTF faces where regular, bold, italic, and bold-italic are registered separately, similar to RmlUi-style font registration.

## Desired model

```text
RichText font_alias + font_style
        ↓
Font family resolver
        ↓
real bold/italic face if registered
        ↓
synthetic bold/italic/underline/strike when requested style lacks a real face
        ↓
TextLayout / PositionedGlyph carries resolved font and synthetic flags
        ↓
bgfx text renderer draws styled glyphs and decorations
```

Terminology:

- `FontHandle`: one concrete loaded face from one TTF/face index.
- `FontFamily`: a logical author-facing font alias with style variants.
- `ResolvedFont`: a concrete `FontHandle` plus synthetic style bits needed to satisfy the request.

## API direction

The eventual public-facing registration shape should be equivalent to:

```cpp
register_font_family("body", {
    .regular = "project:/fonts/body.ttf",
    .synthetic_styles = true,
});

register_font_family("body", {
    .regular = "project:/fonts/body.ttf",
    .bold = "project:/fonts/body-bold.ttf",
    .italic = "project:/fonts/body-italic.ttf",
    .bold_italic = "project:/fonts/body-bold-italic.ttf",
    .synthetic_styles = true,
});
```

Resolution rules:

1. Empty font alias resolves to the default runtime font family.
2. Exact real face wins.
3. Partial real face plus synthetic missing style is allowed when synthesis is enabled. For example, bold+italic may resolve to a real italic face plus synthetic bold.
4. If no matching face exists and synthesis is disabled, fall back to regular and emit a deduped diagnostic.
5. Underline and strike are synthetic decorations even when real bold/italic faces exist.

## Implementation phases

### Phase 1: Preserve style metadata through ActiveText layout

- Add font alias, font size, and font style fields to `ActiveTextGlyphVisual`.
- Copy them from `ActiveTextGlyph::style` in `make_visual()`.
- Add tests for `[b]`, `[i]`, `[u]`, `[s]`, `[font]`, and `[size]` preservation in `ActiveTextLayout`.

### Phase 2: Add text-layer font style and resolved synthetic style state

- Extend the generic text model so style flags are not ActiveText-only.
- Add synthetic style bits to `PositionedGlyph` and include them in glyph cache keys.
- Keep the current single-`Text` API working with regular style.

### Phase 3: Add a font family resolver

- Add `FontFamilyDesc`, `FontFamilyHandle`, and `ResolvedFont`.
- Allow a family to be registered with regular, bold, italic, and bold-italic faces.
- Allow synthetic bold/italic fallback per family.
- Register the runtime `runtime-ui` family with the current LiberationSans face and synthetic style enabled.

### Phase 4: Layout styled spans

- Add a generic styled text input, such as `StyledText` with `TextSpan` records.
- Teach the text engine to shape spans using the resolved font face for each span.
- Preserve source byte ranges so ActiveText metadata can continue to map back to glyphs.
- For v1, splitting shaping at rich-text run boundaries is acceptable.

### Phase 5: Synthetic bold and italic rasterization

- Synthetic bold should happen during rasterization, preferably using FreeType emboldening before bitmap extraction.
- Synthetic italic should use a scoped FreeType oblique transform before glyph load/render.
- Raster cache keys must distinguish regular, synthetic bold, synthetic italic, and synthetic bold-italic variants.
- Metrics and bitmap bounds must avoid clipping italic glyphs.

### Phase 6: Underline and strike decorations

- Render underline and strike as geometry, not as mutated glyph bitmaps.
- Add decoration rectangles to `TextLayout` or equivalent renderer data.
- Use font metrics when available, with sane size-based fallback values.
- For v1, decorations may remain baseline-aligned instead of following every per-glyph ActiveText effect offset.

### Phase 7: ActiveText integration

- Replace direct ActiveText shaping of one whole visible string with styled-span shaping.
- Resolve each run from `font_alias`, `font_style`, and `font_size`.
- Preserve existing material/direct-shader metadata diagnostics without using ActiveText glyph fallback RML.

### Phase 8: Verification

Required tests:

- Rich text style metadata round trips through `ActiveTextFrame` and `ActiveTextLayout`.
- Single-TTF font family resolves bold/italic to synthetic styles.
- Multi-TTF font family resolves exact real faces without synthetic style bits.
- Partial family resolution combines real and synthetic style correctly.
- Glyph cache keys distinguish synthetic variants.
- Synthetic bold/italic produce non-empty rasterized glyphs.
- Underline and strike create decoration geometry.
- Direct ActiveText snapshots preserve font styling metadata.

## Current checkpoint scope

The first implementation checkpoint should complete Phase 1 and a minimal text-renderer synthetic style path sufficient for direct ActiveText to visually distinguish bold, italic, underline, and strike while leaving full multi-span/multi-family shaping as the next larger checkpoint.

Known limitations after the first checkpoint may include:

- direct ActiveText still shapes with the default face if no family resolver has been installed;
- synthetic bold/italic may be renderer-side approximations before full FreeType embolden/oblique rasterization;
- underline/strike may be simple per-glyph or per-run geometry rather than font-metric-perfect decorations; and
- exact legacy visual parity remains deferred.
