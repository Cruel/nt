# Lua Runtime

## Direction

Lua is the only runtime scripting language. `ScriptRuntime` owns the sandboxed Lua VM; unsafe OS
operations, IO, debug, package loading, `require`, `dofile`, and `loadfile` are unavailable. The only
admitted `os` operations are the wall-clock/calendar subset below.

Lua source remains opaque to the TypeScript authoring compiler after structural validation except
for the managed localization syntax described below. Native Lua certification runs for
preview/export readiness and again during compiled package load. Invalid inline Lua or Project-backed
Lua source prevents publication/session construction and reports structured diagnostics without
executing the script.

### Managed localization calls

Direct `Text.tr(sourceLiteral, args?, metadata?)`, `Text.msg(namedKeyLiteral, args?)`,
`Text.plural(selector, literalCases, metadata?)`, and `Text.select(selector, literalCases, metadata?)`
calls are the one narrow syntax-aware authoring transform. The source analyzer recognizes them
token-wise, so whitespace and comments do not matter, but aliases, constructed source/key
expressions, dynamic named keys, and dynamically constructed plural/select case tables are not
inferred as managed localization. `Text.tr`/selector metadata is a literal table whose `context` and
`note` values are read statically; tooling never executes Lua to discover localization metadata.
`Text.plural` accepts only literal CLDR category branches (`zero`, `one`, `two`, `few`, `many`,
`other`) and `Text.select` accepts literal exact-string branches; both require `other`. These local Lua
helpers intentionally expose one selector, while named Message patterns are recursive and may contain
multiple selectors.

The authoring compiler replaces recognized calls with package-local `Text.__message(messageId, args?)`
references, removes the managed source/key/translator metadata from the compiled Lua payload, and
leaves all unrelated Lua untouched. `Text.__message` is compiler/runtime ABI rather than authored API
and resolves through the canonical `MessageRealizer`. The second argument is exclusively the runtime
Message-argument table; the third `Text.tr` argument is exclusively static translator metadata, and
`nil` may occupy the second slot when only metadata is needed. Literal argument tables are checked
against the Message placeholder contract when their names are statically readable. Runtime values may
be strings, finite numbers, integers, booleans for printable arguments, or the narrower value admitted
by a declared `string`, `number`, `integer`, or `plural-number` argument. Formatting and placeholder
realization happen only in `MessageRealizer`; Lua does not implement locale formatting itself.

Focused Room preview still uses the same narrow managed-call lowering and injects a small
preview-local Message realization shim into its isolated Lua source rather than exposing authored
`Text.tr`, `Text.msg`, `Text.plural`, or `Text.select` at runtime. The shim carries the effective
default-locale Message text/pattern, runtime arguments, exact-select behavior, and plural-category
selection so dynamic selector previews remain representative without requiring a published Compiled
Project. Localization lowering remains a narrow source transform, not a general Lua parser, formatter,
optimizer, or minifier. A causal Dialogue/ActiveText Lua expression is evaluated at the occurrence
boundary; the realized string therefore captures the argument values for that semantic presentation
occurrence instead of becoming a live binding that can change later.

Typed Message-valued Properties expose an opaque Message reference to Lua rather than the authored
semantic key or a localized string. `Text.msg_ref(messageRef, args?)` accepts only that typed runtime
reference and realizes it through the same canonical Message pipeline. Passing an arbitrary string,
including a valid named Message key, is rejected; dynamic localization therefore requires an admitted
Message-valued Property/API result instead of reintroducing string-as-key semantics.

## Gameplay Gateway

`RuntimeScriptApi` is the sole public authored-script and Layout-event gameplay gateway. The active
execution kernel owns a `runtime::RuntimeCommandGateway`, and `RuntimeScriptApi` adapts only the
engine-issued `RuntimeCapabilitySet` admitted for the current invocation. Bindings accept stable
strong IDs and typed values, then return explicit success, failure, or yield outcomes. Missing,
disallowed, and stale capability generations fail without dereferencing replaced runtime state.

