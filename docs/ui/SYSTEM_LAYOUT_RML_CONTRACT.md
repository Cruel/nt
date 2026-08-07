# System Layout RML Contract

## Purpose

This document is the authoritative inventory of RML element IDs and custom element tags that
NovelTea populates automatically for system Layout roles. It also records the generated markup and
Lua handlers used by the built-in documents so a project can copy a fallback Layout, assign the same
system role, and retain equivalent behavior while changing its structure or styling.

The built-in source documents are useful working examples:

- `engine/assets/system/ui/title/default-title.rml`
- `engine/assets/system/ui/runtime/runtime_game.rml`
- `engine/assets/system/ui/menu/pause-menu.rml`
- `engine/assets/system/ui/menu/save-menu.rml`
- `engine/assets/system/ui/menu/load-menu.rml`
- `engine/assets/system/ui/menu/settings-menu.rml`
- `engine/assets/system/ui/menu/text-log.rml`
- `engine/assets/system/ui/menu/modal.rml`

## Binding Rules

System bindings are role-scoped, not global ID magic. An element named `rt_navigation` in an ordinary
Layout, or in a system Layout assigned to an unrelated role, is not populated merely because the ID
matches. `LayoutRealizer` publishes the active document for each mounted system role and `RuntimeUI`
applies that role's binding contract to that document.

All documented slots are optional. A project may omit any slot it does not want. When a populated
slot is present, the engine generally replaces its complete inner RML whenever the corresponding
runtime or shell view refreshes. Authored children inside such a slot must therefore be treated as
disposable. IDs must be unique within the document, as normal RmlUi document rules require.

Bindings are reapplied after document/style reload and lifecycle-context recreation. Assigning a
project Layout to a system role gives it the same role bindings and native runtime input listener as
the built-in fallback.

Custom tags are selected by tag name rather than ID. For `nt-active-text`, `nt-text-log`, and
`nt-map-view`, only the first matching custom element in the bound document receives the snapshot.
When a preferred custom tag is present, its corresponding legacy ID fallback is not populated.

## Role Summary

| System role | Automatically populated contract |
| --- | --- |
| `title` | Title labels and shared shell status |
| `game-hud` | Gameplay view slots, gameplay custom elements, and generated gameplay controls |
| `pause-menu` | Shared shell status |
| `save-menu` | Shared shell status, checkpoint summary, and generated manual save slots |
| `load-menu` | Shared shell status, checkpoint summary, and generated load slots |
| `settings-menu` | Shared shell status and UI/text accessibility scale values |
| `text-log` | Shared shell status plus the gameplay document binder, normally `nt-text-log` or `rt_log` |
| `modal` | Shared shell status and confirmation prompt |
| `debug-overlay` | No automatically populated RML slots currently |

## Shared Shell Slot

The following slot is recognized in the `title`, `pause-menu`, `save-menu`, `load-menu`,
`settings-menu`, `text-log`, and `modal` roles. It is not currently populated for `game-hud` or
`debug-overlay`.

| Element ID | Population behavior |
| --- | --- |
| `nt-shell-status` | Replaces inner RML with the escaped current shell status message. The value may be empty. |

## Title Role

| Element ID | Population behavior |
| --- | --- |
| `nt-title-project` | Replaces inner RML with the escaped project title. An empty title falls back to `NovelTea`. |
| `nt-title-subtitle` | Replaces inner RML with the escaped title subtitle. |
| `nt-title-start` | Replaces only the element's inner RML with the escaped start label. An empty label falls back to `Start`. The engine does not add the click handler; the built-in button authors `onclick="Game.start()"`. |
| `nt-shell-status` | Uses the shared shell-status contract above. |

Other IDs in the built-in title document, including `nt-title-root`, `nt-title-panel`,
`nt-title-kicker`, `nt-title-actions`, `nt-title-load`, `nt-title-settings`, and
`nt-title-diagnostic`, are structural or styling hooks. They are not populated by the native title
binder.

## Game HUD Role

The active `game-hud` document receives the complete typed gameplay UI view.

