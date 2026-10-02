# Feature Lab capability inventory

Delivery authority for #249 (parent #234), against repository `856cf6310b69464444b20f1363c39b30bedb02e1`, 2026-10-02.
Prerequisite #248 is closed: the owner completed #247 and the reconciliation reports no blocking pilot findings.

## Scope and lifetime

This is the **one-time population plan**, not a second coverage ledger. It specifies the final
scenario/check topology for #250–#258. It does not claim those checks are implemented or tested.
The registered [catalog](../../../tests/projects/feature-lab/assets/data/feature-lab.json) remains
sole authority for **implemented** content, status, instructions, timestamps, asset realizations,
and authored-Test links. Its three existing stations remain usable unchanged during population.

On implementing a station, transfer its remaining rows into catalog checks, validate the Project,
and **remove those rows from this plan**, leaving only a scenario-ID/catalog pointer. Never maintain
parallel status, timestamps, pass/fail history, or test links here. Transfer new asset requirements
only when used; remove their planning rows once all consumers have moved. At #259 certification,
archive the exhausted plan as implementation history and remove active routing links. Generate any
ongoing coverage report from the catalog and authored Tests, not from this document.

The current validator requires a real Room launch for every scenario. Do not create fake home
launches or mark an unbuilt station ready to make inventory rows fit that contract. Population
creates real launch paths. Missing media may permit technically adequate provisional content;
missing scenario implementation is not media provisionality. No catalog/schema change is needed
for this inventory ticket.

### Classification and granularity

- Every row in **Stations** is **Feature-Lab-applicable**: its action/result is the concrete reason
  it has a meaningful playable manifestation. IDs are `scenario-id/check-id`; check IDs are local
  to their scenario, as in the existing validator. These are the final population IDs.
- **Automation-only** below classifies candidates with no useful in-Project manual manifestation,
  including editor-only and build-only surfaces. This classification does not claim existing tests
  exhaustively cover them.
- Owner-deferred Map coverage is explicitly accounted for under **Deferred coverage**, not automation-only
  or ready coverage. Unsupported/deferred roadmap surfaces are excluded at the end.
- A row covers one distinct contract/path, sometimes using a small A/B sample for related variants.
  Do not multiply it by every owner × type × platform × input × locale × transition permutation.
  Host-specific paths (Scene Text versus Dialogue, alpha versus custom Hotspots, retained versus
  deferred save) remain separate. Exhaustive scalar/operator/codec permutations stay automated.
- `S`, `U`, `V`, `A`, `M` mean primary semantic, UI, visual, audio, and manual verification respectively.
  They become the existing catalog verification values; they are **not** promises of new automation.
  Prefer a shared authored flow Test and selected real UI inputs per station. Assert actual state,
  not Lab-only pass flags. Reserve readback for composition/pixels that are themselves the contract.
- Asset keys in the final column refer to **Asset requirements** below. `—` needs only normal authored
  records, text, source files, and built-in UI/fonts. An asset shared by many rows is not duplicated.
- Each station is a short workflow with ordinary Rooms, Scenes, Dialogues, Interactions, and Layouts.
  Lua is used for APIs genuinely under test or exceptional setup, not a generic capability dispatcher.
  Related checks execute inside one session; switching/restarting stations uses fresh-session launch.

## Discovery boundary and evidence

The sweep includes all current authoring families and their runtime projections: Project settings,
Rooms, Characters, Interactable Definitions/Instances, Archetypes, Features, Inventories, Traits,
Properties, Conditions, Gameplay Commands, Verbs, Interactions, Scenes, Dialogues, Maps, Layouts,
Materials, Assets, Script Modules, Messages/localized resources, authored Tests, saves, player shell,
input/display, and host-specific runtime behavior. Editor-only metadata is accounted for separately.

The source set is the current [engine overview](../../engine/OVERVIEW.md) and its component documents,
[Lua API](../LUA_RUNTIME.md), [state/playback](../STATE_AND_PLAYBACK.md),
[UI components](../../ui/RMLUI_CUSTOM_COMPONENTS.md),
[Layout contract](../../engine/LAYOUT.md), [assets](../../assets/OVERVIEW.md),
[text implementation](../../rendering/TEXT_IMPLEMENTATION.md),
[reference presentation](../../rendering/REFERENCE_RESOLUTION_AND_PRESENTATION_SPEC.md), and
[localization certification](../../architecture/certifications/FIRST_CLASS_LOCALIZATION_ALIGNMENT_CERTIFICATION.md).

Code cross-checks, rather than old migration names, bound the inventory:

- `editor/src/shared/project-schema/authoring-scenes.ts`: Event, Stage, structural transaction,
  and terminal unions; `authoring-project-settings.ts`: display, scale, cursor and shell settings;
  `authoring-localization.ts`: Message patterns and locale policy.
- `editor/src/shared/project-schema/authoring-layouts.ts`: current State Shapes are scalar/array/object,
  not every shape mentioned in broader domain vocabulary. `engine/include/noveltea/script/runtime_script_api.hpp`
  and `engine/src/script/lua/bind_runtime_capabilities.cpp` distinguish callable APIs from backend-only
  presentation operations.
- `engine/include/noveltea/core/rich_text.hpp` and `engine/src/core/rich_text.cpp`: supported styles,
  effects, paging and object spans; `tests/runtime/runtime_world_tests.cpp`: exact identities,
  quantity operations, configuration changes and rejection contracts.