The gateway covers approved runtime behavior such as:

- typed variable/property reads and writes;
- Room, Character, and Interactable Gameplay Instance creation, cloning, structural editing,
  provenance inspection, and destruction;
- room, scene, dialogue, and interaction requests;
- interactable location/inventory changes;
- presentation, layout, transition, and audio requests;
- typed view/query helpers and user communication;
- script invocation/yield continuation through owned flow handles.

The current capability surface includes:

- `noveltea.instances.create`, `replace_configuration`, `clear_configuration`, `retarget_exit`,
  `destroy`, and `provenance` for session-owned Gameplay Instances;
- `noveltea.interactables.location`, `set_location`, `quantity`, `create_quantity`, `split`, `merge`,
  `transfer`, `add_quantity`, and exact/definition-filtered aggregate transfer/consume/query helpers
  for checked exact Interactable Instance state;
- `noveltea.random.seed`, `noveltea.random.integer`, and `noveltea.random.number`; Lua's
  `math.random` and `math.randomseed` are wrappers over the same saved session generator;
- `noveltea.map.activate(map_id, connection_id)` for exact Exit-backed Map navigation;
- `noveltea.layouts.get`, `set`, and `clear` for reserved gameplay Layout slots;
- `noveltea.layouts.mount`, `unmount`, and `mounted` for stable custom gameplay Layout instances;
- `noveltea.presentation.set_background`, `clear_background`, and `background`;
- `noveltea.presentation.set_actor`, `clear_actor`, and `actor`;
- `noveltea.presentation.set_prop`, `clear_prop`, and `prop`;
- `noveltea.presentation.set_environment`, `clear_environment`, `stop_environments`, and
  `environment` for scoped, reconstructible long-lived visual modes;
- `noveltea.presentation.set_material_selection`, `clear_material_selection`, and
  `material_selection` for temporary runtime Interactable Material-selection overrides. Selection
  targets are `{kind='interactable-definition', id='...'}` or `{kind='interactable', id='...'}`;
  Instance runtime selection outranks the authored Instance Material override, which outranks
  Definition runtime selection. Clearing reveals the next lower selection without mutating authored
  data or deleting Material-keyed parameter state;
- `noveltea.presentation.set_material_parameter`, `bind_material_parameter`,
  `clear_material_parameter`, and `material_parameter` for typed runtime Material parameter state.
  The temporary target vocabulary accepts `{kind='material'}` for Material-wide state,
  `{kind='interactable-definition', id='...'}` for Definition state, and
  `{kind='interactable', id='...'}` for one concrete Interactable Instance, in addition to the
  existing presentation-occurrence targets. These commands validate against the certified Material
  interface, reject renderer-owned inputs, remain keyed by Material identity while dormant, and
  persist through normal save/checkpoint state;
- `noveltea.presentation.cursor.set`, `set_image`, `hide`, and `clear` for transient cursor intent;
  ordinary gameplay Lua owns the Runtime Session request, while Layout Lua owns a request scoped to
  the exact live Layout Mount occurrence. Visible Mount requests compose by presentation stacking,
  automatically disappear on occurrence replacement/unmount, and temporarily outrank the gameplay
  request without clearing it;
- `Game.pause`, `Game.resume`, and `Game.paused` for semantic gameplay pause;
- `Game.locale()` for the current runtime locale; locale selection is shell/player preference state rather than a gameplay mutation and is not restored from save data;
- `audio.play`, `audio.play_and_wait`, `audio.stop`, and `audio.stop_and_wait` for transient
  playback;
- `audio.play_ui` for explicitly disposable UI-only sound;
- `audio.set_loop`, `audio.set_music`, `audio.clear_loop`, `audio.clear_purpose`, and `audio.state` for
  scoped reconstructible desired audio;
- `noveltea.text_log.append` and `noveltea.text_log.clear`.

