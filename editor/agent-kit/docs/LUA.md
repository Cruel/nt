# NovelTea Lua Authoring Reference

Use this reference when writing NovelTea Script Modules or Layout Lua. It assumes normal Lua competence and documents only NovelTea's dialect, sandbox, public authoring APIs, execution contexts, and restrictions.

## Runtime profile

NovelTea requires **Lua 5.5.0 exactly**. Authoring compatibility is defined by NovelTea's runtime bindings and sandbox, not by whatever Lua version happens to be installed on the authoring machine.

The normal authored runtime opens only these Lua libraries:

```text
base
coroutine
table
string
math
utf8
```

The following normal Lua facilities are deliberately unavailable:

```text
os
io
debug
package
require
dofile
loadfile
```

There is no filesystem/module-loader escape hatch through NovelTea APIs. `print(...)` is replaced by NovelTea's host logger and writes a `[lua]` diagnostic line rather than targeting a browser console or terminal abstraction owned by the game.

The base-library `load` function exists in the normal runtime. Focused preview environments replace it with an environment-bound version: loaded code stays in that candidate environment and an explicit foreign environment is rejected. Do not build game behavior around sharing globals between focused-preview candidates.

`math.random` and `math.randomseed` are replaced when runtime capabilities are active. They use NovelTea's saved deterministic session generator rather than Lua's independent default generator. `math.randomseed(seed)` accepts the single non-negative NovelTea seed; `math.random()` and its one-/two-bound integer forms delegate to `noveltea.random`.

The `coroutine` library being present does **not** mean every authored invocation may yield. Yield authority is an engine-selected execution-context rule described below.

## Source ownership and execution

A `.lua` file does not execute merely because it exists in the project. Lua source participates only through an explicitly owned Script Module, Layout Lua source, expression/effect/instruction reference, or another documented invocation site. The Project names one Bootstrap Module by stable Script Module ID.

Script Modules do not autorun. A fresh Project VM synchronously imports only the configured Bootstrap Module; that module may explicitly import other modules by stable ID, and module initialization must finish without yielding before the initial Room/Scene/Dialogue flow begins. Imports are cached once per VM and missing modules/exports, cycles, or failed initialization are hard errors.

A loaded Script Module can opt into **On Game Ready** by exporting `on_ready = function() ... end`. NovelTea runs these handlers after authoritative state exists on initial session creation, reset, and successful restoration. Imported dependencies run first; otherwise handlers use stable Script Module ID order. On Game Ready is synchronous, query-only, and cannot initialize a previously unloaded module. It may inspect authoritative gameplay state and rebuild transient/module-local Lua state, but gameplay mutations and yielding fail. There is no separate effectful New Game Hook.

Conditions and text expressions are synchronous. Effect/explicit script instructions can yield only when their authored invocation is declared yield-capable and the engine admits the corresponding capability profile.

Lua VM/coroutine state is not save-game state. Do not use globals as durable game variables. Persist game state through NovelTea Variables, Properties, desired presentation/audio state, and the other typed runtime APIs below.

## IDs and result conventions

Unless a signature explicitly says otherwise, an `*_id` argument is the stable ID from the corresponding NovelTea record or nested authored object. Pass IDs, not display labels, editor names, file paths, resource URLs, array positions, or generic JSON objects.

Nested IDs are also stable authoring identities: Room exit IDs, Room placement IDs, hotspot IDs, map location/connection IDs, Character pose/expression/idle IDs, and similar arguments must come from the owning record's authored IDs.

Several presentation APIs also accept an author-chosen stable `instance` ID. Reusing the same owner + instance identifies the same desired record for replace/query/clear behavior. Treat these as semantic IDs, not transient counters.

Most typed NovelTea calls use one of these conventions:

```lua
-- mutation
local ok, err = some_mutation(...)
-- success: true, nil
-- failure: false, "diagnostic message"

-- query
local value, err = some_query(...)
-- success: value, nil
-- legitimate absence where supported: nil, nil
-- failure: nil, "diagnostic message"
```

`noveltea.properties.get` is intentionally different because an explicitly present `nil` value must be distinguishable from an unset Property:

```lua
local value, present, err = noveltea.properties.get(owner_kind, owner_id, property_id)
```

`Game.ui.*` and `Game.shell.*` are Layout-event helpers and return plain success booleans (or a direct state table for `Game.shell.state()`), not the `(value, error)` convention.

