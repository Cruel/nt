# RmlUi Runtime UI

## Purpose

Describe how NovelTea runtime views are built with RmlUi and driven by backend-neutral controller/view-state data.

## Current Direction

RmlUi is the general runtime UI layer. Generic screens should use RML/RCSS and ordinary controls where sufficient. Complex game widgets should be C++-backed RmlUi components when they need custom layout, rendering, hit testing, or animation behavior.

## Asset Lookup Order

Runtime UI documents and stylesheets are resolved using an explicit project/theme/system fallback policy:

1. `project:/ui/runtime/<name>` — project override
2. `theme:/ui/runtime/<name>` — theme override (only if `theme` namespace is mounted)
3. `system:/ui/runtime/<name>` — system fallback (engine-provided defaults)
4. `project:/rmlui/<name>` — legacy sandbox compatibility fallback

The last path is a transitional alias kept so existing sandbox assets continue working without being moved immediately.

## Required Document Slot IDs

All runtime game documents must provide these element IDs for the binder to update:

| Slot ID | Required | Purpose |
|---|---|---|
| `rt_root` | yes | Root layout container |
| `rt_mode` | yes | Current game mode display |
| `rt_title` | yes | Room/dialogue title |
| `rt_notification` | no | Status notification text |
| `rt_background_image` | no | Project/room background image slot |
| `rt_cover_image` | no | Project cover image slot |
| `rt_room_image` | no | Current room image slot |
| `rt_asset_status` | no | Missing runtime visual asset warnings |
| `rt_body` | yes | Main text body (room description, dialogue, cutscene) |
| `rt_prompt` | no | Continue/page-break button |
| `rt_options` | no | Dialogue option buttons |
| `rt_navigation` | no | Navigation direction buttons |
| `rt_objects` | no | Room object buttons |
| `rt_inventory` | no | Inventory object buttons |
| `rt_actions` | no | Action verb buttons |
| `rt_log` | no | Text log entries |
| `rt_map` | no | Map/minimap placeholder |

The binder tolerates missing optional slots by logging a one-time warning per slot. Missing required slots produce an immediate diagnostic. The system fallback template includes all slots.

`rt_body`, `rt_log`, and `rt_map` are implemented by default as C++-backed custom elements:
`nt-active-text`, `nt-text-log`, and `nt-map-view`. Project/theme templates may still use
ordinary elements with the same IDs; the binder will populate them with the same safe
fallback RML.

## Event Attributes

UI actions must route through `RuntimeInput` attributes, not inline event handlers:

| Attribute | Maps To | Value |
|---|---|---|
| `nt-option="<index>"` | `SelectDialogueOption` | Zero-based option index |
| `nt-nav="<index>"` | `Navigate` | Zero-based navigation direction index |
| `nt-continue="1"` | `Continue` | Continue/prompt click |
| `nt-object="<object id>"` | `SelectObject` | Object entity ID |
| `nt-action="<verb id>"` | `RunAction` | Action verb ID |
| `nt-clear-selection="1"` | `ClearObjectSelection` | Clear current selection |

Input is always submitted through `RuntimeSessionHost::apply_input()` and refreshed from the host result/commands. No UI event handler may bypass the shared `RuntimeInput` path.

## Runtime Visual Assets

Phase 11 v1 presents runtime visuals through RmlUi elements backed by the existing bgfx RmlUi texture loader. `RuntimeUIViewState` exposes:

- `cover_image`: the legacy/package cover slot, conventionally `project:/image`.
- `background_image`: the current room background if configured, otherwise the cover image fallback.
- `room_image`: the current room image if configured.
- `RuntimeUIObject::image`: object/inventory image metadata.

Visual metadata is read from backend-neutral entity properties. Supported keys are intentionally small:

- Rooms: `background`, `image`, `texture`
- Objects: `image`, `texture`

Values may be full logical paths such as `project:/textures/foyer.png`, relative texture paths such as `textures/foyer.png`, or texture ids/names that resolve to `project:/textures/<value>`. Material properties are not interpreted for room/object UI image slots in this path; rich-text material IDs and low-level shader IDs are preserved on ActiveText glyph visuals and resolved by the direct ActiveText renderer when possible.

