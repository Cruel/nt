# RmlUi `noveltea` Data Model Contract

## Purpose

This document is the authoritative authored-RML contract for NovelTea runtime UI state and actions.
Every RuntimeUI-owned RmlUi context creates one context-local model named `noveltea`. Any full
document or Fragment may opt a subtree into that model with `data-model="noveltea"`; model
availability is independent of system Layout role.

System roles still own mounting, lifecycle, input/pause policy, shell routing, and built-in fallback
selection. They do not grant a separate data shape and do not trigger native population of element
IDs. IDs in the built-in RML are ordinary authored styling, focus, and test hooks.

The built-in examples are:

- `engine/assets/system/ui/title/default-title.rml`
- `engine/assets/system/ui/runtime/runtime_game.rml`
- `engine/assets/system/ui/menu/pause-menu.rml`
- `engine/assets/system/ui/menu/save-menu.rml`
- `engine/assets/system/ui/menu/load-menu.rml`
- `engine/assets/system/ui/menu/settings-menu.rml`
- `engine/assets/system/ui/menu/text-log.rml`
- `engine/assets/system/ui/menu/modal.rml`

## Binding Rules

Use normal RmlUi data binding inside an opted-in subtree: interpolation, `data-if`, `data-for`,
`data-class-*`, `data-style-*`, `data-attr-*`, `data-attrif-*`, and `data-event-*`. Creating the model
in a context does not opt arbitrary markup into it. Model values are read-only; mutations happen only
through the callbacks documented below or through the existing typed Lua capability surface.

RuntimeUI publishes one coherent projection and then dirties every live context model. RmlUi applies
the changes during the context's next normal update. Document reload and context recreation bind the
already-current projection; authored documents must not depend on native DOM repair or magic IDs.

Data visibility and command authority are separate. A Layout that can read `noveltea` state does not
gain gameplay or shell authority beyond the same typed mounted-Layout admission and validation paths
used by the corresponding Lua helpers.

## `project`

| Field | Type | Meaning |
| --- | --- | --- |
| `project.title` | string | Effective title; empty input falls back to `NovelTea`. |
| `project.subtitle` | string | Current title subtitle, including empty. |
| `project.start_label` | string | Effective Start label; empty input falls back to `Start`. |

Initial values are `NovelTea`, empty subtitle, and `Start`.

## `gameplay`

| Field | Type | Meaning |
| --- | --- | --- |
| `gameplay.available` | bool | A nonzero accepted gameplay UI revision is retained. |
| `gameplay.mode` | string | Current typed runtime UI mode, else empty. |
| `gameplay.title` | string | Current Map title, else empty. |
| `gameplay.notification` | string | Typed runtime notification when nonempty, otherwise Interaction notification; empty when gameplay is unavailable. |
| `gameplay.can_continue` | bool | Current typed Continue availability. |
| `gameplay.active_text_available` | bool | Current ActiveText source is nonempty, with Scene then Dialogue then Room precedence. |
| `gameplay.choices` | array | Effective Scene choices, otherwise Dialogue choices; never merged. |
| `gameplay.actors` | array | Visible Scene actors in source order. |
| `gameplay.room.available` | bool | Current view contains a Room. |
| `gameplay.room.has_enabled_exits` | bool | At least one Room exit is enabled. |
| `gameplay.room.exits` | array | All Room exits in source order, including disabled exits. |
| `gameplay.room.objects` | array | Visible Room placement occupants in placement then occupant order. |
| `gameplay.inventory.items` | array | Visible inventory items in source order. |
| `gameplay.interaction.has_selection` | bool | At least one subject is selected. |
| `gameplay.interaction.actions` | array | Room controls when a Room exists, otherwise inventory controls. |
| `gameplay.text_log.entries` | array | Text Log entries in source order. |

Collection members are exact:

- `gameplay.choices[]`: `kind` (`scene` or `dialogue`), `id`, `label`, `enabled`.
- `gameplay.actors[]`: `character_id`, `instance_id`, `pose_id`, `expression_id`,
  `presentation_complete`.