| Element ID or tag | Population behavior |
| --- | --- |
| `rt_mode` | Replaces inner RML with the escaped runtime mode string. |
| `rt_title` | Replaces inner RML with the escaped current Map title when one is present; otherwise empty. |
| `rt_notification` | Replaces inner RML with the escaped output notification. When that is empty, uses the current Interaction notification when available. |
| `nt-active-text` tag | Preferred ActiveText host. The first tag receives the current Scene/Dialogue text or Room description snapshot and supplies the RmlUi layout box used by the direct text renderer. Its authored children are cleared. |
| `rt_body` | Legacy text fallback used only when the document has no `nt-active-text` tag. Replaces inner RML with escaped paragraph markup. |
| `rt_prompt` | Replaces inner RML with a `button.continue` calling `Game.ui.continue()` when continuation is available; otherwise empty. |
| `rt_options` | Replaces inner RML with Scene-choice buttons, or Dialogue-choice buttons when no Scene choice is active. |
| `rt_actors` | Replaces inner RML with metadata-only elements for visible Scene actors. |
| `rt_navigation` | Hosts the built-in directional Room-exit controls. The binder updates the permanent direction buttons' labels, `data-exit-id` values, and visibility from the enabled exits in the current Room. |
| `rt_objects` | Replaces inner RML with selectable buttons for visible Room placement occupants. |
| `rt_inventory` | Replaces inner RML with selectable buttons for visible inventory items. |
| `rt_actions` | Replaces inner RML with an optional clear-selection button and the currently available Room or inventory interaction controls. |
| `nt-text-log` tag | Preferred text-log component. The first tag receives the complete typed text-log snapshot. |
| `rt_log` | Legacy text-log fallback used only when the document has no `nt-text-log` tag. |
| `nt-map-view` tag | Preferred Map component. The first tag receives the complete typed Map snapshot. |
| `rt_map` | Legacy Map fallback used only when the document has no `nt-map-view` tag. |

The world renderer is the sole owner of Room and Scene backgrounds. The game-HUD binder does not
provide a background-image slot. A project that wants decorative HUD imagery should author ordinary
RML images from declared Layout dependencies rather than redisplaying the active world background.

The current built-in HUD also uses `rt_text_panel`, `rt_interaction_dock`, `rt_objects_group`,
`rt_inventory_group`, and `rt_actions_group` as structural visibility hooks. When present, the binder
hides empty groups and panels. A replacement Layout may omit those hooks and control its own structure.

### Generated Game HUD Markup

The engine-generated children expose these current styling and metadata hooks:

| Parent slot | Generated hooks |
| --- | --- |
| `rt_prompt` | `button.continue` |
| `rt_options` | `button.option`; disabled choices also receive class `disabled` and the `disabled` attribute |
| `rt_actors` | `div.actor` with `data-character-id`, `data-slot-id`, `data-pose-id`, `data-expression-id`, and `data-presentation-complete` |
| `rt_navigation` | Permanent `button.nav.nav-{direction}` controls with `data-direction` and binder-managed `data-exit-id`; each contains `span.nav-glyph` and `span.nav-label`. Direction tokens are `northwest`, `north`, `northeast`, `west`, `custom`, `east`, `southwest`, `south`, and `southeast`. Room validation permits at most one exit per direction. Buttons without an enabled exit are hidden. |
| `rt_objects` | `button.object`, with optional `selected` and `disabled` classes |
| `rt_inventory` | `button.object`, with optional `selected` and `disabled` classes |
| `rt_actions` | `button.clear-selection` and `button.action`; unavailable actions receive class `disabled` and the `disabled` attribute |

Generated choice, object, inventory, and action buttons call typed `Game.ui` functions using stable
IDs from the current view. Permanent navigation buttons carry a binder-managed `data-exit-id` and
are dispatched directly by the RuntimeUI document listener. Both paths validate the current target
before submitting typed runtime input, so stale, hidden, unknown, or disabled targets fail.

Room descriptions are transient per Room visit. The first published view for a visit exposes the
description through ActiveText and marks continuation available. Completing the ActiveText message
clears the description from later gameplay-UI publications for that visit. Entering a different Room
or beginning a later visit creates a new transient message. This dismissal is presentation/session
state and is intentionally not serialized into save data.

## Layout Asset URLs