- `engine/src/platform/sdl/sdl_cursor_realizer.cpp`, `web/player_pre.js`, `web/shell.html`, and
  `engine/src/platform/sdl/sdl_platform.cpp`: native cursor fallback, browser storage and
  retained-canvas input/resize boundaries.
- The actual Lab catalog, README, four authored Tests, HUD Lua, and `tools/feature-lab/validate.mjs`
  establish what exists today; declarations elsewhere are not evidence of Lab coverage.

The older runtime migration disposition is only a discovery aid. In particular, its old separate
Property persistence families, definition-summary APIs, and direct shader terminology are not the
current contract. Current Properties all save; gameplay references retain identity; Materials own
shader source; runtime video is not supported. Likewise, an authored Asset kind does not imply a
runtime playback backend.

## Stations

### World & Interaction — #250

Transferred to the authoritative Feature Lab catalog in `tests/projects/feature-lab/assets/data/feature-lab.json`.
The implemented stations are `rooms-interactions`, `room-lifecycle`, and `world-composition`. Checks
whose complete inventory behavior lacks a normal authored invocation path remain explicitly `blocked`
in the catalog: `no-room-boundary`, `transition-selection`, `occurrences-and-location`,
`placement-resolution`, and `camera-views`. The catalog records those limitations instead of narrowing
or claiming coverage that the authored station cannot exercise.

### People & Conversation — #251

Transferred to the authoritative Feature Lab catalog in `tests/projects/feature-lab/assets/data/feature-lab.json`.
The existing seven-check `dialogue-presentation` pilot remains the shared Voice/SFX/camera-emphasis
witness. The implemented expansion adds `conversation-paths`, `character-studio`, and `active-text`,
covering the inventory's Dialogue policy/flow, Character presentation/animation, and ActiveText
contracts through ordinary authored records and authored semantic/UI Tests where those are the right
verification layer.

`media-slot-content` remains explicitly `blocked`: the runtime publishes Dialogue Media Slot state,
but the built-in Dialogue UI has no normal image/Character-snapshot realizer yet, so the catalog keeps
the intended contract without substituting a world actor. Cooperative Dialogue Handoff/Scene
`ResumeDialogue` remains intentionally shared with #254's `dialogue-handoff` check rather than being
duplicated here. Automatic Room-description diff generation remains automation-only as classified
below; `active-text/diff-style` covers the supported explicitly authored diff markup.

### Objects & State — #252

Transferred to the Feature Lab catalog on 2026-10-02:

- `inventory-workbench`
- `properties-and-traits`
- `runtime-workshop`

The catalog is now authoritative for these checks. `inventory-workbench/inventory-presentation` records the remaining Project-default-versus-built-in-fallback Layout limitation, `inventory-workbench/containment-context` records the authored-Test limitation around expected cyclic-containment error diagnostics, `properties-and-traits/owner-local-values` records the runtime's current inability to overlap one Property ID between Global and identity-local namespaces, and `properties-and-traits/trait-capabilities` records the remaining runtime-added Trait selector/Condition authority gaps. Interactable hotspot-mode comparison remains intentionally shared with #255 `hotspots-and-cursors/alpha-versus-custom`, and Map projection/navigation for `runtime-workshop/retarget-exit` remains owner-deferred by #252.

### Commands & Discovery — #253

#### `verbs-and-offers` — Choose what to do with a parcel

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `primary-versus-menu` | Primary-activate versus explicitly open the Verb Menu → only unique immediately-complete primary dispatches; missing/ambiguous primary opens the menu. | U | button |
| `offer-specificity` | Exercise explicit/rule-derived exact, prefix, Trait/Definition/reusable-Feature, family and any-subject Offers → most-specific/rank winner governs discovery; false winning Condition suppresses broader fallback. | S | button |
| `discovery-not-authority` | Submit a valid complete command absent from discovery → it still executes; Verb availability still rejects an unavailable command. | S | — |
| `named-slot-builder` | Select world and Inventory subjects for a multi-slot Verb → bindingOrder drives selection, slot names drive execution; the same live subject may occupy two slots. | U | button |
| `builder-rebind-cancel` | Backtrack/rebind, mutate a watched subject, then leave/cancel → Draft reconciliation is Layout-owned and capture ends with ownership; no save-persistent Draft. | U | button |
| `contextual-menu-placement` | Open near viewport edges from pointer and non-pointer selection → captured Trigger Context anchors/clamps the menu independently of later target movement. | V | button |

#### `interaction-rules` — Resolve the delivery request

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `selector-families` | Submit Character, Instance and owner-qualified Feature bindings including runtime-created subjects → selector unions match live identity/Traits/origin Definition, not Archetype ancestry. | S | button |
| `guard-tiers-priority` | Toggle Guards on narrow and broad rules → containment tier precedes priority; false Guard falls through, runtime-dependent equal winners fault without effects. | S | — |
| `fallback-chain` | Decline empty behaviors successively → Verb default, Project fallback then localized engine response; handled work never falls back after a later failure. | S | — |
| `immediate-atomicity` | Execute a mutation group with a deliberately rejected runtime operand → no earlier mutation in that group commits. | S | — |
| `observable-boundaries` | Mutate, notify/respond with acknowledgement, call child Flow, then resume nested If/Else → earlier committed effects survive later failure; cursor/results do not replay. | S | — |

### Stories & Scripting — #254