- `gameplay.room.exits[]`: `id`, `target_id`, `direction`, `label`, `enabled`, `glyph`.
  Direction tokens are exactly `northwest`, `north`, `northeast`, `west`, `custom`, `east`,
  `southwest`, `south`, and `southeast`; glyphs are `NW`, `N`, `NE`, `W`, `GO`, `E`, `SW`, `S`,
  and `SE`.
- `gameplay.room.objects[]`: `subject_kind` (`character` or `interactable`), `subject_id`, `label`,
  `enabled`, `selected`. Invisible occupants are omitted and duplicate subjects in distinct
  placements are preserved.
- `gameplay.inventory.items[]`: `id`, `display_name`, `enabled`, `selected`. Invisible items are
  omitted.
- `gameplay.interaction.actions[]`: `verb_id`, `label`, `arity`, `quick_action`, `enabled`.
- `gameplay.text_log.entries[]`: `sequence`, `kind` (`line`, `choice`, or `notification`),
  `has_speaker`, `speaker_id`, `text`, `body_rml`. `body_rml` is engine-generated sanitized rich RML
  and is the only model field intended for `data-rml`.

Clearing gameplay resets all gameplay scalars and arrays rather than leaving the prior declarative
state visible.

## `shell`

| Field | Type | Meaning |
| --- | --- | --- |
| `shell.available` | bool | RuntimeUI currently retains a shell view. |
| `shell.screen` | string | `none`, `title`, `pause`, `settings`, `save`, `load`, `text-log`, `confirmation`, or `debug`. |
| `shell.game_active` | bool | Current shell game-active state. |
| `shell.status` | string | Current shell status text. |
| `shell.settings.ui_scale.enabled` | bool | Project UI-scale policy enabled. |
| `shell.settings.ui_scale.value` | number | Effective UI scale. |
| `shell.settings.ui_scale.minimum` | number | Project UI-scale minimum. |
| `shell.settings.ui_scale.default_value` | number | Runtime default UI scale. |
| `shell.settings.ui_scale.maximum` | number | Project UI-scale maximum. |
| `shell.settings.text_scale.enabled` | bool | Project text-scale policy enabled. |
| `shell.settings.text_scale.value` | number | Effective text scale. |
| `shell.settings.text_scale.minimum` | number | Project text-scale minimum. |
| `shell.settings.text_scale.default_value` | number | Runtime default text scale. |
| `shell.settings.text_scale.maximum` | number | Project text-scale maximum. |
| `shell.checkpoint.available` | bool | A checkpoint observation exists. |
| `shell.checkpoint.ready` | bool | Current checkpoint can be captured. |
| `shell.checkpoint.retained` | bool | A retained revision exists. |
| `shell.checkpoint.retained_revision` | string | Decimal retained revision, else empty. |
| `shell.checkpoint.replay_structural_generations` | integer | Structural replay distance, else zero. |
| `shell.checkpoint.replay_time_generations` | integer | Time replay distance, else zero. |
| `shell.checkpoint.replay_play_time_ms` | integer | Replay play-time distance in milliseconds, else zero. |
| `shell.checkpoint.thumbnail_available` | bool | Current checkpoint thumbnail availability. |
| `shell.checkpoint.thumbnail_capture_pending` | bool | Thumbnail capture is pending. |
| `shell.checkpoint.summary` | string | Human-readable checkpoint summary; unavailable fallback is `Checkpoint status unavailable.` |
| `shell.save_slots` | array | Every shell slot in source order, including autosave. |
| `shell.confirmation.active` | bool | A confirmation is active. |
| `shell.confirmation.prompt` | string | Confirmation prompt, else empty. |

The checkpoint summary format is exactly:

```text
{Ready to capture|Capture blocked} · retained {revision|none} · replay distance {structural} structural / {time} time / {play_ms} ms · thumbnail {pending|available|unavailable}
```

`pending` takes precedence over `available`.

