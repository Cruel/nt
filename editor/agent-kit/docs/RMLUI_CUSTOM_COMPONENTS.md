# NovelTea RmlUi Custom Components

Use this reference only when a Layout needs a documented NovelTea `nt-*` element. Ordinary RML plus the `noveltea` data model is the default authoring path. Do not invent custom tags from engine concepts or from class names seen in generated markup.

The current public custom-element surface is exactly:

```text
nt-active-text
nt-map-view   (provisional)
```

There is no current `nt-text-log` element. Text Log is ordinary data-bound RML over `gameplay.text_log.entries`; use `.noveltea/agent/docs/RMLUI_DATA_BINDING.md` for that model.

## `nt-active-text`

`nt-active-text` is the mature ActiveText host used for NovelTea's presented Room/Dialogue/Scene text. It is a layout/input host, not an RML rich-text renderer.

Typical Game HUD usage is intentionally simple:

```xml
<nt-active-text class="dialogue-body"></nt-active-text>
```

Author-visible contract:

- NovelTea updates only the first `nt-active-text` in the active `game-hud` system Layout document. Putting the tag in an arbitrary Layout does not opt that Layout into ActiveText delivery, and additional tags are not independent ActiveText instances.
- The element's RmlUi content box supplies the bounds used for ActiveText layout and hit testing. Give the host explicit/useful layout dimensions through normal RML/RCSS.
- The host's computed text `color` and effective language are consumed by ActiveText. NovelTea's own ActiveText rich-text/font pipeline controls shaping and presentation; do not assume browser/RmlUi `font-family`, `font-size`, or authored child spans become the ActiveText glyph source.
- The runtime owns the element's inner content. It clears authored inner RML when applying ActiveText state, so do not put persistent children, bindings, buttons, or author-owned rich markup inside `nt-active-text`.
- Pointer activation inside the host participates in NovelTea ActiveText behavior such as reveal/page/interactive rich-text handling. Do not layer an alternate child click contract inside the element.
- Treat runtime-added attributes or any renderer-side glyph structures as implementation details unless a later NovelTea authoring document explicitly promotes them to contract.

Style the host itself for placement, sizing, color, surrounding panel behavior, and other ordinary RmlUi layout concerns. Keep the text content/state source in NovelTea gameplay data rather than trying to populate the element from `data-rml` or Layout Lua.

## `nt-map-view` is provisional

`nt-map-view` exists as a temporary specialized Map presentation path. It is intentionally not a stable general-purpose Map component API yet.

```xml
<nt-map-view></nt-map-view>
```

Current author-visible limits:

- NovelTea updates only the first `nt-map-view` in the active `game-hud` and active `text-log` system documents while gameplay state exists. Arbitrary mounted Layouts do not automatically receive Map state by adding the tag.
- There are no documented authored configuration attributes or child slots. Do not invent them.
- The runtime currently replaces the element's inner RML with generated Map markup. The generated child tags, classes, `data-*` attributes, ordering, and event strings are provisional implementation output, not a stable styling or scripting contract.
- Do not write selectors, Layout Lua, tests, or gameplay logic that depends on the generated inner structure. Style/position the outer `nt-map-view` host only unless a future contract explicitly documents more.
- Current connection activation uses the existing NovelTea Map/Lua path rather than a `noveltea` data-model callback. Do not infer a new `ui_*` callback or duplicate the generated activation scheme.
- Because the component is provisional, prefer ordinary data-bound RML for UI that can be expressed from documented model fields. Use `nt-map-view` only when the requested Layout specifically needs the current Map presentation behavior.

## Text Log is not a custom component

Do not write `<nt-text-log>`.

Text Log uses the normal `noveltea` model:

```xml
<section data-model="noveltea">
  <article data-for="entry : gameplay.text_log.entries">
    <div data-rml="entry.body_rml"></div>
  </article>
</section>
```

`entry.body_rml` is the one NovelTea model field intentionally designed for `data-rml`. The list structure, metadata, visibility, classes, and surrounding controls remain ordinary authored RML/RCSS.

## Choosing between data binding and a custom element

Use ordinary RML/data binding for lists, labels, buttons, menus, choices, exits, inventory, interaction actions, save/load slots, settings controls, Text Log, and other state-driven UI covered by the `noveltea` model.

Use a documented custom element only when NovelTea owns specialized rendering/input behavior that ordinary RML cannot express—currently mature ActiveText, plus the provisional Map exception above.

If a requested `nt-*` tag is not listed in this document, it is not part of the current game-authoring contract. Do not derive tag names from engine types, old NovelTea code, screenshots, CSS class names, or generated runtime markup.