#### `scene-director` — Stage a short play

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `stage-contexts` | Run inherited, staged-Room and blank child Scenes → staging never moves Current Room or admits staged Hotspots/lifecycle; return restores caller presentation. | S | backdrop, character-pair |
| `scene-text-choice` | Acknowledge Scene narration then choose an option → dedicated Scene Text/Choice roles deliver authoritative branch/effects, not Dialogue choice machinery. | U | — |
| `calls-inputs-outcomes` | Call nested Scenes with typed/default/null inputs and branch on returned Outcome → exact caller resumes; local inputs/results do not leak between invocations. | S | — |
| `terminals` | Exercise Return, Continue Scene/Dialogue, Release to Exploration and Complete Game → correct destination/return ancestry, with completion returning to title rather than an implicit fallthrough. | S | — |
| `dialogue-handoff` | Alternate Dialogue Handoff and Scene ResumeDialogue twice → same suspended conversation resumes; terminating caller discards it without a fabricated Outcome. | S | — |
| `event-order-and-waits` | Run duration/input/Condition waits and completion dependencies on prior finite/audio Events → authored semantic order is preserved despite overlapping realization. | M | sfx |
| `layout-signal-wait` | Submit a declared signal from the requested Layout → exact live Mount wakes the Scene; an unrelated/replaced mount does not. | U | — |
| `scene-gameplay-transactions` | Apply effect batch and structural world transaction, then navigation and Interaction child calls → each uses normal atomic world/command semantics and resumes the same Scene. | S | button |
| `fast-forward` | Skip the play → state mutations occur once, skippable work settles; choice, non-skippable operations and opaque Lua stop progression. | M | sfx |

#### `background-stories` — Run a background clock

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `detached-progress` | Start two background-safe Scenes with duration waits → foreground remains playable and deterministic shared-state effects progress independently. | S | — |
| `detached-owners` | End launching Flow, leave Room, restart → flow-, active-room-, and session-owned branches end at their respective lifetime boundaries. | S | — |
| `detached-fault` | Trigger a runtime error in one background branch → that branch stops with diagnosis; foreground and other branch do not rewind. | S | — |

#### `script-and-data` — Operate a data-driven notice board

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `module-and-ready` | Import a shared module, restart and load → VM-local initialization is once per VM; On Game Ready rebuilds transient state from established gameplay without replaying the entrypoint. | S | — |
| `hook-selection` | Visit Rooms matched by direct/exact, longest-prefix and catchall hooks → only the winning hook extends the lifecycle. | S | — |
| `lua-invocation` | Run a synchronous text/predicate and an explicit yielding effect → text returns its value; only the effect suspends/resumes through an engine-owned wait. | S | — |
| `data-value-trees` | Load JSON in gameplay and Layout, mutate one result, reload → null object members/array slots survive and independent trees never write back to the Asset. | S | structured-data |
| `data-load-rejection` | Ask for an unavailable/wrong-kind data ID through the public API → nil/error is handled visibly and previous board state remains usable; no filesystem escape. | S | structured-data |
| `calendar-versus-gameplay` | Display local/UTC calendar and difftime, pause and restart → wall time stays external to saved/gameplay time; use injected fixed clock in automation, not real-time sleeps. | M | — |
| `saved-random-stream` | Seed, draw, save, draw and reload → next draw repeats from the saved generator; Lua math wrappers share it and rejected ranges consume no draw. | S | — |
| `restart-startup-context` | Dirty state then restart with nested typed startup context → defaults/new VM/Flow/presentation reset; copied immutable context selects the station; preferences and save slots survive without auto-load. | U | — |

### Layouts & Interfaces — #255

#### `layout-counter` — Assemble a reusable control panel

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `documents-fragments-resources` | Mount a document and fragment with shared stylesheet/template, image/font/data dependencies and dedicated/event Lua → resources resolve through declared namespaces; events reach normal gameplay APIs. | U | pattern, font-set, structured-data |
| `mount-inputs` | Change literal, Variable, identity-Property and standard-facet inputs → read-only typed bindings refresh after settled state; invalid update leaves prior mount intact. | S | — |
| `signals-and-children` | Emit typed connected signals, open a contextual child Inventory, then dismiss parent → exact owner receives signals and descendants end with parent; ordinary replacement groups remain distinct. | U | button |
| `mount-lifetime` | Update/hide/show/swap/unmount the same key under Scene, visit, named-Room and session owners → policy-only update preserves occurrence, resource replacement recreates it, ownership cleans up correctly. | U | — |
| `layout-state-scopes` | Commit/clear state then unmount/remount, revisit and return from Flow → visit/room/flow/session Slots hydrate and expire at their own boundaries; transient Lua/DOM is not a Slot. | S | — |
| `state-shape-values` | Commit nested strict objects, arrays and nullable scalar values → accepted shape reconstructs; explicit null survives and invalid value leaves prior state intact. | S | structured-data |
| `show-reconstruction` | Reopen a stateful panel and position from its measured dimensions → inputs/Slot values and laid-out geometry are available at show, without a visible uninitialized frame. | V | — |

#### `menus-and-input` — Layer menus over the game

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `system-role-replacement` | Exercise a mix of project-replaced and built-in title/HUD/pause/settings/text-log/modal roles → declarative data-model callbacks retain behavior without magic element IDs. Save/load, Builder and Scene/Dialogue roles are shared with their stations; role assignments remain Project configuration, not a runtime toggle. | U | backdrop |
| `input-policy` | Click through Normal, BlockGameplay, Modal and input-None mounts at overlapping planes → consumption and gameplay admission differ without accidental world activation. | U | button |
| `pause-sources` | Combine explicit pause, visible pause-requesting Layout and shell modal; remove one source → other pause sources remain, unscaled UI still operates. | U | — |
| `escape-and-shell-stack` | Nest menus/confirmation and use Escape/dismiss/back → top eligible occurrence closes, shell stack resets on load/title and gameplay does not receive consumed input. | U | — |
| `focus-and-controls` | Tab/focus/activate buttons, inputs and scrolling lists → non-pointer control reaches the same actions; hidden/disabled controls cannot activate. Map targets are deferred. | U | — |

