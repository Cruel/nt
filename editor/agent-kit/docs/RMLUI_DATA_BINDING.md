# NovelTea RmlUi Data Binding

Use this reference when authoring RML that reads NovelTea runtime state or invokes NovelTea UI actions. It describes the public `noveltea` data model exposed to game Layouts and the RmlUi data-expression rules needed to use it safely.

For general RML/RCSS differences from browser HTML/CSS, read `.noveltea/agent/docs/RMLUI.md`. For NovelTea `nt-*` elements, read `.noveltea/agent/docs/RMLUI_CUSTOM_COMPONENTS.md`.

## Opt in explicitly

Every NovelTea runtime UI context provides one model named `noveltea`, but markup uses it only inside a subtree that explicitly declares it:

```xml
<section data-model="noveltea">
  <h1>{{ project.title }}</h1>
</section>
```

A full document can put `data-model="noveltea"` on `<body>`. A Fragment can put it on its own wrapper or another subtree. System Layout role does not change the model shape and is not required for access.

The model is read-only authoring state. Do not assign to `project`, `gameplay`, or `shell` values and do not treat `data-value`/`data-checked` as a way to persist changes into them. State changes go through the documented model callbacks below or the typed NovelTea Lua API.

Being able to read state does not grant command authority. A callback still obeys the active Layout's normal input/command admission rules; stale IDs, disabled targets, invalid arguments, or a Layout that is not allowed to issue the action do not become valid just because the state was visible.

## Supported RmlUi binding forms

These are the built-in binding forms available in the pinned RmlUi profile. `data-*` attributes and `{{ ... }}` are RmlUi syntax, not browser dataset/template syntax.

| Form                                              | Effect                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{ expression }}` in text                        | Replaces the expression with text. The internal `data-text` view is added automatically; do not author `data-text` yourself.                                                  |
| `data-if="expression"`                            | Sets inline `display: none` when false; removes that inline display override when true. The element remains in the document.                                                  |
| `data-visible="expression"`                       | Sets inline `visibility: hidden` when false; removes that inline visibility override when true, preserving layout space.                                                      |
| `data-for="item : array"`                         | Repeats the element for an array. `data-for="item, i : array"` names both item and zero-based index. With only `data-for="array"`, aliases are `it` and `it_index`.           |
| `data-class-name="expression"`                    | Adds/removes class `name` according to the expression's boolean value.                                                                                                        |
| `data-style-property="expression"`                | Sets the named local RCSS property to the expression converted to text.                                                                                                       |
| `data-attr-name="expression"`                     | Sets attribute `name` to the expression converted to text.                                                                                                                    |
| `data-attrif-name="expression"`                   | Adds empty attribute `name` when true and removes it when false. Useful for `disabled`.                                                                                       |
| `data-rml="expression"`                           | Replaces the element's complete inner RML with the expression result. See the restrictions below.                                                                             |
| `data-alias-name="data.address"`                  | Creates a local alias `name` for an existing data address.                                                                                                                    |
| `data-event-click="..."` and other `data-event-*` | Runs an RmlUi assignment/event expression when that RmlUi event fires. NovelTea actions should call the documented callbacks below.                                           |
| `data-value="data.address"`                       | RmlUi two-way value binding. With `noveltea`, use it only if the read-side value behavior is useful; attempts to write the read-only NovelTea model do not define game state. |
| `data-checked="data.address"`                     | RmlUi two-way checked binding. The same read-only NovelTea restriction applies.                                                                                               |

For boolean HTML-like attributes, prefer `data-attrif-*` rather than converting a boolean through `data-attr-*`: RmlUi value conversion can produce textual `0`/`1`, while `data-attrif-disabled="!item.enabled"` correctly controls attribute presence.

## Data expressions are not JavaScript or Lua

RmlUi data expressions are a small expression language. Do not write JavaScript, Lua, browser template expressions, or arbitrary function calls in them.

Supported expression building blocks are:

- numeric literals such as `4`, `-2`, and `3.5`;
- single-quoted string literals such as `'manual'`;
- `true` and `false`;
- data addresses such as `gameplay.room.exits[0].label` and array `.size`;
- dynamic array indexing with `[expression]`;
- `!`, `*`, `/`, `+`, `-`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`;
- ternary `condition ? when_true : when_false`;
- parentheses;
- built-in transforms `to_lower`, `to_upper`, `round`, and `format`;
- transform piping, for example `value | format(2)` or `label | to_upper`.

`+` performs string concatenation when either operand is a string. There is no JavaScript `===`, optional chaining, nullish coalescing, template literal, object/array literal, arrow function, method-call, or general standard-library surface.