RML and RCSS use mounted logical namespaces rather than authoring Asset IDs:

- `system|/ui/runtime/runtime_game.rcss` addresses an engine-owned resource under
  `engine/assets/system`.
- `project|/assets/images/navigation-arrow.png` addresses a packaged project resource.
- relative URLs resolve from the current document and then through the project mount.

Project-authored Layouts must declare referenced images, fonts, stylesheets, scripts, and materials in
their dependency lists. That declaration makes focused preview, validation, prefetch, and export aware
of the resources. It does not substitute `$ref` values into inline RML. Consequently, a future
project navigation-arrow asset can be referenced by a `project|/...` URL and styled on the generated
direction classes; an engine-provided default would use `system|/...` instead.

## Custom Runtime Elements

These tags are registered globally with RmlUi, but automatic snapshot population currently occurs
only when the containing document is passed through the gameplay document binder: the active
`game-hud` document and the active `text-log` document. An ordinary authored Layout containing one of
these tags does not automatically receive gameplay data.

### `nt-active-text`

`nt-active-text` is a layout and input host for engine-rendered ActiveText. The engine uses the first
tag's content box, computed text color, `rmlui-language`, effective text scale, and font raster scale.
It clears inner RML and maintains these data attributes:

- `data-reveal-progress`
- `data-page-break`
- `data-awaiting-continue`

Click events within the element are routed through native ActiveText hit testing. The element ID is
not significant; the built-in document uses `id="rt_body"` only as a styling hook.

### `nt-text-log`

`nt-text-log` replaces its inner RML with the current log. Empty logs contain
`p.nt-text-log__empty`. Entries use `div.nt-text-log__entry` with `data-sequence` and `data-kind`,
plus `span.nt-text-log__speaker` and `div.nt-text-log__body` where applicable. The element ID is not
significant; the built-in documents use `id="rt_log"` for styling.

### `nt-map-view`

`nt-map-view` replaces its inner RML with the current Map projection. An unavailable Map contains
`p.nt-map-view__placeholder`. The populated root and children currently expose classes and typed data
attributes including:

- `nt-map-view__root`, with `data-map-id`, optional `data-current-room-id`, and `data-mode`;
- `nt-map-view__title`;
- `nt-map-view__connections` and `nt-map-view__connection`, with connection, source, target, Room,
  and exit IDs;
- `nt-map-view__rooms` and `nt-map-view__room`, with location/Room IDs and authored coordinates;
- modifier classes such as `nt-map-view__root--hidden`, `nt-map-view__connection--selectable`,
  `nt-map-view__room--current`, and `nt-map-view__room--focused`.

Selectable connections call `Game.ui.navigate_map_connection(connection_id)`. The element ID is not
significant; the built-in document uses `id="rt_map"` for styling.

## Pause Menu Role

The pause-menu binder currently recognizes only `nt-shell-status`. Navigation and command buttons
are authored normally through `Game.shell` handlers.

## Settings Menu Role

| Element ID | Population behavior |
| --- | --- |
| `nt-settings-ui-scale-control` | Sets inline `display` to `block` or `none` according to whether project UI scaling is enabled. |
| `nt-settings-ui-scale` | Replaces inner RML with the current effective UI scale. |
| `nt-settings-ui-scale-minimum` | Replaces inner RML with the project's minimum UI scale. |
| `nt-settings-ui-scale-maximum` | Replaces inner RML with the project's maximum UI scale. |
| `nt-settings-text-scale-control` | Sets inline `display` to `block` or `none` according to whether project text scaling is enabled. |
| `nt-settings-text-scale` | Replaces inner RML with the current effective text scale. |
| `nt-settings-text-scale-minimum` | Replaces inner RML with the project's minimum text scale. |
| `nt-settings-text-scale-maximum` | Replaces inner RML with the project's maximum text scale. |
| `nt-shell-status` | Uses the shared shell-status contract. |

The binder does not create settings buttons. The built-in document authors buttons using
`Game.shell.set_ui_scale_minimum()`, `set_ui_scale_default()`, `set_ui_scale_maximum()`, and the
corresponding text-scale functions. A custom settings Layout may instead call
`Game.shell.set_ui_scale(value)` or `Game.shell.set_text_scale(value)`.