Mutation functions return `ok, error`. Query functions return `value, error`; a legitimate absent
value is represented by `nil, nil`. Stable project IDs are used instead of file paths, resource
aliases, indexes, or generic JSON records.

`noveltea.instances.create(kind, source_kind, source_id, options)` accepts `room`, `character`, or
`interactable`. Room and Character creation use `source_kind` values `archetype`, `compiled`, or
`effective`: `compiled` selects an immutable same-kind Project definition, while `effective`
snapshots the current structural configuration of a live Gameplay Instance. Interactable creation
instead requires `source_kind='definition'`, where `source_id` is an Interactable definition ID;
Archetype/compiled/effective sources are reserved for explicit structural replacement. Character
and Interactable creation accepts `room`, `enabled`, and `visible` options; omitting `room` creates
the identity Unplaced. Interactable creation additionally accepts `presentation_none=true` when a
Room Location should intentionally have no resolved occurrence. Creation validates its source and
initial connection before publishing the new identity and advances the deterministic session
allocator only for an admitted allocation.

`replace_configuration` applies a validated structural overlay without changing mutable Location or
ordinary runtime state. `clear_configuration` validates the transition back to immutable birth
configuration before removing the overlay. `retarget_exit` is the targeted Room-topology edit.
`destroy` is non-cascading. Declared Rooms and Characters cannot be destroyed. Declared
Interactable Instances may be destroyed just like runtime-created Interactables; their authored
identity then remains a valid stale/tombstoned identity for references and save restoration rather
than being recreated implicitly. Runtime-created identities remain live while Flow, topology,
Location/Inventory, provenance, or other lifecycle-critical ownership references depend on them.
Room presentation occurrences are not ownership and do not prevent Interactable destruction.
`provenance` reports `declared`, `archetype`, `compiled-definition`, or `clone`, with source
identity/Archetype metadata where applicable.

`noveltea.project.room(id)`, `character(id)`, and `interactable(id)` now return typed gameplay identity references rather than copied definition summaries. `noveltea.project.feature(owner_kind, owner_id, feature_id)` returns the corresponding qualified Feature identity reference. A reference stores only its semantic kind and stable ID(s); methods such as `prop`, `set_prop`, `unset_prop`, `location`, and `set_location` resolve through the `RuntimeScriptApi` capability active at the moment of the call. Retaining a reference in Lua therefore retains identity only: it cannot retain an old command gateway, session object, or prior invocation authority.

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

Gameplay cursor calls are deliberately different from reconstructible desired-presentation records.
`cursor.set(name)` accepts system/semantic cursor names, `none`, or a Project named cursor ID; `auto`
is not a gameplay target. `cursor.set_image(assetId, options)` resolves a stable Image Asset ID and
accepts optional `hotspot_x`/`hotspot_y` source-image pixel coordinates, defaulting to the image
center. Hotspots must remain inside the source image. Dynamic cursor images larger than 128x128 are
fit proportionally to that portable bound without upscaling smaller images, preserve Asset sampling,
and scale their hotspot with the realized image while clamping the mapped hotspot inside the realized
image. Cursor calls are synchronous, non-awaiting presentation intent and never introduce Flow or
checkpoint barriers. Invalid requests leave the caller's prior intent intact. `set_image` issues the
normal asynchronous Asset request and leaves the current effective cursor in place while that request
is pending; readiness replaces it atomically. Terminal Asset preparation or backend realization
failure records a diagnostic, uses the semantic native fallback, and does not fail gameplay or retry a
permanent failure indefinitely.

Outside a Layout callback, the cursor override is owned by the current Runtime Session rather than a
Scene, Room, Dialogue, or other gameplay scope. It therefore survives ordinary gameplay presentation
changes but is cleared when that session ends or is replaced. During Layout invocation, the same API
infers the exact live Layout Mount occurrence instead: its request follows that Mount's visibility and
presentation order and is discarded on unmount or occurrence replacement. Focused Layout previews
issue a cursor-only command capability and execute dedicated Layout Lua under the exact synthetic Mount
occurrence, preserving the same ownership rule without granting unrelated gameplay mutations. In
either scope, `cursor.clear()` removes only the caller's inferred owner and reveals the next eligible
centralized cursor request. Runtime Session and Mount cursor intent plus native cursor realization are transient
host presentation state: they are not serialized into SaveState/checkpoints or gameplay recordings and
are reconstructed only by gameplay/Layout behavior that requests them again.