In ordinary view expressions, `name(...)` resolves a data transform, not a NovelTea command callback. NovelTea callbacks are event callbacks and belong in `data-event-*` assignment expressions.

Event expressions can invoke callbacks and can contain multiple statements separated by `;`. RmlUi also permits assignments in these expressions, but the NovelTea model is read-only, so do not use assignments to `project`, `gameplay`, or `shell`. Event parameters are exposed as `ev.<parameter>` for the current event; use only parameters defined by the relevant RmlUi event.

Inside `data-for`, the iterator and index aliases are scoped to each generated item. Avoid choosing iterator names that collide with top-level model variables.

## Structural ownership rules

Treat model-controlled document structure as declarative ownership:

- Do not manually add, remove, or reparent elements inside a `data-for` region. RmlUi owns the repeated elements and may reuse them as the array changes.
- Do not imperatively replace children owned by `data-rml`. A later model update can replace the complete inner RML again.
- Do not attach new `data-*` attributes dynamically and expect them to become bindings. Author bindings in the RML before the element is attached.
- Avoid mixing `data-for` with RmlUi elements that internally restructure children unless an existing NovelTea pattern proves the combination.
- If Layout Lua needs imperative DOM work, keep that work outside subtrees whose structure is controlled by `data-for` or `data-rml`; use `.noveltea/agent/docs/RMLUI_LUA.md` for the supported imperative RmlUi Lua surface.

`data-if` and `data-visible` do not own child structure: they control display/visibility of the existing element.

## `data-rml` is narrowly scoped in NovelTea

`data-rml` parses the expression result as markup and replaces the target's entire inner RML. It is not the normal way to display strings.

Within the `noveltea` model, the only field intentionally designed for `data-rml` is:

```text
gameplay.text_log.entries[].body_rml
```

`body_rml` is engine-generated sanitized rich RML. Use normal `{{ ... }}` interpolation for plain model strings such as `entry.text`, labels, titles, status, and notifications. Do not concatenate arbitrary game/user text into markup and feed it to `data-rml`, and do not depend on the generated structure inside `body_rml` as a stable authoring API.

Example:

```xml
<div data-for="entry : gameplay.text_log.entries">
  <div data-rml="entry.body_rml"></div>
</div>
```

## Exact `noveltea` model

The following is the complete author-visible model shape.

### `project`

```text
project.title: string
project.subtitle: string
project.start_label: string
```

Empty source title/start-label values are presented using NovelTea's effective fallbacks (`NovelTea` and `Start`).

### `gameplay`

```text
gameplay.available: bool
gameplay.mode: string
gameplay.title: string
gameplay.notification: string
gameplay.can_continue: bool
gameplay.active_text_available: bool

gameplay.scene.choices[]:
  id: string
  label: string
  enabled: bool

gameplay.dialogue.choices[]:
  id: string
  label: string
  enabled: bool

gameplay.actors[]:
  character_id: string
  instance_id: string
  pose_id: string
  expression_id: string
  presentation_complete: bool

gameplay.room.available: bool
gameplay.room.has_enabled_exits: bool
gameplay.room.exits[]:
  id: string
  target_id: string
  direction: 'northwest' | 'north' | 'northeast' | 'west' | 'custom' |
             'east' | 'southwest' | 'south' | 'southeast'
  label: string
  enabled: bool
  glyph: 'NW' | 'N' | 'NE' | 'W' | 'GO' | 'E' | 'SW' | 'S' | 'SE'

gameplay.room.objects[]:
  subject_kind: 'character' | 'interactable'
  subject_id: string
  label: string
  enabled: bool
  selected: bool

gameplay.inventory.items[]:
  id: string
  display_name: string
  enabled: bool
  selected: bool

gameplay.interaction.has_selection: bool
gameplay.interaction.selected_subject_kind: string
gameplay.interaction.selected_subject_id: string
gameplay.interaction.verb_menu_open: bool
gameplay.interaction.actions[]:
  verb_id: string
  slot_id: string
  label: string
  binding_order: string[]
  rank: integer
  primary: bool
  enabled: bool

gameplay.command_builder.active: bool
gameplay.command_builder.occurrence: integer
gameplay.command_builder.capture_revision: integer
gameplay.command_builder.captured_subject_kind: string
gameplay.command_builder.captured_subject_id: string
gameplay.command_builder.verb_id: string
gameplay.command_builder.label: string
gameplay.command_builder.binding_order: string[]
gameplay.command_builder.bound_slots: string[]
gameplay.command_builder.focused_slot: string
gameplay.command_builder.complete: bool
gameplay.command_builder.watched[]:
  subject_kind: 'character' | 'interactable' | 'item-stack' | 'feature'
  subject_id: string
  live: bool
  available: bool
  enabled: bool
  visible: bool
  room_id: string
  traits: string[]
  offers: string[]

gameplay.text_log.entries[]:
  sequence: integer
  kind: 'line' | 'choice' | 'notification'
  has_speaker: bool
  speaker_id: string
  text: string
  body_rml: string
```