`RuntimeUI` validates resolved visual paths with `AssetManager::exists()` before binding and records missing paths in `RuntimeUIViewState::asset_diagnostics` for display in `rt_asset_status`. Decode/upload failures remain renderer diagnostics from the RmlUi/bgfx texture loader.

## Encoded Namespace Paths

RmlUi stylesheets referenced by a runtime document can use encoded namespace paths to resolve relative to the correct asset mount:

- `system|/ui/runtime/runtime_game.rcss` → `system:/ui/runtime/runtime_game.rcss`
- `project|/ui/runtime/runtime_game.rcss` → `project:/ui/runtime/runtime_game.rcss`

The encoded form `namespace|/path` is recognized by `resolve_asset_path()` and is the recommended way for system fallback RML to reference its companion RCSS without depending on relative path behavior.

## DPI and Layout

- The context `SetDensityIndependentPixelRatio()` is driven by `SurfaceMetrics.scale_x`.
- The system fallback RCSS avoids viewport-scaled font sizes. Use stable RCSS sizes with flex/percentage layout.
- Responsive breakpoints:
  - ~1280×720: main column + side panel
  - ~800×600: stacked layout without clipped controls

## Binder Architecture

`RuntimeUiDocumentBinder` in `engine/src/ui/rmlui/rmlui_document_binder.hpp` centralizes all element lookup and `SetInnerRML()` calls. It replaces the previous all-in-one `refresh_runtime_document()` method.

The binder:
- Escapes all text content for RML safety.
- Populates optional cover, background, room image, object image, and asset-warning slots.
- Separates room objects from inventory objects into `rt_objects` and `rt_inventory` slots.
- Feeds `RuntimeUIViewState` into the Phase 5 custom components when the document contains
  `nt-active-text`, `nt-text-log`, or `nt-map-view`.
- RuntimeUI may bind a borrowed engine `TweenService`. When present, ActiveText body changes
  start a deterministic `runtime-ui` / `active-text-reveal` tween and expose current progress
  in fallback RML. Without a bound service, progress is complete and the UI remains static.
- ActiveText fallback RML consumes backend-neutral `RichTextDocument` state from
  `RuntimeUIViewState` through the engine `ActiveTextFrame` projection. It emits per-glyph
  classes/data attributes for style, object, diff, offset, reveal, and effect state.
- RuntimeUI also exposes a direct ActiveText render snapshot. After `Rml::Context::Update()` has
  resolved layout, `nt-active-text` provides the content box in logical coordinates. RuntimeUI uses
  the engine text stack to shape the visible text and `ActiveTextLayout` maps the shaped glyph byte
  ranges back to rich-text metadata, renderer-facing glyph visuals, and object hit rectangles.
  `Renderer::draw_active_text()` draws those shaped glyphs through the existing bgfx text atlas path
  after RmlUi has rendered, so the direct path is visibly exercised while fallback RML remains
  available.
- Clicking an object span inside `nt-active-text` walks from the event target through ancestors to
  find the owning active-text element, then uses the direct layout hit rectangles and routes through
  `RuntimeInputType::SelectObject`. This covers clicks on the root, child spans, or descendants.
- Logs missing optional slots once per slot per document lifetime.
- Populates `rt_map` with a placeholder when empty.

## Template Resolver

`RuntimeUiTemplateResolver` in `engine/src/ui/rmlui/rmlui_template_resolver.hpp` implements the project/theme/system fallback policy. It is constructed once in `RuntimeUI::initialize()` and queried each time the runtime document is loaded or reloaded.

## Document Lifecycle

- `RuntimeUI::initialize()` creates the resolver and binder, then loads the runtime game document via the resolver.
- `RuntimeUI::bind_runtime_host()` attaches the `RuntimeInputListener` to the runtime document.
- `RuntimeUI::reload_documents_and_styles()` preserves the runtime game document across reload: it saves whether a runtime document was loaded, unloads all documents, then reloads both the demo and runtime documents. The input listener is reattached after reload if a host is bound.
- `RuntimeUI::unload_document()` removes the runtime input listener before closing the runtime game document.