#### `hotspots-and-cursors` — Inspect the control board

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `alpha-versus-custom` | Pick transparent holes and custom rectangles on placed sprites → alpha occupancy and analytic custom hits differ as authored; generated highlight masks cover the correct owner union. | U | button, pattern |
| `target-and-priority` | Overlap conditioned targets including inert none, owner, Feature, other subject and Exit → input priority and eligibility choose one semantic path; two regions may select the same Feature. | U | pattern |
| `highlight-policy` | Hover/press/leave alpha and custom Hotspots → highlight policy/Material receives correct bounds/state and does not leak across owners. | V | button, pattern |
| `cursor-arbitration` | Compare Project default/pointer/Hotspot, Definition/custom Hotspot, RCSS auto/default/none/named and gameplay override → centralized priority/fallback and clear behavior agree. | M | cursor |
| `mount-cursor-lifetime` | Set cursor from two ordered Layout occurrences, hide/unmount the top → underlying Mount/session request reappears; input-None visibility still governs eligibility. | M | cursor |
| `image-cursor` | Compare RCSS image cursor with Lua image/hotspot request, including oversized input → declared image dependency, sampling, portable fit and hotspot scaling preserve native-pixel alignment independent of UI scale. | M | cursor |

### Sound & Presentation — #256

#### `materials-engine2d` — Inspect the material samples

Retain `engine2d-draw-texture`, `definition-instance-specialization`, and
`cross-family-worldcontent-order` from the current station. They are distinct rendering contracts,
not disposable pilot scaffolding. Keep their current IDs/history and the real button image; expand
this station rather than creating a second shader-namespace showcase.

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `material-inheritance` | Compare preset, base Material and sparse child overrides → reset exposes inherited values and custom source extends the role rather than replacing engine inputs. | V | pattern |
| `runtime-selection-parameters` | Set/clear Material-wide, Definition and Instance runtime layers → documented selection/parameter precedence is visible; switching away/back restores dormant Material-keyed values. | V | button |
| `property-facet-bindings` | Change typed Property and standard time/size facets → only compatible author uniforms update per occurrence; explicit clearing reveals lower layers. | V | button |
| `texture-specialization` | Compare author-owned texture overrides, clamp/repeat and nearest/linear/inherit draw sampling → author texture changes independently of renderer-owned draw texture. | V | pattern |
| `premultiplied-composition` | Overlap translucent edges over light/dark backgrounds → no dark fringe/double-alpha; textureless Engine2D uses neutral white. | V | pattern |

#### `presentation-effects` — Cue the stage lights

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `local-finite-effects` | Fade background, slide/fade actors, fade/swap Layout → complete target is authoritative; same-target replacement affects only its operation, unrelated targets continue. | V | backdrop, character-pair |
| `grouped-transition` | Cut/Fade/Dissolve a background+actor+WorldOverlay group → one world target transitions together while GameUi/ActiveText/menu/bars remain outside capture. | V | backdrop, character-pair |
| `camera-emphasis` | Apply admitted Dialogue shake/punch/flash cues over a non-default authored Camera View → temporary emphasis leaves desired framing unchanged and obeys wait/skip. The pilot flash is the shared flash witness. | V | pattern |
| `presentation-ownership` | Return from Scene, leave Room and restart with longer-lived background/actor/Prop/environment intent → only the selected owner lifetime removes each record. | S | button, character-pair |
| `active-text-material` | Read nested Material spans with typed overrides → inner Material replaces, not merges, outer occurrence; pagination preserves visible parameters. | V | — |
| `rmlui-decorator-material` | Resize and clip a Material-decorated RmlUi element → decorator texture/geometry inputs and premultiplied blending match its box. | V | pattern |
| `postprocess-scopes` | Stack/replace/clear the same effect at world and full-game-viewport scopes → only full-game affects admitted UI, neither affects bars; order and owner lifetime are visible. | V | pattern |
| `parameter-tween` | Assign/tween a Scene occurrence Material parameter and skip/replace it → logical target survives, transient interpolation does not become saved state. | V | button |

#### `sound-desk` — Mix a short soundscape

The Dialogue station already owns Voice/SFX cue onset; this station exercises other audio contracts.

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `desired-loops` | Layer Ambience and replace Music, then clear exact instance/Purpose → loops coexist or replace only by intended key and reconstruct from start after load. | A | music, sfx |
| `transient-overlap-stop` | Play two one-shots of one Purpose, stop one owner's Purpose → playback is independent and stopping transient sound never clears desired loops. | A | sfx |
| `awaited-audio` | Play/stop-and-wait → Flow resumes on actual completion; disposable UI Sound cannot become a gameplay barrier. | M | sfx |
| `mix-and-duck` | Adjust master/Purpose mix/mute and speak over music → instance gain is independent, optional Voice ducking applies and releases. | A | music, voice |
| `pan-source` | Compare a moving Scene actor and fixed Room Anchor under authored Camera framing → admitted pan source derives stereo position; explicit pan remains separate from semantic Location. | A | sfx, button |
| `audio-owner-pause-skip` | Pause, skip, end Flow/Room and restart → owner/follow-gameplay/unscaled policies, causal/disposable/play-on-skip and cleanup differ as authored, without orphan audio. | A | music, sfx |