Runtime scalar values accepted by `Game.set_prop` and `noveltea.properties.set` are exactly `nil`, boolean, finite number/integer, or string. Tables/functions/userdata are not generic persisted runtime values.

## Invocation capability profiles

NovelTea selects capabilities from the invocation site. Code must not assume that every globally visible function is authorized in every context.

| Invocation             | Author-visible authority                                                                                              | Yield?                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Gameplay Script        | All normal gameplay queries and mutations below; definition lookup remains query-only.                                | Yes, when the invocation itself is yield-capable. |
| On Game Ready          | All normal gameplay queries, but no gameplay mutation; intended for rebuilding transient/module-local Lua state.      | No.                                               |
| Synchronous expression | Query-only access to definitions, Properties, Room/Character/Interactable state, Game state, and Text Log state.      | No.                                               |
| Room composition       | Same query surface as a synchronous expression plus the two `noveltea.room_presentation.*` draft visibility commands. | No.                                               |
| Gameplay Layout event  | Normal gameplay queries/mutations plus current `Game.ui.*` Layout input helpers.                                      | No.                                               |
| Shell Layout event     | Narrow runtime capability surface for Save/Game operations plus current `Game.shell.*` shell helpers.                 | No.                                               |
| Tooling/preview host   | Engine/editor-owned tooling profile.                                                                                  | Do not depend on it in shipped game code.         |

A function can therefore exist in the Lua table but fail because the current invocation does not possess that capability, because its capability generation is stale, or because the target is not currently valid. Handle returned errors instead of using API presence as an authority check.

## Host helpers

These helpers are always part of NovelTea's Lua host surface:

```text
noveltea.log(value)         -- write one [lua] diagnostic line
noveltea.echo(value)        -- host string representation
noveltea.lua_version()      -- Lua runtime version string
noveltea.sol_version()      -- bound sol2 version string
```

They are diagnostics/convenience helpers, not gameplay state APIs.

## Project definitions and gameplay identity references

The following look up compiled project definitions by stable ID and return small immutable `summary, error` values:

```text
noveltea.project.scene(scene_id)
noveltea.project.dialogue(dialogue_id)
noveltea.project.verb(verb_id)
noveltea.project.interaction(interaction_id)
noveltea.project.map(map_id)
```

A summary contains `id` and, when available, `display_name`. This is not a generic project-record reflection API.

Rooms, Characters, Interactables, and Features instead use capability-bound identity references:

```text
noveltea.project.room(room_id) -> reference, error
noveltea.project.character(character_id) -> reference, error
noveltea.project.interactable(interactable_id) -> reference, error
noveltea.project.feature(owner_kind, owner_id, feature_id) -> reference, error
```

A reference retains only typed semantic identity (`kind` plus stable `id`; Feature IDs are owner-qualified). It does **not** retain a session, command gateway, or prior invocation capability. Every method resolves through the capability active at call time, so keeping a reference in a module/global cannot preserve stronger authority into a later invocation or replaced session.

```text
reference.kind
reference.id
reference:prop(property_id) -> value, present, error
reference:set_prop(property_id, value) -> ok, error
reference:unset_prop(property_id) -> ok, error
reference:location() -> location, error              # Character / Interactable
reference:set_location(location) -> ok, error       # Character / Interactable
```

`set_prop`, `unset_prop`, and `set_location` fail in read-only profiles such as On Game Ready and synchronous expressions. Room/Feature references intentionally have no Location operation.

## Variables and Properties

Variable is the editor-facing name for a Global Property. At runtime there is one Property system; globals are addressed through `Game` and identity-scoped Properties use the owner-qualified API.

```text
Game.prop(property_id) -> value, error
Game.set_prop(property_id, value) -> ok, error
Game.unset_prop(property_id) -> ok, error
```

A Global Property always has an authored default. `Game.unset_prop` removes only the runtime override and reveals that default again. An explicitly assigned nullable `nil` is a value, not an unset operation.

Identity-scoped Properties on top-level gameplay owners use a closed owner-kind vocabulary:

```text
room
character
interactable
```

```text
noveltea.properties.get(owner_kind, owner_id, property_id) -> value, present, error
noveltea.properties.set(owner_kind, owner_id, property_id, value) -> ok, error
noveltea.properties.unset(owner_kind, owner_id, property_id) -> ok, error
```

Feature Properties use the Feature's stable owner-qualified identity rather than a bare Feature ID:

```text
noveltea.properties.get_feature(owner_kind, owner_id, feature_id, property_id) -> value, present, error
noveltea.properties.set_feature(owner_kind, owner_id, feature_id, property_id, value) -> ok, error
noveltea.properties.unset_feature(owner_kind, owner_id, feature_id, property_id) -> ok, error
```

For Feature calls, `owner_kind` is `room` or `interactable`. Use `unset`/`unset_feature` to remove a runtime override. Do not infer "unset" solely from `value == nil`; inspect the `present` return.

## Character and Interactable location

Character Location is semantic world presence, independent of Room presentation placement:

```text
noveltea.characters.location(character_id) -> location, error
noveltea.characters.set_location(character_id, location) -> ok, error
```

Character Location is one of:

```lua
{ kind = "unplaced" }
{ kind = "room", room = "room-id" }
```

Interactables use the same Room/Unplaced forms and may additionally be contained by an owner-qualified Inventory:

```text
noveltea.interactables.location(interactable_id) -> location, error
noveltea.interactables.set_location(interactable_id, location) -> ok, error
noveltea.navigation.via_exit(room_id, exit_id) -> ok, error
```

Interactable Location is one of:

```lua
{ kind = "unplaced" }
{ kind = "room", room = "room-id" }
{
    kind = "inventory",
    inventory = {
        id = "owner-local-inventory-id",
        owner = { kind = "project" },
    },
}
```

Inventory IDs are local to their owner. The complete owner vocabulary is:

```lua
{ kind = "project" }
{ kind = "character", character = "character-id" }
{ kind = "interactable", interactable = "interactable-id" }
{ kind = "room-feature", room = "room-id", feature = "feature-id" }
{ kind = "interactable-feature", interactable = "interactable-id", feature = "feature-id" }
```

Moving an Interactable into an Inventory derives membership from Location; there is no separate pickup/drop membership state. Room Location does not select a Room placement. Characters render through explicit Room cast entries and Interactables through explicit Room occurrences, so presentation placement can vary or repeat without changing semantic identity Location.

## Flow control

```text
noveltea.flow.start_transient_scene(scene_id)
noveltea.flow.start_transient_dialogue(dialogue_id)
noveltea.flow.call_scene(scene_id)
noveltea.flow.call_dialogue(dialogue_id)
noveltea.flow.replace_scene(scene_id)
noveltea.flow.replace_dialogue(dialogue_id)
noveltea.flow.replace_room(room_id)
noveltea.flow.return_to_caller()
noveltea.flow.end_flow()
```

All are mutation calls returning `ok, error`.

`call_*` starts a child flow that returns to its caller. `replace_*` replaces the current flow target. `return_to_caller` and `end_flow` are explicit tail-flow outcomes. `start_transient_*` requests the corresponding transient flow behavior rather than making the referenced record a permanent implicit entrypoint.

For simple user-facing runtime communication:

```text
noveltea.notify(message) -> ok, error
```

## Room composition-only visibility

These two commands are for Room composition Lua only:

```text
noveltea.room_presentation.set_character_visible(character_id, visible) -> ok, error
noveltea.room_presentation.set_interactable_visible(interactable_id, visible) -> ok, error
```

They mutate only the admitted Room composition draft. Do not use them as a general runtime visibility API; ordinary gameplay scripts should use the appropriate persistent/runtime presentation model instead.

## Deterministic random

```text
noveltea.random.seed(non_negative_integer) -> ok, error
noveltea.random.integer(minimum, maximum) -> integer, error
noveltea.random.number() -> number, error
```

Invalid ranges/seeds fail without consuming a random draw. The generator is session state and is saved/restored.

The normal convenience wrappers are:

```text
math.random()
math.random(maximum)
math.random(minimum, maximum)
math.randomseed(seed)
```

They raise a Lua error if the underlying NovelTea random operation fails.

## Map

```text
noveltea.map.present(map_id, options?) -> ok, error
noveltea.map.hide() -> ok, error
noveltea.map.select(map_location_id) -> ok, error
noveltea.map.activate(map_connection_id) -> ok, error
noveltea.map.state() -> state, error
```

`present` options:

```lua
{
    mode = "minimap" | "full-map", -- optional
    visible = true | false,         -- default true
    focus = "map-location-id",      -- optional
}
```

Successful `state()` returns:

```lua
{
    map = "map-id",
    mode = "minimap" | "full-map",
    visible = true | false,
    focused_location = "map-location-id", -- omitted when absent
}
```

Map activation is validated against the currently presented map/room state; a syntactically valid stale or disabled connection can still fail.

## Layout state

