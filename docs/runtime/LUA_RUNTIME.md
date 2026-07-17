# Lua Runtime

## Direction

Lua is the only runtime scripting language. `ScriptRuntime` owns the sandboxed Lua VM; OS, IO,
debug, package loading, `require`, `dofile`, and `loadfile` are unavailable by default.

Lua source remains opaque to the TypeScript authoring compiler after structural validation. Native
Lua certification runs for preview/export readiness and again during compiled package load. Invalid
inline or asset-backed Lua prevents publication/session construction and reports structured
diagnostics without executing the script.

## Gameplay Gateway

`RuntimeScriptApi` is the sole public authored-script and Layout-event gameplay gateway. The active
execution kernel owns a `runtime::RuntimeCommandGateway`, and `RuntimeScriptApi` adapts only the
engine-issued `RuntimeCapabilitySet` admitted for the current invocation. Bindings accept stable
strong IDs and typed values, then return explicit success, failure, or yield outcomes. Missing,
disallowed, and stale capability generations fail without dereferencing replaced runtime state.

The gateway covers approved runtime behavior such as:

- typed variable/property reads and writes;
- room, scene, dialogue, and interaction requests;
- interactable location/inventory changes;
- presentation, layout, transition, and audio requests;
- typed view/query helpers and user communication;
- script invocation/yield continuation through owned flow handles.

The current capability surface includes:

- `noveltea.random.seed`, `noveltea.random.integer`, and `noveltea.random.number`; Lua's
  `math.random` and `math.randomseed` are wrappers over the same saved session generator;
- `noveltea.map.present`, `hide`, `select`, `activate`, and `state`;
- `noveltea.layouts.get`, `set`, and `clear` for reserved gameplay Layout slots;
- `noveltea.layouts.mount`, `unmount`, and `mounted` for stable custom gameplay Layout instances;
- `noveltea.presentation.set_background`, `clear_background`, and `background`;
- `noveltea.presentation.set_actor`, `clear_actor`, and `actor`;
- `noveltea.presentation.set_prop`, `clear_prop`, and `prop`;
- `noveltea.presentation.set_environment`, `clear_environment`, `stop_environments`, and
  `environment` for scoped, reconstructible long-lived visual modes;
- `Game.pause`, `Game.resume`, and `Game.paused` for semantic gameplay pause;
- `audio.play`, `audio.play_and_wait`, `audio.stop`, and `audio.stop_and_wait` for transient
  playback;
- `audio.play_ui` for explicitly disposable UI-only sound;
- `audio.set_loop`, `audio.set_music`, `audio.clear_loop`, `audio.clear_bus`, and `audio.state` for
  scoped reconstructible desired audio;
- `noveltea.text_log.append` and `noveltea.text_log.clear`.

Mutation functions return `ok, error`. Query functions return `value, error`; a legitimate absent
value is represented by `nil, nil`. Stable project IDs are used instead of file paths, resource
aliases, indexes, or generic JSON records.

Scoped presentation owner options select `scene`, `session`, `current-room`, or a named `room`.
Scene ownership resolves the nearest active Scene frame, including while that Scene is blocked in a
child Dialogue. Reusing the same owner and stable instance ID deterministically replaces one desired
record; exact clear/unmount calls remove that record.
Matching query helpers return the authoritative desired record or `nil, nil` when it is absent.

`noveltea.layouts.mount(instance, layout, options)` carries a typed Layout ID plus plane, local order,
clock, input mode, gameplay-pause policy, visibility, Escape dismissal, and composition group. The
closed decoder accepts only the declared policy vocabulary. Mount and unmount may additionally admit
a non-awaiting fade through `transition='fade'`, positive `duration_ms`, and `skippable`; runtime
allocates the canonical operation ID and routes the operation through the presentation coordinator.
The API cannot expose an RmlUi document, renderer object, backend handle, or arbitrary
completion-operation ID. Mounted intent is saved and reconstructed through the existing presentation
snapshot path; transient fade progress is not.

Background, scoped actor, prop, environment, custom Layout, and desired-audio calls all use the same
typed owner model and `RuntimeCommandGateway`. `set_environment` additionally accepts an optional
image Asset, deterministic `stop_key`, normalized bounds, world plane/order, gameplay or
unscaled-presentation clock, UV scroll rate, opacity, and visibility. `stop_environments` removes
every matching stop key within the selected owner. Layout-event Lua uses the same semantic surface.
These APIs select engine-owned desired behavior; they do not run an endless Lua coroutine or expose
backend handles.

There is no dispatcher-backed second `Game.*` implementation. `GameBinding`,
`bind_game_session`, `bind_runtime_host`, `bind_runtime_command_dispatcher`, generic entity
tables, arbitrary save JSON access, and `RuntimeScriptExecutor` were deleted during the completed
typed-runtime capability cutover.

## Invocation and Yielding