### Language, Display & Persistence — #257

#### `localized-story` — Read the same story in another language

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `message-realization` | Switch language for inline/named, managed Lua and nt-tr text with typed arguments → all share formatting; live nt-tr bindings refresh without remount. | U | locale-text, font-set |
| `plural-select-format` | Change count/string selectors in recursive named Messages and Lua helpers → plural categories, exact select/other and locale number formatting select correct realizations. | S | locale-text |
| `message-property` | Select a typed Message-valued Property and realize its opaque reference → dynamic text localizes without treating arbitrary strings as keys. | S | locale-text |
| `locale-negotiation` | Start with a regional preference and switch supported locales with inherited/missing translations → source/default/parent policy and native language labels/font stack are honored. | U | locale-text, font-set |
| `live-causal-text` | Switch during reveal, open choice and Text Log → captured arguments re-realize without rerunning Lua; normalized reveal and locale-positioned cues cross once. | M | locale-text, voice |
| `localized-images` | Switch a semantic image with a translated physical variant and intentional-source mapping → visible replacement is coherent and explicit source stops inheritance. | V | localized-media |
| `localized-audio` | Switch during Voice/Music, then switch again → changed physical stream replaces after text commit, preserves operation/waiter, and stale locale work cannot win. | A | localized-media, voice, music |
| `localized-command-template` | Build a multi-slot command whose translated word order changes → named bindings and selection order remain stable. Shares Builder behavior, tests localization only. | U | locale-text |
| `system-message-overrides` | Open built-in menus and undefined response in two locales → engine defaults and Project overrides share Message realization; no private string catalog. | U | locale-text |

#### `display-and-accessibility` — Resize the reading room

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `fitted-viewport-input` | Resize to wide/tall and HiDPI outputs, click edge targets → reference composition remains fixed, half-open bars reject input, world/UI Hotspots align. | V | pattern |
| `ui-text-scale` | Independently change UI and text scales → policy ranges clamp, disabled scale is 1, WorldOverlay/screen-space inheritance differs; world positions are unchanged. | U | font-set, pattern |
| `layout-scale-media` | Compare inherit/ignore mounts and responsive RCSS → intended reference/media-query environment changes, not an accidental host-DPR layout reflow. | V | — |
| `native-ui-raster` | Inspect text over enlarged world output → UI/ActiveText stays native-resolution and clipped to fitted viewport; Project capped/native world policy comparison is a build-profile check below. | V | pattern, font-set |

#### `save-and-resume` — Put the story down and return

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `retained-versus-deferred` | Save during causal reveal/finite/audio work, then request autosave → manual writes retained boundary; deferred waits for next eligible one, never a forced unsafe snapshot. | S | voice |
| `world-round-trip` | Save dirty Properties/Traits/quantities/Locations, runtime-created/configured Instances and random stream → exact logical state/allocator returns with no identity reuse. | S | button |
| `flow-round-trip` | Save at Scene wait, Dialogue choice/Handoff, nested effect or rejection continuation and detached timer → exact logical cursor resumes without repeating completed mutations/cues/hooks. | S | — |
| `presentation-reconstruction` | Restore desired actors/loops/Material state and stateful Layouts → semantic intent/Slots reconstruct, finite phases/one-shots/Lua VM/DOM do not replay or persist. | M | character-pair, music |
| `locale-independent-save` | Save in one locale and load in another → semantic text/choice/log arguments realize in current preference; checkpoint does not restore language. | U | locale-text |
| `slot-menus-thumbnail` | Save, overwrite with confirmation and select/load slots → metadata and fitted-game thumbnail correspond to persisted checkpoint; unrelated later frame cannot overwrite it. | U | backdrop |
| `restart-preferences` | New game/restart after saving and changing volume/scales/locale → slots/preferences remain, gameplay defaults return, pause/menu stack reset, no implicit load. Shared restart path with script station. | U | locale-text |

### Edge Cases & Host Behavior — #258

#### `runtime-diagnostics` — Reject an intentional bad request

Keep errors opt-in with an explicit recovery/restart control. Normal successful checks elsewhere
already cover expected navigation, quantity, Trait/configuration and Interaction rejection; do not
copy them here.

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `script-fault-and-authority` | Opt into a runtime Lua error, forbidden mutation from a pure context and invalid immediate yield → attributed diagnosis, no leaked mutation and no falsely advanced Flow cursor. | S | — |
| `stale-identity` | Retain a reference, destroy its Instance, then query/use it → explicit stale/missing result rather than a new object or old authority. | S | button |
| `handoff-without-caller` | Run Handoff in a directly entered Dialogue → warning and ordinary continuation at the advanced cursor, not a stranded invocation. | S | — |
| `failure-commit-boundaries` | Fail pre-commit Room work, post-commit work and a later Scene Event → source, committed target and earlier Events are respectively preserved; restart recovers. | S | — |
| `debug-console-trace` | In a devtools build, emit Debug severities/print and diagnose workshop pointer routing → Console/Trace/Snapshot explain the causal path; ordinary player Debug calls are harmless. An authored debug-overlay role, if used, needs an explicit Layout (no built-in fallback); do not emulate developer tools in gameplay. | M | button |

#### `host-behavior` — Check the actual player

