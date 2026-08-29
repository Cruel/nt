# NovelTea RmlUi Custom Components

Use this reference only when a Layout needs a documented NovelTea `nt-*` element. Ordinary RML plus the `noveltea` data model is the default authoring path. Do not invent custom tags from engine concepts or from class names seen in generated markup.

The current public custom-element surface is exactly:

```text
nt-active-text
nt-map-view
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

## `nt-map-view`

`nt-map-view` is NovelTea's specialized authored Map presentation and input host. A Map remains presentation over authoritative Room/Exit topology; the component does not create a second navigation graph.

```xml
<nt-map-view map="world-map"></nt-map-view>
```

Author-visible contract:

- The `map` attribute selects the authored Map by stable Map ID. When the project contains exactly one authored Map, `map` may be omitted and that sole Map is selected. With multiple authored Maps, select one explicitly; do not rely on collection order or an implicit default.
- RuntimeUI refreshes every matching `nt-map-view` in the active `game-hud` and `text-log` system Layout documents and in mounted gameplay Layout documents. Multiple occurrences are independent, including multiple occurrences that display the same authored Map.
- Each occurrence owns its own `open`, `mode`, `focus`, `pan-x`, `pan-y`, and `zoom` presentation state. User changes emit `mapstatechange`. These values are not gameplay/session state and are not saved automatically.
- If a mounted Layout needs Map view state to survive save/restore, declare the appropriate Layout State Shape/Slot and explicitly copy the desired occurrence-local value through `Game.mount_context():commit_state(...)`. Save data contains only validated Layout State Slots, never arbitrary component/DOM state.
- The component exposes semantic Location and Connection targets carrying the current Map/Room/Location/Connection/Exit identities and actionability. Keyboard/controller/assistive activation uses these semantic targets independently of polygon geometry. Pointer picking uses authored normalized Location/Connection hit geometry and then activates the same semantic target.
- Layout Lua may activate published semantic Map navigation with `Game.ui.navigate_map_connection(map_id, connection_id)` or `Game.ui.navigate_map_location(map_id, location_id)`. The Location convenience action succeeds only when runtime projection finds exactly one actionable Exit-backed Connection from the active Room to that Location's Room. General gameplay Lua may use `noveltea.map.activate(map_id, connection_id)` for the authored Connection path; all of these route through normal Navigation Attempt authority rather than directly changing Rooms.
- The runtime owns the element's generated inner Map markup. Generated child tags, classes, `data-*` attributes, ordering, and event strings are implementation details, not an authored styling or scripting contract.
- Do not write selectors, Layout Lua, tests, or gameplay logic that depends on the generated inner structure. Style/position the outer `nt-map-view` host only unless a future contract explicitly documents more.
- Map navigation is not a `noveltea` data-model callback. Do not invent a model callback or duplicate generated event strings; use the semantic Map actions documented above.

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

Use a documented custom element only when NovelTea owns specialized rendering/input behavior that ordinary RML cannot express—currently ActiveText and Map presentation/input.

If a requested `nt-*` tag is not listed in this document, it is not part of the current game-authoring contract. Do not derive tag names from engine types, old NovelTea code, screenshots, CSS class names, or generated runtime markup.