Scene and Dialogue choices are projected independently. `gameplay.scene.choices` may temporarily overlay the game while `gameplay.dialogue.choices` remains available to the Dialogue layout underneath. `gameplay.room.objects` and `gameplay.inventory.items` omit invisible entries. Room exits include disabled exits, so filter with `exit.enabled` when appropriate. Clearing gameplay resets the gameplay projection rather than leaving old values visible.

### `shell`

```text
shell.available: bool
shell.screen: 'none' | 'title' | 'pause' | 'settings' | 'save' | 'load' |
              'text-log' | 'confirmation' | 'debug'
shell.game_active: bool
shell.status: string

shell.settings.ui_scale.enabled: bool
shell.settings.ui_scale.value: number
shell.settings.ui_scale.minimum: number
shell.settings.ui_scale.default_value: number
shell.settings.ui_scale.maximum: number

shell.settings.text_scale.enabled: bool
shell.settings.text_scale.value: number
shell.settings.text_scale.minimum: number
shell.settings.text_scale.default_value: number
shell.settings.text_scale.maximum: number

shell.checkpoint.available: bool
shell.checkpoint.ready: bool
shell.checkpoint.retained: bool
shell.checkpoint.retained_revision: string
shell.checkpoint.replay_structural_generations: integer
shell.checkpoint.replay_time_generations: integer
shell.checkpoint.replay_play_time_ms: integer
shell.checkpoint.thumbnail_available: bool
shell.checkpoint.thumbnail_capture_pending: bool
shell.checkpoint.summary: string

shell.save_slots[]:
  kind: 'autosave' | 'manual'
  number: integer
  label: string
  occupied: bool
  has_metadata: bool
  play_time_ms: integer
  project_version: string
  detail: string
  thumbnail_available: bool
  thumbnail_url: string

shell.confirmation.active: bool
shell.confirmation.prompt: string
```

Autosave has slot number `0`. A populated `thumbnail_url` is already a logical runtime resource URL and can be assigned with `data-attr-src`; it is not an Asset ID that needs interpolation.

## Exact model callbacks

Callback names are flat identifiers. Use them from `data-event-*` expressions exactly as shown:

```text
ui_continue()
ui_choose(kind, id)
ui_navigate_room(exit_id)
ui_toggle_subject(subject_kind, subject_id)
ui_primary_activate(subject_kind, subject_id)
ui_open_verb_menu(subject_kind, subject_id)
ui_clear_selection()
ui_invoke_interaction(verb_id)
ui_command_builder_submit()
ui_command_builder_rebind(slot_id)
ui_command_builder_cancel()

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

Argument vocabularies are closed where applicable:

- `ui_choose`: `kind` is `scene` or `dialogue`.
- `ui_toggle_subject`, `ui_primary_activate`, and `ui_open_verb_menu`: `subject_kind` is `character` or `interactable`.
- `ui_primary_activate` requests the semantic primary action; `ui_open_verb_menu` opens the ordinary resolved Offer menu without auto-selecting a primary Offer.
- `ui_command_builder_submit` confirms the built-in transient Draft for the active occurrence; `ui_command_builder_rebind` drops one currently bound slot so the next semantic subject capture can repair it; `ui_command_builder_cancel` terminates that occurrence. Runtime watches/submissions accept only subjects already captured for the active occurrence. Replacement Command Builder Layouts own their Draft and use the `Game.ui.begin_command_builder(...)`, `Game.ui.set_command_builder_watch(...)`, and `Game.ui.submit_command_builder(verb_id, bindings)` Lua transport described in `LUA.md`; `selected_subject_kind`, `selected_subject_id`, and each action's `slot_id` provide the subject-first starting information.
- `shell_save_slot`: only currently exposed manual slots are valid.
- `shell_load_slot`: `kind` is `autosave` with number `0`, or `manual` with an exposed manual slot number; the slot must currently be occupied.

Do not invent dotted callback names, call internal engine functions, or assume a callback will operate on a stale/disabled item. Prefer passing IDs and tokens directly from the current model item, as in:

```xml
<button data-for="choice : gameplay.dialogue.choices"
        data-attrif-disabled="!choice.enabled"
        data-event-click="ui_choose('dialogue', choice.id)">
  {{ choice.label }}
</button>
```

Map-connection navigation is not a `noveltea` model callback while `nt-map-view` remains provisional. See the custom-component guide for that boundary.