These checks use the same Project packaged for the named host, not per-platform copies of every
scenario. Prerequisites belong in check descriptions. No privileged in-game host hooks.

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `web-resize-pointer` | In Web, grow then repeatedly shrink/resize the canvas and click landmark targets → retained backbuffer does not flicker/reset on in-capacity resize or offset mouse/touch input. | M | pattern |
| `web-persistent-storage` | In a storage-enabled browser, save/change settings, wait for persistence, reload → namespace-scoped IDBFS returns slots/preferences; private/quota failures are diagnosed, not claimed durable. | M | — |
| `touch-versus-pointer` | On Android/touch Web, tap subjects and focus semantic controls → primary activation works without hover; explicit menu controls remain usable without right-click. | M | button |
| `native-cursor-fallback` | On cursor-capable desktop/Web, compare named/system cursors and a platform rejection → native fallback leaves gameplay usable; cursorless touch is not a missing hover failure. Forced API rejection remains automated. | M | cursor |
| `host-suspension` | Background/resume the packaged player with timed/audio work → platform pause admission composes with explicit/menu pause rather than clearing it; no burst of queued input. | M | music |
| `packaged-entry-and-display` | Launch packaged Lab cold, enter play, toggle available fullscreen/window output → real title/Start and host display work; packaging identity/signing itself remains automation-only. | M | backdrop |

### Stress & Extremes — #258

#### `stress-content` — Deliberately heavy content

Never run on ordinary launch. Require an explicit warning, reset/exit route, disclosed counts/sizes,
and generated synthetic content rather than more curated media. These are separate checks, not
promises of arbitrary speed or fixed FPS. Automation benchmarks own exact budgets.

| Check ID | Action → observable contract | Mode | Assets |
| --- | --- | --- | --- |
| `long-text-and-log` | Explicitly open long mixed-script/paged text and a large log → navigation/reveal/scroll remains usable and bounded; no corrupt clusters or stuck continuation. | M | stress-text, font-set |
| `many-subjects` | Generate many Instances/Hotspots/Inventory rows → picking still selects exact identity, scrolling/focus works and restart clears generated gameplay. | M | button, pattern |
| `concurrent-owners` | Start many admitted detached waits, layered mounts and audio/finite operations, then cancel owner/restart → cleanup leaves no input capture, sound or stalled Flow. | M | sfx |
| `asset-pressure` | Navigate among deliberately large generated images under a disclosed low-memory export profile → mandatory presentation remains coherent, loading is visible and speculative misses do not alter gameplay. | M | stress-images |
| `extreme-view-and-scale` | Use narrow/large/HiDPI output and maximum permitted text/UI scale → clipping, scrolling, input projection and recovery remain correct; no extra ordinary media needed. | V | pattern, font-set |

## Deferred coverage

**Maps — owner-deferred from this Feature Lab expansion.** The owner considers current Map
implementation too immature for useful Lab acceptance/reference checks. This is an explicit scope
deferral, not a claim that Maps lack a manual manifestation, are automation-only, or are covered.

Do not implement the proposed `map-navigation` station (topology projection, visibility/actionability,
polygon picking, independent minimap/full-map state or explicit Map-state persistence). Also defer
Map-specific Lua/Layout activation, semantic focus targets, exit-retarget projection, platform cases,
large-Map stress and Map-specific assets. No surrogate Lab controls or placeholder checks are needed.
Existing engine/Map tests and implementation are unchanged; this decision does not delete them or
request new Map automation.

#252 retains ordinary Room exit retargeting; #255 retains non-Map Layout/UI/custom-element work;
#258 retains non-Map subject/input stress. #259 must report Map coverage as owner-deferred and must
not block certification on it. Ordinary Room exits, navigation and lifecycle remain in scope.
Revisit Map Lab coverage only after the owner explicitly reopens it when the implementation is mature
enough for meaningful checks; reassess topology/IDs/assets then rather than freezing unbuilt checks.

## Automation-only candidates

Each row is explicitly **automation-only**. A representative observable consequence may already be
assigned above; this section excludes the internal or tooling mechanism, not that consequence.
Use existing suite boundaries, never invent a native-test stable-ID registry for the inventory.