Runtime execution invokes scripts only through `runtime::ScriptInvocationPort`. The Lua
`ScriptRuntime` adapter owns coroutine/backend state, while the execution kernel owns Flow blockers
and capability selection. Resume and cancellation require the exact invocation handle and matching
Flow owner. Suspended invocations also retain the exact capability profile and generation that
started them; mismatched resume authority fails without advancing or discarding the coroutine, and a
non-yielding profile cannot start a yield-capable invocation. Opaque Lua suspension is distinct from
engine-defined input, duration, presentation, audio, and child-flow waits. Cancellation and stale
handles return explicit errors.

Script errors use `core::Result<..., ScriptError>` with stable error categories, chunk/source
identity, message, and traceback. No C++ exception crosses the runtime boundary.

## Audio

Lua audio always uses compiled audio Asset IDs and one of `sound-effect`, `music`, `voice`, or
`ambient`. Transient playback options are `volume` and `fade_ms`; `loop=true` is rejected because
persistent loops are desired state rather than replayable one-shot operations. Stop options support
`fade_ms`. Missing IDs, non-audio Assets, invalid channels/options, or unavailable backend execution
return an explicit diagnostic and do not silently succeed.

`RuntimeScriptApi` routes the request through `RuntimeCommandGateway`, and the active runtime session
produces a typed `AudioOperation`. `RuntimeUI` sends that operation to `RuntimeAudioAdapter`, which
resolves the compiled Asset through the active project and executes it through `AudioSystem`. Lua
closures never capture `RuntimeSession`, `AudioSystem`, an audio backend, an asset loader, or a
filesystem path.

The non-waiting functions return after the operation is accepted. `play_and_wait` and
`stop_and_wait` suspend the current yielding Lua invocation and resume only after the exact
operation ID, flow owner, and script invocation handle complete. Backend failure cancels the
matching invocation with a typed diagnostic. Immediate scripts and synchronous expressions still
cannot yield.

Each `audio.play(...)` call creates an independent transient playback instance. Calling it twice on
the same semantic bus does not interrupt the first sound. `audio.stop(channel)` and
`audio.stop_and_wait(channel)` apply to transient playback instances on that bus; they do not mutate
or silently stop persistent desired loops. Voice and gameplay playback are causal checkpoint
barriers even when they are not awaited. `audio.play_ui(...)` is the separate non-awaited,
sound-effect-only API whose operations are explicitly disposable.

Persistent looping Music and Ambient use `DesiredAudioInstanceId` records:

- `audio.set_loop(instance, asset, bus, options)` upserts one exact Music or Ambient instance;
- `audio.set_music(asset, options)` uses the reserved `background-music` instance and replacement
  key as the convenience single-BGM policy;
- `audio.clear_loop(instance, options)` removes one exact desired instance;
- `audio.clear_bus(bus, options)` removes every desired instance on that Music or Ambient bus within
  the selected owner;
- `audio.state(instance, options)` returns one desired record, or `nil, nil` when absent.

Desired-audio options support `volume`, `fade_in_ms`, `fade_out_ms`, optional `replacement_key`, and
the normal presentation owner selection. The default owner is `session`; Scene, current-Room, and
named-Room ownership are available through the same owner options used by scoped presentation APIs.
Multiple Ambient instances may coexist. Desired records are saved and reconstructed with fresh
backend voices; decoder state, sample position, backend handles, and fade progress are never exposed
or persisted.

Example:

```lua
local ok, err = audio.play_and_wait("door-opening", "sound-effect", {
    volume = 0.8,
    fade_ms = 50,
})
if not ok then
    error(err)
end

ok, err = audio.set_music("courtyard-theme", {
    volume = 0.7,
    fade_in_ms = 500,
    fade_out_ms = 750,
})
if not ok then
    error(err)
end
```

The deleted `audio.play_sfx`, `audio.play_track`, alias helpers, bus controls, and raw-path overloads
are not compatibility APIs.

The standalone `--demo rmlui` sandbox boots a small compiled-project fixture and uses the same
`audio.play(...)` API as a game. It does not install a separate demo-only audio API.

## Determinism, Map, layout, pause, and text log

Random state is owned by `SessionState` and persisted in save format V2. Invalid ranges fail before
consuming a draw. Gameplay pause is session-only: it stops typed flow/time/input advancement before
the next instruction, remains visible in typed UI/debug views, permits control operations such as
resume and load, and is reset by save restoration.

Map activation validates the currently presented Map against authoritative Room exits and queues the
same typed navigation request used by player input. Reserved Layout calls mutate validated runtime
slots; custom Layout calls mutate stable owner-scoped mounted intent with the complete typed policy.
Direct Lua text-log entries require the `system` origin plus a compatible kind and markup; accepted
entries use the normal typed log and save path.

## Assets

Asset-backed chunks resolve through `AssetManager` logical paths. Package validation proves required
script resources exist, then certification loads each referenced chunk without side effects before
the runtime session starts.

## Rules

- Do not add JavaScript or compatibility shims.
- Do not expose arbitrary JSON project/save state.
- Do not capture legacy session/controller/dispatcher pointers in Lua closures.
- Do not capture renderer, audio, platform, or other backend service pointers in public Lua closures.
- Add gameplay helpers through `RuntimeScriptApi` with strong IDs, typed results, and representative
  failure-path tests.