Reserved gameplay Layout slots are exactly:

```text
hud
dialogue-box
overlay
custom
```

```text
noveltea.layouts.get(slot) -> layout_id_or_nil, error
noveltea.layouts.set(slot, layout_id) -> ok, error
noveltea.layouts.clear(slot) -> ok, error
```

Custom mounted Layouts use an author-chosen stable instance ID:

```text
noveltea.layouts.mount(instance_id, layout_id, options?) -> ok, error
noveltea.layouts.unmount(instance_id, options?) -> ok, error
noveltea.layouts.mounted(instance_id, options?) -> state_or_nil, error
```

The common owner selector is:

```lua
{
    owner = "scene" | "session" | "current-room" | "room",
    room = "room-id", -- required when selecting a named room
}
```

For Layout/presentation calls the default owner is `current-room` unless noted otherwise. Scene ownership resolves the nearest active Scene, including while that Scene is blocked in a child Dialogue.

`mount` additionally accepts:

```lua
{
    plane = "world-background" | "world-content" | "world-overlay" |
            "game-ui" | "menu-overlay" | "modal" | "transition" | "debug",
    order = 0,
    clock = "gameplay" | "unscaled-presentation",
    input = "none" | "normal" | "block-gameplay" | "modal",
    pause = "continue" | "pause-while-visible",
    visible = true | false,
    dismiss_on_escape = true | false,
    composition = "world" | "interface" | "debug",
    ui_scale = "inherit" | "ignore",     -- optional
    text_scale = "inherit" | "ignore",   -- optional

    transition = "immediate" | "fade",   -- optional
    duration_ms = positive_integer,       -- required for fade
    skippable = true | false,             -- fade default true
}
```

Defaults are `game-ui`, order `0`, `gameplay`, `normal`, `continue`, visible, no Escape dismissal, and `interface`. `unmount` accepts the owner selector plus the same immediate/fade transition fields.

`mounted()` returns `nil, nil` if that instance is absent; otherwise the state table can contain:

```text
layout
plane
ui_scale       (when explicitly overridden)
text_scale     (when explicitly overridden)
order
clock
input
pause
visible
dismiss_on_escape
composition
```

The returned state describes desired authored Layout state, not an RmlUi document or renderer handle.

## Scoped presentation

Background, actor, prop, and environment APIs use the same owner selector described above and identify authored resources by stable IDs.

### Background

```text
noveltea.presentation.set_background(options?) -> ok, error
noveltea.presentation.clear_background(options?) -> ok, error
noveltea.presentation.background(options?) -> state_or_nil, error
```

`set_background` options can include:

```text
owner / room
asset: Asset ID
material: Material ID
color: color string
fit: cover | contain | stretch | center
```

`background()` returns the currently desired `asset`, `material`, and/or `color` fields that are present.

### Actor

```text
noveltea.presentation.set_actor(instance_id, character_id, pose_id, expression_id, options?) -> ok, error
noveltea.presentation.clear_actor(instance_id, options?) -> ok, error
noveltea.presentation.actor(instance_id, options?) -> state_or_nil, error
```

Actor options:

```text
owner / room
position: left | center | right | custom
idle: Character idle ID
visible: boolean
offset_x, offset_y: number
scale: number
```

The actor query returns `character`, `pose`, `expression`, `visible`, and `scale` for an existing desired actor.

### Prop

```text
noveltea.presentation.set_prop(instance_id, options?) -> ok, error
noveltea.presentation.clear_prop(instance_id, options?) -> ok, error
noveltea.presentation.prop(instance_id, options?) -> state_or_nil, error
```

Prop options can include `owner`/`room`, `asset`, `material`, `plane`, `order`, `visible`, and numeric `x`, `y`, `width`, `height`. `placement_room` and `placement_id` are an optional pair and must be provided together when anchoring to an authored Room placement.

The prop query returns present `asset`/`material` plus `order`, `visible`, `x`, `y`, `width`, and `height`.

### Environment

```text
noveltea.presentation.set_environment(instance_id, material_id, options?) -> ok, error
noveltea.presentation.clear_environment(instance_id, options?) -> ok, error
noveltea.presentation.stop_environments(stop_key, options?) -> ok, error
noveltea.presentation.environment(instance_id, options?) -> state_or_nil, error
```

Environment options can include:

```text
owner / room
asset: optional Asset ID
stop_key: stable semantic stop-group ID (defaults to instance_id)
plane: world-background | world-content | world-overlay
clock: gameplay | unscaled-presentation
x, y, width, height: normalized bounds (defaults 0, 0, 1, 1)
order: integer
scroll_x, scroll_y: number
opacity: number
visible: boolean
```

`stop_environments` removes all matching desired environments for the selected owner. `environment()` returns `material`, optional `asset`, `stop_key`, `order`, `visible`, and `opacity`.

These presentation APIs express engine-owned desired state. They do not expose backend nodes, renderer objects, or animation handles.

## Audio

Audio always takes compiled audio Asset IDs, never file paths. Channel tokens are:

```text
sound-effect
music
voice
ambient
```

Transient playback:

```text
audio.play(asset_id, channel, options?) -> ok, error
audio.play_and_wait(asset_id, channel, options?) -> ok, error
audio.stop(channel, options?) -> ok, error
audio.stop_and_wait(channel, options?) -> ok, error
audio.play_ui(asset_id, options?) -> ok, error
```

Transient play options support `volume` and `fade_ms`. `loop=true` is not a supported transient-loop authoring strategy; persistent Music/Ambient belongs in desired audio below. Stop uses `fade_ms`. `audio.play_ui` is non-awaited, sound-effect-only disposable UI audio and accepts `volume`.

Each `audio.play` creates an independent transient instance. `audio.stop(channel)` stops transient playback on that semantic bus; it does not clear desired persistent loops.

`play_and_wait` and `stop_and_wait` are the standard engine-coordinated yielding operations. Use them only in a gameplay Script invocation that is actually allowed to yield. After accepting the audio request they suspend the current Lua coroutine until that exact operation completes; using them from a synchronous expression, Room composition, or Layout event is invalid.

Persistent desired Music/Ambient:

```text
audio.set_loop(instance_id, asset_id, bus, options?) -> ok, error
audio.set_music(asset_id, options?) -> ok, error
audio.clear_loop(instance_id, options?) -> ok, error
audio.clear_bus(bus, options?) -> ok, error
audio.state(instance_id, options?) -> state_or_nil, error
```

`set_loop`/`clear_*`/`state` use the common owner selector, but default to `session` rather than `current-room`. Desired-audio options support:

```text
volume
fade_ms                 (fallback for both fade directions)
fade_in_ms
fade_out_ms
replacement_key         (stable semantic ID)
owner / room
```

Desired loop buses are Music or Ambient. `set_music` is the single-BGM convenience policy: it uses the reserved `background-music` desired instance/replacement identity on the Music bus.

`audio.state()` returns `asset`, `bus`, `volume`, `fade_in_ms`, `fade_out_ms`, and optional `replacement_key`. Desired audio is reconstructible save state; backend voice/sample position/fade progress is not exposed.

The underlying `audio._play` and `audio._stop` transport helpers are implementation details used by the public wrappers above. Do not author against underscore-prefixed audio functions.

## Text Log

```text
noveltea.text_log.append(kind, origin, text, markup?, speaker_id?) -> ok, error
noveltea.text_log.clear() -> ok, error
```

Closed vocabularies:

```text
kind: line | choice | notification
origin: system                    (the only direct-Lua origin)
markup: plain | active-text       (default plain)
speaker_id: optional Character ID
```

Accepted entries enter the normal typed Text Log/save path. There is no arbitrary rich-RML injection API here.

## General `Game.*` gameplay helpers

These helpers operate on current gameplay state and use typed validation:

```text
Game.continue() -> ok, error
Game.choose(index) -> ok, error
Game.navigate(index) -> ok, error
Game.select_object(interactable_id) -> ok, error
Game.clear_selection() -> ok, error
Game.run_action(verb_id, subjects?) -> ok, error
Game.save(manual_slot_number) -> ok, error
Game.load(manual_slot_number) -> ok, error
Game.autosave() -> ok, error
Game.pause() -> ok, error
Game.resume() -> ok, error
Game.paused() -> boolean, error
```

`Game.choose` and `Game.navigate` are deliberately **zero-based**, despite ordinary Lua sequence conventions. They index the current effective runtime choices/navigation entries, so stale or out-of-range indices fail.

`Game.run_action` subjects use the exact Interaction subject vocabulary:

```lua
{
    { kind = "character", id = "character-id" },
    { kind = "interactable", id = "interactable-id" },
    {
        kind = "feature",
        ownerKind = "room", -- or "interactable"
        ownerId = "room-or-interactable-id",
        featureId = "owner-local-feature-id",
    },
}
```