There is no dispatcher-backed second `Game.*` implementation. `GameBinding`,
`bind_game_session`, `bind_runtime_host`, `bind_runtime_command_dispatcher`, generic entity
tables, arbitrary save JSON access, and `RuntimeScriptExecutor` were deleted during the completed
typed-runtime capability cutover.

## Structured Data Assets

Gameplay and frontend/Layout Lua expose the same `Data.load(assetId)` capability for registered JSON-backed `data` Assets. Resolution is by stable compiled Asset ID through the active Project Asset namespace; the API does not accept logical paths, filesystem paths, arbitrary JSON strings, or non-data Assets. The Project gameplay VM and the stable frontend/RmlUi VM each receive the active Project data-Asset registry, while isolated focused-preview environments receive only the data bindings staged for that preview candidate.

JSON parsing is native and bounded. A successful load converts the parsed value into ordinary Lua scalars/tables and creates a fresh value tree on every call, so mutation cannot leak into the Asset, another call, or another VM. JSON `null` is represented by the stable `Data.null` sentinel so object members and array positions survive conversion. Parse/load failures return `nil, error`; malformed JSON, unsupported numeric values, missing IDs, and unavailable sources fail without granting filesystem access. The API deliberately does not provide general JSON encode/decode functions.

Layout authors should declare JSON data used by a Layout in its explicit data dependencies. Those references participate in validation, focused-preview staging, unused-Asset pruning, and runtime-package inclusion without requiring static analysis of `Data.load(...)` source text.

## Wall-clock and Calendar Time

Gameplay and frontend/Layout Lua share the same restricted `os.time`, `os.date`, and `os.difftime`
bindings. Each `ScriptRuntimeConfig` can borrow a NovelTea
[`WallClock`](../../engine/include/noveltea/script/wall_clock.hpp) through VM shutdown. That provider
owns both epoch sampling and local/UTC calendar conversion, including local-time normalization and
DST policy; injection never changes process-global timezone or locale. Without an override, the
NovelTea system provider uses the host wall clock and timezone. Hosts/tests can supply the same frozen
provider to both VMs; isolated focused-preview environments retain their VM's provider.

`os.time()` (or `nil`) samples integer Unix epoch seconds. The table form uses local calendar time,
requires year/month/day, defaults to noon with zero minutes/seconds, honors the optional DST hint, and
updates the table with normalized calendar fields. `os.date` defaults to the current local time and
`%c`; a leading `!` selects UTC and `*t` returns standard Lua calendar fields (including one-based
weekday and year day). Formatting admits the portable C89-style conversions listed in the
[binding allowlist](../../engine/src/script/lua/bind_wall_clock.cpp), excluding timezone text/offset
conversions (`%Z`, `%z`) and platform-specific modifiers. Literal text, `%%`, and empty formats are
supported. Calendar results are restricted to years 1–9999 and the provider's representable range;
invalid fields, unsupported formats, and conversion failures raise ordinary Lua errors. Like standard
Lua, `os.time` treats an epoch result of -1 as failure. Host textual
formats use the host C locale; deterministic cross-host assertions should use numeric formats or
calendar tables. `os.difftime` returns the signed difference in seconds without integer overflow.

Wall-clock observations are external inputs, not checkpointed session state or elapsed time. Pausing,
advancing, resetting, or restoring gameplay does not advance or rewind the wall clock. Gameplay and
unscaled-presentation clocks continue to drive their existing Flow/presentation behavior independently.
`os.clock` remains unavailable, as before; it is not redefined as wall or gameplay time. No other
standard OS capabilities are installed, including environment access, filesystem mutation, process
execution/exit, temporary files, or locale mutation.