## Save and Load Menu Roles

Both roles recognize the same two content slots, but generate different actions.

| Element ID | Population behavior |
| --- | --- |
| `nt-checkpoint-summary` | Replaces inner RML with an escaped summary of checkpoint readiness, retained revision, replay distance, and thumbnail state. |
| `nt-save-slots` | Replaces inner RML with the current slot list. Save menus omit the autosave slot and generate Save buttons. Load menus include autosave and generate Load buttons only for occupied slots. |
| `nt-shell-status` | Uses the shared shell-status contract. |

Generated slot markup uses:

- `section.nt-save-slot`;
- `img.nt-save-thumbnail` when a thumbnail exists;
- `p.nt-save-thumbnail-missing` otherwise;
- `Game.shell.save(slot)`, `Game.shell.load(slot)`, or `Game.shell.load_autosave()` button handlers.

Thumbnail bytes are exposed to RmlUi through a generated virtual asset below
`project:/generated/shell/`. The generated filename includes a content fingerprint so refreshed
thumbnail data receives a distinct resource identity.

## Text Log Role

The intended text-log contract is:

| Element ID or tag | Population behavior |
| --- | --- |
| `nt-text-log` tag | Preferred typed text-log component. |
| `rt_log` | Legacy fallback when no `nt-text-log` tag exists. |
| `nt-shell-status` | Uses the shared shell-status contract. |

The current implementation applies the general gameplay document binder to the active `text-log`
document. Therefore all Game HUD slots and custom tags listed above are also recognized when placed
in a text-log Layout, although the built-in text-log document uses only `nt-text-log` and
`nt-shell-status`.

## Modal Role

| Element ID | Population behavior |
| --- | --- |
| `nt-modal-prompt` | Replaces inner RML with the escaped pending confirmation prompt, or an empty value when no confirmation exists. |
| `nt-shell-status` | Uses the shared shell-status contract. |

Confirm and cancel buttons are authored normally using `Game.shell.confirm()` and
`Game.shell.cancel()`.

## Debug Overlay Role

`debug-overlay` has no built-in fallback and no automatically populated element IDs currently. A
project-authored debug overlay can use the shell-safe Lua capability surface available to system
Layouts, including `Game.shell.state()`, but naming an element after another role's slot does not
populate it.

## Companion Lua Handlers

Automatic population and authored actions are separate parts of the system Layout contract. The
engine does not infer button behavior from an element ID except for generated children placed inside
the documented container slots.

The shell-facing handlers currently available to system Layout RML are:

```text
Game.start()
Game.shell.pause()
Game.shell.resume()
Game.shell.open_settings()
Game.shell.open_save()
Game.shell.open_load()
Game.shell.open_text_log()
Game.shell.open_debug()
Game.shell.close()
Game.shell.return_to_title()
Game.shell.quit()
Game.shell.save(slot)
Game.shell.load(slot)
Game.shell.load_autosave()
Game.shell.set_ui_scale(value)
Game.shell.set_text_scale(value)
Game.shell.set_ui_scale_minimum()
Game.shell.set_ui_scale_default()
Game.shell.set_ui_scale_maximum()
Game.shell.set_text_scale_minimum()
Game.shell.set_text_scale_default()
Game.shell.set_text_scale_maximum()
Game.shell.confirm()
Game.shell.cancel()
Game.shell.state()
```

The gameplay handlers used by generated Game HUD markup are:

```text
Game.ui.continue()
Game.ui.choose_scene(option_id)
Game.ui.choose_dialogue(edge_id)
Game.ui.navigate_room(exit_id)
Game.ui.navigate_map_connection(connection_id)
Game.ui.toggle_interactable(interactable_id)
Game.ui.toggle_character(character_id)
Game.ui.clear_selection()
Game.ui.invoke_interaction(verb_id)
```

These APIs are typed runtime gateways, not arbitrary DOM callbacks. Invalid or stale IDs are rejected
at activation time.

## Maintenance Rule

Any change that adds, removes, renames, or changes the population behavior of a system Layout slot,
custom runtime element, generated class/data attribute, or companion `Game.shell`/`Game.ui` handler
must update this document alongside the implementation and its parity tests.