| Candidate family | Concrete exclusion reason and natural verification boundary |
| --- | --- |
| Workspace/schema versions, parsing, strict unions, stale references, malformed Project/compiled/save/package data | Invalid content cannot be a canonical playable station. Validate/compiler/decoder and malformed-fixture suites own rejection, including historical-shape rejection. |
| Editor entity creation/rename/delete, undo/redo, graph/timeline/Hotspot Focus editing, previews, Problems, localization review/exchange, import/reimport and ComfyUI | Editor-only workflows are not observable through an authored runtime Project; use editor service/component/browser tests. Runtime results of their valid content are assigned above. |
| App identity, icon/launch asset generation, signing, templates, export profile resolution, asset pruning/compression/transcode, deterministic package/archive and Project round trips | Build/installation artifacts and tooling transactions require package/export/CLI certification, not gameplay UI. Reuse Lab as input without adding an in-game packaging station. |
| Authored Test schema, typed expectation operators, recorder begin/end/undo/replay, semantic/UI driver discrimination and report counts | Acceptance infrastructure is not a gameplay feature to imitate. Test/playback integration exercises the real runtime seam; Lab Tests refer to check consequences. |
| Lab catalog references/timestamps/search/Recent/status derivation and fresh launch dispatcher | Existing Feature Lab validator, contract Tests and owner usability checkpoint are framework coverage; do not list the navigator as a game capability station. General Data/time/restart APIs have explicit checks above. |
| Full scalar/type/operator/matcher combinations, selector containment proofs and malformed named bindings | Exhaustive combinatorics do not add a distinct manual workflow. Core/schema/semantic tests supplement representative state, Offer and resolver checks. |
| Native allocator overflow, ID remapping, stale operation/occurrence tokens, command budgets and reentrancy | Exact boundary values/order/forged tokens are not naturally authored player actions. Runtime/world/Flow/host integration tests prove them; observable stale identity and cancellation remain in Lab. |
| Save byte canonicalization/Save Contract mismatch, write failure/retry and failure-atomic candidate hydration | Corrupt saves and injected storage/realizer failures need isolated stores/load tests. Lab covers valid resume and actual host persistence without shipping broken saves. |
| Lua certification, missing exports, frozen Hook Registry collisions, bootstrap authority, sandbox escape and cyclic/nonpersistable cross-VM values | These are admission/security negatives or internal lifecycle invariants. Script/runtime tests inject them without making a normal Project unlaunchable. Runtime fault/pure-context behavior remains applicable above. |
| Wall-clock DST/range/overflow/format rejection and frozen timezone provider behavior | Host-time variation is not a portable manual expected result. Clock binding tests inject epoch/timezone; Lab demonstrates wall/gameplay separation. |
| JSON parser limits, malformed numeric/UTF-8/JSON data and internal parsed cache identity | Parser/resource tests are the lowest seam; no corrupt data Asset needed. Independent loaded-tree/null semantics remain a playable API check. |
| Request coalescing, worker/finalizer scheduling, cancellation races, reservations/LRU, leases, generation isolation and focused/runtime publication swaps | Internal concurrency/accounting invariants lack a truthful ordinary gameplay UI. Asset/publication tests plus profiler inspection cover them; loading under stress is applicable. |
| Automatic Flow Prediction Index, speculative ranking/horizon/provenance, authored supplemental prefetch hints and Warm budgets | Hints are author-facing optimization intent but have no guaranteed player-visible result. Compiler/predictor/residency tests and editor profiler verify contribution; never add a fake “prefetched” gameplay flag. |
| Native GPU handles, shader reflection/fingerprints/ABI certification, backend binary variants, material interface rejection and asset cache identity | Compiler/binder/readback tests own these internal contracts. All six supported Material roles and visible application/texture/alpha behavior are in stations. |
| Core-only Camera Pan/Focus operations, runtime selection of named Views, automatic `diff_room_description`, and native save-store delete | These implemented lower-level primitives have no current ordinary Scene/Lua/shell authoring route (`authoring-scenes.ts`, `runtime_script_api.hpp`, `bind_runtime_capabilities.cpp`, UI action gateway). Keep core/render/store tests; do not add privileged Lab hooks. Room default Views/Anchors, Dialogue emphasis and explicit diff markup remain applicable. |
| Rich-text parser recovery, every easing alias/equation, atlas packing, glyph-ID registry and font-coverage diagnostics | Exact parser/numeric/resource correctness belongs in core/text tests. ActiveText representative styles/effects, multilingual shaping and real font fallback remain applicable. Internal `test` effect is not a reference showcase. |
| Capped versus native world raster policy; Project reference resolution, disabled scale policy and entrypoint variants requiring Project-wide reconfiguration | One canonical Project cannot switch immutable compile settings per station using ordinary runtime APIs. Use temporary Project variants in display/compile/player tests; the Lab still covers resize and admitted live scale changes. |
| Forced device loss, unavailable audio/font/image backends, cursor API rejection and failed localized-asset publication | Deterministic faults require injected adapters or damaged packages; adapter/host tests own atomic fallback. Real host restrictions and their diagnostics remain manual host checks when encountered. |
| CLDR rule conformance, translation freshness/parent-cycle errors, detached catalog residency and locale-generation races | Combinatorial language/tooling/cache contracts need compiler/MessageRealizer/locale tests. Representative grammar, negotiation, cue remapping and live media switches remain in Lab. |
| Image/audio format decoder permutations, malformed streams, mip generation and export-only SVG/transcode handling | Byte-format admission is an asset/decoder/export contract, not a new gameplay station per extension. Use the minimal image/audio sources above to exercise runtime consumers; add media only when decoded properties select a materially different path. |
| Opaque binary/text/video Asset packaging without an admitted runtime consumer | Exporting bytes does not create an interactive feature. Asset/package tests prove retention/resolution; JSON data, RML/RCSS, images/fonts/audio have real consumers above. |
| CMake/platform ABI, dependency/no-exceptions/no-RTTI policies, sanitizers, coverage reports, Web threading/worker flags and devtools-off symbol stripping | Build/runtime admission and tooling contracts are verified by policy/build/artifact tests, not authored gameplay. No per-build-mode copies of ordinary Lab checks. |

## Asset requirements before curation

The matrix is an **incremental procurement plan**, not a second Asset database. Existing requirement
IDs/realizations live only in the catalog. Keys below are shorthand for transferring requirements;
scenario asset closure will continue to derive from its check references. Reuse media across all
stations. Source code (Lua, shader files, RML/RCSS) is not a request for new media Assets.