## Invocation and Yielding

Runtime execution invokes scripts only through `runtime::ScriptInvocationPort`. The Lua
`ScriptRuntime` adapter owns coroutine/backend state, while the execution kernel owns Flow blockers
and capability selection. Resume and cancellation require the exact invocation handle and matching
Flow owner. Suspended invocations also retain the exact capability profile and generation that
started them; mismatched resume authority fails without advancing or discarding the coroutine, and a
non-yielding profile cannot start a yield-capable invocation. Opaque Lua suspension is distinct from
engine-defined input, duration, presentation, audio, and child-flow waits. Cancellation and stale
handles return explicit errors.

Before `RuntimeCapabilityProfile::OnGameReady` is issued, the Project Hook Registry is completed and frozen. Direct compiled Room mappings and Bootstrap `hooks.register(...)` mappings use stable Script Module/named-export handlers and typed Room selectors. The native freeze step rejects duplicate selector/kind registrations, unsupported semantic kinds or hook kinds, malformed wildcards, missing modules/exports, and non-function exports; referenced handler modules are imported during this phase. Resolution is exact identity, then longest matching qualified-prefix selector, then catchall. Registry inspection retains source, capability profile, winner, and fallback information. Once frozen, no later invocation—including On Game Ready—may add or replace registrations.

`RuntimeCapabilityProfile::OnGameReady` is a synchronous read-only profile. RuntimeSession issues it only after the candidate/default/restored authoritative kernel exists, runs loaded module `on_ready` handlers, and clears it when the call returns. It admits gameplay queries but no command groups and no yielding. Initial session creation, reset, and successful load all pass through this lifecycle; failures are surfaced as `runtime.on_game_ready_failed` and the candidate kernel is not accepted. The host constructs each new-game, reset, and load candidate with its own fresh Project `ScriptRuntime`/Lua VM; the previously live Project VM remains untouched until the candidate is fully accepted, and is retired only after successful replacement. RmlUi/frontend Lua uses a separate stable VM and is not transplanted during gameplay-session replacement.

Script errors use `core::Result<..., ScriptError>` with stable error categories, chunk/source
identity, message, and traceback. No C++ exception crosses the runtime boundary.

## Focused Room preview environments

`ScriptRuntime` supports isolated environment handles for focused preview. Each candidate receives a
fresh `_G`, environment-local standard/API tables, the same restricted library profile, and
environment-bound load behavior. Failed and superseded candidates destroy their environment, so
globals or nested table mutations cannot leak into the committed owner or a later candidate.

The focused query provider exposes only the candidate-wide union of lexically discovered and explicit
fallback reads. Definition, Variable, property, and Interactable-location queries outside that
admission fail deterministically. Room composition receives a narrower draft-mutation subset for
Character and Interactable IDs while sharing the candidate read environment with conditions, text,
and mounted Layout Lua. Inline and Project-file-backed gameplay composition, dedicated Layout Lua,
event attributes, inline/external scripts, templates, direct-string `AddEventListener`, and direct-string `load` use
this contract. Computed dynamic code and generated RML remain explicit unsupported-analysis cases.

## Audio

Lua audio always uses compiled audio Asset IDs. Audio Purpose is independent from lifetime,
ownership, pause policy, causality, and skip policy; the closed Purpose set is `music`, `ambience`,
`voice`, `sound-effect`, and `ui-sound`. Transient playback options include `gain`, stereo `pan`,
`fade_ms`, `pause_policy`, and `skip_behavior`. Persistent loops are desired state rather than a
transient `loop` option. Missing IDs, non-audio Assets, invalid Purpose/options, or unavailable
backend execution return an explicit diagnostic and do not silently succeed.