Feature subjects are always owner-qualified; a bare Feature ID is never a runtime identity. Verb arity and current subject eligibility are still validated. Hotspots are not callable gameplay subjects: pointer geometry resolves to one of these semantic subjects (or a Room Exit) before runtime input is dispatched.

`Game.save`/`Game.load` address manual slots. Autosave has its dedicated `Game.autosave()` operation rather than manual slot `0` semantics.

## Gameplay Layout `Game.ui.*`

Gameplay Layout Lua/event handlers use the current Runtime UI input surface:

```text
Game.ui.continue()
Game.ui.choose_scene(scene_choice_id)
Game.ui.choose_dialogue(dialogue_choice_id)
Game.ui.navigate_room(exit_id)
Game.ui.navigate_map_connection(map_connection_id)
Game.ui.toggle_interactable(interactable_id)
Game.ui.toggle_character(character_id)
Game.ui.clear_selection()
Game.ui.invoke_interaction(verb_id)
```

These return plain booleans. They are validated against the currently published gameplay view, not just ID syntax: hidden/disabled/stale choices, exits, map connections, subjects, or interactions fail. Use these in gameplay Layout event code rather than assuming the general `Game.*` index-based UI conveniences are equivalent.

`Game.ui.navigate_map_connection` is currently part of the provisional `nt-map-view` path; do not treat generated Map markup as a stable custom-component API. See `.noveltea/agent/docs/RMLUI_CUSTOM_COMPONENTS.md`.

## Shell Layout `Game.start` and `Game.shell.*`

Runtime shell documents have their own UI command surface. `Game.start()` starts the game from the shell/title context. The `Game.shell` table contains:

```text
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
Game.shell.save(manual_slot_number)
Game.shell.load(manual_slot_number)
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

Command functions return plain booleans and remain subject to current shell-screen/slot/confirmation authority. In particular, save/load helpers do not make hidden, empty, or invalid slots valid.

`Game.shell.state()` returns a direct read-only table for the current shell view. When available it includes:

```text
screen
game_active
ui_scale
text_scale
status
accessibility.ui_scale.{enabled, minimum, maximum}
accessibility.text_scale.{enabled, minimum, maximum}
slots[]: { autosave, number, occupied, thumbnail_available, play_time_ms?, project_version? }
checkpoint_ready? / checkpoint_retained? / thumbnail_available?
replay_structural_generations? / replay_time_generations? / replay_play_time_ms?
confirmation_prompt?
```

Do not use `Game.shell.*` as a general Script Module shell-control API. It is installed/removed with Runtime UI shell integration and is intended for shell Layout code.

## Yielding rules

Only an engine-issued yield-capable gameplay Script invocation may remain suspended. Synchronous expressions, startup execution, focused preview execution, Room composition, gameplay Layout events, and shell Layout events must complete synchronously.

A direct `coroutine.yield()` in a non-yielding invocation is invalid even though the coroutine library is available. Prefer engine-defined yielding APIs such as `audio.play_and_wait`/`audio.stop_and_wait` so suspension is correlated with an engine operation.

Suspended Lua VM state itself is not serialized. Saving is therefore not a license to suspend on arbitrary private coroutine protocol. Engine-defined waits are the only suspension mechanisms that can participate in runtime flow/save rules.

## Focused preview differences

Focused authoring preview runs candidate code in an isolated environment with its own `_G` and cloned standard/API tables. Failed/superseded candidates are destroyed. Global or nested-table mutations therefore do not leak into a later preview candidate.

Focused preview also admits only the query/mutation subset the editor can safely realize. A call that works in a full gameplay Script may correctly fail in focused preview because the candidate was not granted that authority. Write authored behavior against the documented invocation contract, not against incidental preview internals.

## Do not assume

- No `os`, `io`, `debug`, `package`, `require`, `dofile`, or `loadfile`.
- No arbitrary filesystem paths, renderer/audio backend handles, generic project JSON, or save JSON.
- No implicit Script Module autorun.
- No arbitrary yielding just because `coroutine` exists.
- No future/legacy `Game.*` or `noveltea.*` names beyond those documented here.
- No raw-path audio APIs, deleted audio aliases such as `audio.play_sfx`/`audio.play_track`, or generic bus-control compatibility layer.
- No reliance on Lua globals as persistent save state.
- No assumption that a syntactically valid stable ID is currently authorized or enabled.

When a runtime API call fails, propagate or handle its returned diagnostic rather than silently substituting a guessed compatibility behavior.