| Key | Minimal requirement / distinct path | Reuse or acquisition decision |
| --- | --- | --- |
| `backdrop` | One opaque landmark-rich Room background | Reuse catalog `pilot-room-backdrop`; no new per-Room backgrounds. |
| `button` | One transparent silhouette with inspectable alpha and world/Inventory utility | Reuse `pilot-button-sprite` for Instances, Props, overlap, placement and alpha Hotspots. |
| `character-pair` | Baseline and visibly different expression for the same Character | Reuse `pilot-character-neutral` and `pilot-character-smile`; Profile changes alone do not justify another person. |
| `sfx` | Short distinguishable causal/disposable cue, also usable as a deliberately synthetic Ambience loop | Reuse `pilot-dialogue-sfx`; perceived natural ambience quality is not the contract. |
| `voice` | Short intelligible speech with silence after it for completion/duck checks | Reuse `pilot-dialogue-voice`; do not re-curate the working reference line. |
| `music` | A loop long enough to hear replacement/fade/pause/duck without immediate natural end | Reuse existing `music-loop` Asset record and `assets/audio/music_loop.mp3`; verify loop suitability before ready perceptual acceptance. No second track unless replacement cannot be distinguished by gain/pan/owner. |
| `pattern` | Small synthetic opaque/alpha regions, thin lines, repeated edges, orientation labels and two visibly different texture regions | One generated image can serve fitting, camera, custom Hotspots, author sampler, postprocess and nearest/linear tests. Reuse at different crops/transforms; add a second texture only for replacement distinction. |
| `character-layers` | Minimal synthetic transparent base/overlay and visibly distinct blink/speaking/Gesture frames for two Profiles | Reuse base Character art when feasible; generate simple overlay frames. Required to prove sparse multi-layer composition and finite animation, not a demand for a full curated sprite set. Mark aesthetic claims provisional until deliberately reviewed. |
| `font-set` | License-cleared regular plus real bold/italic faces and a complementary CJK/RTL fallback covering chosen samples | Reuse shipped/test fonts if redistributable and sufficient; add only uncovered face/cluster paths. Real-face selection versus synthetic fallback is a meaningful A/B check; no font per language. |
| `structured-data` | One tiny valid JSON tree with nested object/array, null and scalar values | Generate as synthetic data; reuse for gameplay/Layout loading and shaped state examples. Existing catalog remains its own real data consumer, not a mutable test scratchpad. |
| `cursor` | Asymmetric synthetic cursor image with marked hotspot and a >128-pixel counterpart | Small image and scaled counterpart are justified by native fit/hotspot behavior; use the same art, not two curated cursors. |
| `locale-text` | Small source plus translated samples exercising plural/select, expansion, RTL, CJK and regional fallback | Authored Messages, not an extra data Asset. Reuse sentences across UI/Dialogue/Scene/log; human language review is required for perceptual ready claims. No full Lab translation requirement. |
| `localized-media` | One visibly different same-kind image and one audibly different same-kind voice realization | Derive labeled synthetic image from `pattern`; reuse or record one short second-language reference line. Intentional-source/inherited mappings reuse those resources; no full translated media library. |
| `stress-text` | Generated long mixed-script text and large log/subject counts | Generate on demand in the stress workflow; disclose size, keep default launch small. Not curated reference media. |
| `stress-images` | A small bounded set of synthetic images large enough to exceed the chosen Warm allowance | Separate opt-in stress/export fixture or stress station prerequisites; record actual dimensions/decoded budget and avoid bloating the normal download. No giant curated art collection. |

Machine-checkable requirement properties should stay small (kind, alpha, dimensions where actually
validated); perceptual/linguistic quality is not inferred from file metadata. Acquisition/licensing
checks precede adding any media. Do not rename or replace existing curated files just to remove
“pilot” from internal Asset IDs. No new media is required by #249 itself.

## Pilot reconciliation and delivery

- Keep the workshop as the compact entry station; put comprehensive lifecycle/composition elsewhere
  so the successful pilot does not become a 40-step tutorial. Its real world-pointer sequence remains
  manual until a meaningful pointer/hit-test integration is added; semantic input is not that proof.
- Keep the neutral checkpoint and the seven cue/choice checks in the Dialogue station. Extend
  conversation policy and Character animation in separate coherent workflows, not by appending every
  variation to that line. Do not duplicate Voice/SFX onset checks in the sound desk.
- Keep the Material station's three distinct accepted checks, including the newer cross-family
  ordering witness. World composition expands it to cast/environment rather than repeating it.
- Preserve `created` only for these same conceptual checks; update `modified` when guidance/behavior
  meaningfully changes. New checks receive actual implementation timestamps, not this inventory date.
- Preserve the four working authored Tests. Add stable Test references only when those Tests exist;
  no invented visual checkpoint IDs or copied native suite names as coverage claims.
- #250 owns Room/world checks; #251 people/conversation/text; #252 objects/state/world creation;
  #253 discovery/resolution; #254 Scene/Flow/Lua/data; #255 Layout/input/cursor (Maps deferred);
  #256 audio/presentation/Materials; #257 localization/display/save; #258 intentional diagnostics,
  materially different hosts and stress. Shared checks have one catalog home; owning tickets coordinate
  prerequisites rather than duplicate entries. #259 certifies composition and retires this plan.

## Explicit non-candidates

Do not populate roadmap entries for Layout State Shape Map/Tuple/One Of/Any nodes beyond the current
scalar/array/object schema, runtime video/seek, Live2D, skeletal deformation/lip sync,
3D/spatial-audio simulation, animation graphs, SDF/MSDF/color-emoji rendering, dictionary hyphenation,
Arabic kashida, text editing/caret/selection, or a Lua API for the standalone boxed Text primitive.
Do not invent unsupported controller/accessibility platform integrations merely because a widget has
semantic focus targets; test the admitted input route on the actual host. General OS/IO/network Lua,
JavaScript scripting, old Item Stack/Action/Object APIs, direct authored Shader records, generic JSON
entity mutation, arbitrary render graphs and compatibility import/migration are not current features.

A future admitted capability follows normal development policy: add/update an authoritative catalog
check or justify automation-only at completion. Do not reopen this one-time plan as an evergreen
spreadsheet.