`RuntimeScriptApi` routes the request through `RuntimeCommandGateway`, and the active runtime session
produces a typed `AudioOperation`. The engine-owned `RuntimePresentationBridge` accepts and orders
that operation, then `RuntimeAudioAdapter`
resolves the compiled Asset through the active project and executes it through `AudioSystem`. Lua
closures never capture `RuntimeSession`, `AudioSystem`, an audio backend, an asset loader, or a
filesystem path.

The non-waiting functions return after the operation is accepted. `play_and_wait` and
`stop_and_wait` suspend the current yielding Lua invocation and resume only after the exact
operation ID, flow owner, and script invocation handle complete. Backend failure cancels the
matching invocation with a typed diagnostic. Immediate scripts and synchronous expressions still
cannot yield.

Each `audio.play(...)` call creates an independent transient playback instance with an explicit
semantic Owner. Calling it twice for the same Purpose does not interrupt the first sound.
`audio.stop(purpose)` and `audio.stop_and_wait(purpose)` target transient playback of that Purpose for
the same Owner; they do not mutate or silently stop persistent desired loops. Ending the Owner
cancels its transient work and removes its desired audio without transferring ownership. Causal,
awaited, synchronized, disposable, and skip behavior are separate typed dimensions. `audio.play_ui`
is always disposable UI Sound on unscaled presentation time and cannot become a gameplay barrier.

Persistent looping Music and Ambience use `DesiredAudioInstanceId` records:

- `audio.set_loop(instance, asset, purpose, options)` upserts one exact Music or Ambience instance;
- `audio.set_music(asset, options)` uses the reserved `background-music` instance and replacement
  key as the convenience single-BGM policy;
- `audio.clear_loop(instance, options)` removes one exact desired instance;
- `audio.clear_purpose(purpose, options)` removes every desired instance of that Music or Ambience
  Purpose within the selected Owner;
- `audio.state(instance, options)` returns one desired record, or `nil, nil` when absent.

Desired-audio options support `gain`, stereo `pan`, `pause_policy`, `fade_in_ms`, `fade_out_ms`,
optional `replacement_key`, and the normal presentation Owner selection. The default Owner is
`session`; Scene, current-Room, and named-Room ownership are available through the same Owner options
used by scoped presentation APIs. Multiple Ambience instances may coexist. Desired records save
semantic identity, Owner, Purpose, Pause Policy, gain/pan configuration, and loop/replacement intent,
then reconstruct with fresh backend voices. Decoder state, sample position, backend handles, and fade
progress are never exposed or persisted.

Example:

```lua
local ok, err = audio.play_and_wait("door-opening", "sound-effect", {
    gain = 0.8,
    pan = -0.2,
    fade_ms = 50,
})
if not ok then
    error(err)
end

ok, err = audio.set_music("courtyard-theme", {
    gain = 0.7,
    fade_in_ms = 500,
    fade_out_ms = 750,
})
if not ok then
    error(err)
end
```

The deleted `audio.play_sfx`, `audio.play_track`, alias helpers, mixer-bus controls, and raw-path overloads
are not compatibility APIs.

The standalone `--demo rmlui` sandbox boots a small compiled-project fixture and uses the same
`audio.play(...)` API as a game. It does not install a separate demo-only audio API.

## Determinism, Map, layout, pause, and text log

Random state is owned by `SessionState` and persisted in the current save state inside Save File V1. Invalid ranges fail before
consuming a draw. Gameplay pause is session-only: it stops typed flow/time/input advancement before
the next instruction, remains visible in typed UI/debug views, permits control operations such as
resume and load, and is reset by save restoration.

Map activation is stateless presentation-wise: `noveltea.map.activate(map_id, connection_id)` verifies
that the authored Connection currently has an exit owned by the active Room and queues that exact
normal Navigation Attempt. It does not own focus/open/pan/zoom state and deliberately avoids
synchronously evaluating Lua Room guards while already executing Lua; the queued navigation attempt
runs the authoritative guard/rejection lifecycle. Reserved Layout calls mutate validated runtime
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
