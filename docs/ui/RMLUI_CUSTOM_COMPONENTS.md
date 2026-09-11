# RmlUi Custom Components

## Purpose

Track the custom RmlUi element/component strategy for complex NovelTea runtime widgets.

## Current Components

- `nt-tr`: registered as a C++ RmlUi element and kept live after compilation. Local authoring puts
  source text inside the element; reusable Messages use `key="..."`, and named argument bindings use
  `arg-<name>` attributes. Compilation replaces authored source/key metadata with package-local
  `message` identity while preserving argument bindings. Named Messages declare their stable argument
  names/types; compilation rejects missing or unknown `arg-*` bindings. RuntimeUI re-reads the current
  bound attribute values every time the element is realized, coerces them according to that compiled
  contract, and passes the typed values to `MessageRealizer`. Locale-aware value formatting and
  placeholder substitution remain owned by `MessageRealizer`; changing the bound locale therefore
  re-realizes mounted elements with current bindings without remounting their Layout. Named Messages
  may use recursive plural/select patterns and multiple selectors; `nt-tr` supplies their current bound
  arguments and does not implement a second grammar. The v1 inline presentation subset is text plus
  `span`, `em`, `strong`, `b`, `i`, `u`, `s`, and `br`, with `class`/`style` on those inline tags.
  Nested `nt-tr`, arbitrary interactive/layout subtrees, and inline `nt-case` grammar are rejected;
  complex grammar is defined on the referenced named Message instead. Engine-owned player UI also
  uses this same element with reserved `noveltea.*` named Message keys. Those keys resolve directly
  to engine-owned runtime Message identities and built-in translations when the Project has no
  override; Project source/target overrides lower onto the same identities and therefore use the
  normal Message realization, locale negotiation, freshness, provenance, and review path.
- `nt-active-text`: registered as a C++ RmlUi element. It is a layout/input host rather than a glyph
  markup renderer. It binds typed Room/Dialogue/Scene text state, drives deterministic reveal and
  alpha playback through the coordinator-owned typed presentation lifecycle, and preserves
  `RichTextDocument` state. After RmlUi resolves the element box, RuntimeUI shapes visible text
  through the engine text stack, `ActiveTextLayout` maps shaped glyph ranges back to rich-text
  metadata and object hit rectangles, and the engine bgfx text renderer draws the direct path after
  RmlUi.
- `nt-map-view`: registered as a C++ RmlUi element. It consumes one projected `MapView` selected by
  its `map` attribute (or the sole authored Map when unambiguous), emits semantic Location and
  Connection buttons in authored logical order, and uses normalized Location/Connection polygons
  only for pointer picking. Semantic targets carry strong Map/Room/Location/Connection/Exit IDs and
  actionability, so keyboard/controller/assistive navigation does not depend on geometry.

Text Log is not a custom element. It uses ordinary RmlUi data binding over
`gameplay.text_log.entries`, including sanitized rich `body_rml` for each entry.

## Runtime contract

Custom runtime elements live only in the private RmlUi runtime layer. Ordinary state-driven UI uses
the context-local `noveltea` data model described in `docs/ui/RMLUI_DATA_MODEL_CONTRACT.md`. A C++
custom element is preferred only when ordinary RML/data binding is insufficient for the required
rendering, lifecycle, or input behavior.

RuntimeUI refreshes Map components in the active Game HUD and Text Log system documents and in
mounted gameplay Layout documents. Every matching `nt-map-view` is refreshed; multiple occurrences
may display the same Map simultaneously and remain independent.

Each Map occurrence owns `open`, `mode`, `focus`, `pan-x`, `pan-y`, and `zoom`. These values are local
component/Layout occurrence state, not `SessionState`, desired presentation, or automatic save state.
The element emits `mapstatechange` after user changes. A Layout that wants persistence must declare a
Layout State Shape and explicitly copy the desired value through its mount context's
`commit_state(...)`; save/restore persists only that validated Layout State Slot. Refreshing the same
projected Map does not overwrite an already initialized occurrence's local state.

Pointer selection transforms the pointer into normalized Map coordinates using that occurrence's pan
and zoom, applies polygon hit testing, and resolves overlap by `pickOrder` with deterministic ties.
Connection `hitRegions` use the same pointer-only rule. Pointer hits transfer to/focus the same
semantic button target used by keyboard/controller/assistive activation. Location convenience
navigation exists only when runtime projection publishes exactly one actionable Exit to that Room.

Direct ActiveText rendering remains engine-side. RmlUi owns layout hosting and input event routing;
RuntimeUI snapshots the resolved element bounds after `Rml::Context::Update()`; NovelTea's text stack
owns shaping; and NovelTea's renderer owns glyph submission, material/direct-shader binding, effect
projection, and deduped diagnostics. Missing ActiveText material or direct shader-pair programs fall
back to default text rendering.