Each `shell.save_slots[]` entry contains exactly `kind` (`autosave` or `manual`), `number` (autosave
is zero), `label`, `occupied`, `has_metadata`, `play_time_ms`, `project_version`, `detail`,
`thumbnail_available`, and `thumbnail_url`. Available thumbnails use a content-fingerprinted logical
URL below `project:/generated/shell/`; bytes remain native virtual-file resources and are never model
values. Save RML filters autosave declaratively; Load RML may render all slots and exposes Load only
for occupied slots.

Clearing the shell resets its scalars, nested scale/checkpoint/confirmation state, and slot array.

## Model Callbacks

RmlUi data-expression callback names are flat identifiers. The exact callbacks are:

```text
ui_continue()
ui_choose(kind, id)
ui_navigate_room(exit_id)
ui_toggle_subject(subject_kind, subject_id)
ui_clear_selection()
ui_invoke_interaction(verb_id)

shell_start()
shell_pause()
shell_resume()
shell_open_settings()
shell_open_save()
shell_open_load()
shell_open_text_log()
shell_open_debug()
shell_close()
shell_return_to_title()
shell_quit()
shell_save_slot(number)
shell_load_slot(kind, number)
shell_set_ui_scale(value)
shell_set_text_scale(value)
shell_confirm()
shell_cancel()
```

`ui_choose` accepts only `scene` or `dialogue`. `ui_toggle_subject` accepts only `character` or
`interactable`. `shell_save_slot` accepts only manual slots exposed by the current shell slot state.
`shell_load_slot` accepts `autosave` only with number zero or `manual` with an exposed manual slot,
and the selected slot must currently be occupied. Invalid kinds, hidden/unexposed or empty slots,
numbers, stale IDs, hidden/disabled targets, disallowed Layout contexts, and malformed arguments do
not dispatch typed commands.

Each callback is a thin adapter over the same `RuntimeUiActionGateway` path used by the equivalent
`Game.ui.*` or `Game.shell.*` Lua helper. The Lua APIs remain available; the model callbacks are not
a second validation implementation.

Map connection navigation intentionally remains on `Game.ui.navigate_map_connection()` while
`nt-map-view` is provisional. Hotspot identity is presentation-only: gameplay Layout code acts on the published semantic subject/navigation APIs rather than invoking a Hotspot directly.

## Custom Runtime Elements

Ordinary state-driven UI should use the data model. Two custom tags remain exceptions:

- `nt-active-text` is the mature engine-rendered ActiveText host. RuntimeUI updates only the first
  tag in the active `game-hud` system document; its RmlUi content box and computed presentation
  values feed engine shaping/rendering and native hit testing.
- `nt-map-view` is provisional. RuntimeUI updates only the first tag in the active `game-hud` and
  active `text-log` system documents while gameplay exists. Its current generated inner RML and
  `Game.ui.navigate_map_connection()` activation are explicitly not a final Map authoring contract.

There is no `nt-text-log` current contract. Text Log is ordinary data-driven RML using
`gameplay.text_log.entries`.

## Built-in Use

All built-in Title, Game HUD, Pause, Settings, Save, Load, Text Log, and Modal documents opt into
`noveltea`. The built-ins intentionally render only their current product surfaces; model availability
does not imply every field should be displayed. In particular, the current Game HUD does not add a
runtime-mode label, standalone Continue button, actor metadata list, Text Log, or Map merely because
those values/capabilities exist.

## Layout Asset URLs

Authored RML/RCSS source uses mounted namespace spelling such as `system|/path` and `project|/path`;
relative URLs resolve from the document. Project Layouts must declare referenced resources in their
dependency graph. Dynamic `thumbnail_url` is already a logical `project:/generated/shell/...` URL
because it is assigned after XML parsing by `data-attr-src`.

## Maintenance Rule

Any change to the `noveltea` model name, field schema, callback set, filtering/order/token rules,
custom-element exceptions, or built-in binding patterns must update this document and focused model
contract tests in the same change.
