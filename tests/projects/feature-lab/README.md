# Feature Lab

Feature Lab is NovelTea's canonical in-tree authored acceptance and working-reference Project. It is intentionally an ordinary segmented NovelTea Project: engine/editor features used here must work through the same authoring, validation, compilation, runtime, and Test paths available to user projects.

The Project root is `tests/projects/feature-lab/`; this README lives beside `project.json`. Its authoritative catalog is the registered JSON `data` Asset `feature-lab-catalog`, backed by `assets/data/feature-lab.json`. The persistent Game HUD Layout reads that exact Asset at runtime; do not introduce a second Lua or generated catalog.

## Comprehensive population

The [capability inventory](../../../docs/runtime/plans/FEATURE_LAB_INVENTORY.md) assigns final
stations/checks and minimal asset needs to #250–#258 after the validated pilot checkpoint. It is a
one-time population plan, not implemented coverage: transfer entries into this Project's catalog
and remove the corresponding planning rows as work lands. Do not add fake launch targets for
unbuilt scenarios or maintain a parallel coverage ledger. Map-specific coverage is owner-deferred
until it can provide meaningful acceptance checks; ordinary Room navigation remains in scope.

## Catalog contract

The project-specific validator is `tools/feature-lab/validate.mjs`. It checks stable IDs and references, `ready` / `provisional` / `blocked` statuses, valid UTC calendar timestamps, automation targets, Asset Requirement realizations, and derived scenario metadata. Reference collections must be arrays, including when empty. The catalog inherits Project Workspace Format; it has no independent `schemaVersion`, and the replaced versioned shape is rejected. Automation references resolve authored semantic/UI Tests or stable IDs declared in the manifest's `visualCheckpoints` registry.

`created` is immutable after an entry is introduced. Update `modified` only when the scenario/check's meaningful behavior or acceptance content changes. Pass `--previous <previous-catalog.json>` to validate timestamp history.

Categories, scenarios, and checks use their JSON array order as authoring order. The HUD search includes scenario identity/title/description and child-check identity/title/description/action/expected text. A child-check hit keeps its parent scenario visible. The rolling `Last 24 Hours` view uses the runtime wall clock; `New` is based on `created`, `Updated` on `modified` only when the entry is no longer new, and a scenario's effective modification time is the maximum of its own and its checks' `modified` values.

Asset Requirements describe acceptance intent separately from concrete Asset records. A requirement declares whether its source may be `synthetic` or should be `curated`; each realization points at a current Asset and marks it `placeholder` or `reference`. Placeholder/synthetic assets are acceptable unless a check specifically requires perceptual reference quality.

## Launch and verification

Opening or closing the HUD's Feature Lab panel does not reset gameplay. The catalog presents full-width category headings with each category's scenarios in its own two-column grid; an odd final scenario leaves the second column empty rather than allowing the next category to fill it. Each entire scenario entry is the launch control. Launching one calls `Game.restart(...)` with Feature Lab startup context so it begins from fresh project defaults. The bootstrap module consumes the resolved launch target from that context and routes the fresh session. The persistent `Feature Lab` HUD control reopens the catalog during normal gameplay, while the adjacent `Restart` control restarts the current scenario (or the home session when no scenario is active). In-scenario guidance is rendered as numbered, prominent action steps. Checks may provide a short `guideSubtext` only when a secondary cue materially helps the manual check; the full `expected` text remains acceptance metadata rather than being dumped into the HUD.

The Rooms & Interactions pilot demonstrates authored Room conditions, a Room Feature, an Interactable, a Verb/Interaction state mutation, rejected and successful navigation, a non-Cut Fade transition, destination lifecycle behavior, and typed semantic expectations. The reusable bedroom background provides a real door landmark and wall area; a separate transparent button sprite is placed over the wall switch and uses its own sprite-alpha Interactable hotspot, so clicking and highlighting belong to the visible button itself. In the workshop, click the bedroom door while it is locked, click the red wall button itself, then click the bedroom door again. The locked door remains a normal Room exit hotspot, so the first click reaches authored navigation rejection and the second succeeds after the button Interaction unlocks it. The HUD displays rejection, button, and arrival notifications. The UI Test covers scenario launch, catalog reopening without reset, and fresh re-entry; the world-pointer sequence is exercised manually while the semantic Test covers the same rejection, mutation, and navigation behavior without surrogate HUD controls.

That same pilot is the manual debugger acceptance surface for pointer/Hotspot diagnosis. In a
devtools build, hover the wall button or bedroom door and use the shared Trace plus current Devtools
Snapshot to determine whether the event stopped at reference projection, RmlUi consumption, host
gameplay admission, world hit testing, or Hotspot hover/highlight state. The RmlUi Debugger is useful
for the element/style side of that evidence; it is not a separate routing log. See
`docs/runtime/DEVELOPER_DEBUGGING.md` for the exact evidence sequence and build capability matrix.

The Feature Lab media are reusable reference assets rather than scenario-specific generated placeholders: a WebP bedroom background, transparent WebP button, matched normal/smile Character sprites, MP3 notification SFX, and a spoken MP3 voice line. The Fade remains a manual perceptual check. The registered `music-loop` Asset (`assets/audio/music_loop.mp3`) is now used by Sound Desk and presentation owner checks, not either pilot. Its 3.318-second loop seam awaits listening acceptance; related audio checks are explicitly provisional, not certified by metadata.

The World & Interaction expansion adds two focused stations. `room-lifecycle` exercises source/Exit/target rejection, ordered lifecycle program/Script Hook phases, entry context, child Dialogue flow, and authored transition behavior; `room-lifecycle-flow` and `room-lifecycle-child-flow` are its semantic witnesses. `world-composition` exercises background fit cycling, presentation-space bounds/views, multiple occurrences of one gameplay identity, fallback/explicit placements, a placement-attached Layout, conditional composition, cross-plane order, and authored plus runtime Environment lifetime; `world-composition-flow` verifies the authoritative state changes. The existing `rooms-interactions` station also distinguishes guard-vetoed navigation from directed Room Change. Inventory behaviors that still lack a normal authored invocation path are kept explicitly `blocked` rather than narrowed: `no-room-boundary`, full transition-precedence selection including an explicit request, occurrence Location plus independent visibility/eligibility mutation, dynamic/no-presentation placement precedence, and named camera-view/Focus selection.

The Dialogue & Presentation pilot uses an ordinary Room lifecycle to start a real Dialogue with staged Character presentation, a normal-to-smile expression change, timed flash and notification-sound cues, spoken voice playback, a real runtime Dialogue choice, and a choice effect that mutates authoritative global state. Its semantic Test covers opening/continuation/branch state, while its UI Test advances semantically to the behavior under test and then clicks the real RmlUi choice. The pilot intentionally does not add another GPU/readback fixture: existing focused runtime UI/rendering readback coverage already protects composition mechanics, while these pilot checks exercise the authored-project presentation path manually without adding a redundant GPU golden. Real reference media improve manual perceptual verification but do not by themselves justify another composition-mechanics fixture.

The People & Conversation expansion adds three stations around that pilot. `conversation-paths` exercises conditional/show-once transcript history, disabled versus hidden choices, speaker resolution, Stage Slot mutation, cue skip/barrier semantics, child Scene calls, completion destinations, nested effects, and text-log policy; its semantic and UI Tests cover the stateful and real-choice paths. `character-studio` uses one shared Character in independent Dialogue occurrences to demonstrate Profile/Pose/Expression/Appearance composition, automatic blink/speaking animation, mapped Gesture behavior, shared semantic identity, and reconstructible idle clocks; `character-studio-flow` protects the shared Property/Location contract. `active-text` is the manual/reference station for nested styles, real and synthetic font faces, cluster-safe paging/reveal, effects, wrapped object spans, explicit diff emphasis, and mixed-script shaping/fallback. Its DejaVu Sans and IPA Gothic files are registered Project font Assets with their licenses beside them. The catalog keeps `media-slot-content` blocked because the runtime publishes the authored state but the built-in Dialogue UI does not yet provide a normal image/Character-snapshot Media Slot realizer.

The Objects & State expansion adds `inventory-workbench`, `properties-and-traits`, and `runtime-workshop`. The Inventory Workbench keeps exact Interactable identities visible while exercising direct and nested inventories, independent enabled/visible state, stack creation/split/merge/transfer, aggregate selection, atomic rejection, and owner-qualified Feature state. Properties & Traits covers typed and schema-less Properties, exact owner locality, Instance/Definition/Archetype/Trait fallback precedence, live Trait capabilities, and recursive Conditions. Runtime Workshop exercises Archetype materialization, compiled/effective creation and provenance, structural configuration replacement/clear, live Exit retargeting, and non-cascading destruction. Their semantic witnesses are `inventory-workbench-flow`, `properties-and-traits-flow`, and `runtime-workshop-flow`. `inventory-presentation` remains explicitly blocked for the mutually exclusive Project-default-versus-built-in-fallback Layout branch; `containment-context` records that expected cyclic-containment rejection is emitted as a runtime error and therefore cannot be a passing authored Test; `trait-capabilities` records the current runtime-added Trait selector/Condition authority gaps; and `owner-local-values` records the runtime's current inability to represent one Property ID as both Global and identity-local while its supported Room/Character/Interactable/Feature owner matrix still runs semantically. Interactable hotspot-mode comparison is intentionally shared with the later `hotspots-and-cursors/alpha-versus-custom` station, and #252's Map projection/navigation work remains owner-deferred.

The Commands & Discovery expansion adds `verbs-and-offers` and `interaction-rules`. Verbs & Offers contrasts unique Primary activation with the real built-in Verb Menu, exercises explicit and rule-derived Offer specificity/ranking/suppression, separates discovery from command authority, and drives the named-slot Command Builder with world and Inventory subjects. The `verbs-and-offers-*-ui` tests isolate Primary, explicit/ambiguous Verb Menu, builder submit, and Rebind/Cancel paths in fresh UI runtimes; `verbs-and-offers-flow` covers the semantic Offer and named-binding contracts. Interaction Rules exercises live selector families, containment-tier Guard fallthrough, the full unhandled fallback chain, immediate atomicity, and observable command boundaries. `interaction-rules-flow` covers the green semantic resolver paths. Same-tier priority and equal-winner ambiguity are intentionally shared with the focused native Interaction resolver tests in `tests/script/typed_interaction_execution_tests.cpp`, keeping the canonical Lab free of deliberately ambiguous authoring diagnostics. Rejected immediate mutation and post-observable-boundary failure remain manual station controls because authored Test playback treats their real runtime error diagnostics as failures instead of suppressing them as expected errors.

The Stories & Scripting expansion adds `scene-director`, `background-stories`, and `script-and-data`. Scene Director exercises inherited/staged/blank presentation contexts, Scene-native Text/Choice, typed nested calls and Outcomes, two Dialogue Handoff/ResumeDialogue cycles, waits and Layout signals, gameplay-effect and structural transactions, directed Room change, navigation, and terminal variants; `scene-director-flow` protects the green semantic path. Background Stories runs detached Scene clocks under flow, active-Room, and runtime-session owners; `background-stories-flow` proves concurrent progress and owner cleanup, while the deliberate fault branch stays manual because a real runtime diagnostic correctly fails authored Test playback. Script & Data uses ordinary Bootstrap/Script Module ownership, On Game Ready reconstruction, direct/catchall Hook Registry selection, synchronous predicate/text Lua, an explicitly yielding audio effect, a declared structured JSON Data Asset, local/UTC wall-clock calls, deterministic saved random state, and typed restart startup context. `script-and-data-flow` now exercises save/load directly and verifies that the next random draw repeats after restoration. Qualified-prefix hook competition and fixed-clock calendar assertions remain intentionally shared with focused native tests where the canonical authored Project cannot express the same deterministic target/clock seam.

### Layouts & Interfaces

`layout-counter` mounts four typed documents under Visit, named Room, session and Flow ownership,
plus a hosted fragment. Shared RML/template/RCSS, dedicated and external event Lua, registered
font/image/Data dependencies, shaped nullable state, explicit commits/clears, hide/reopen/replacement,
and a typed signal receiver are working authoring examples. `layout-counter-flow` protects owner
cleanup and projection; `layout-counter-ui` realizes the resources through real catalog controls.
Counter sources use absolute logical URLs for script/template links and rooted encoded image URLs,
so their Asset-backed document location does not accidentally prefix those resources. RmlUi font
families use the registered Asset ID (`dejavusans`), not the font's display name.

`menus-and-input` uses Project HUD/pause replacements alongside built-in title/settings/log/modal
roles. Its policy probe overlaps a world button while keeping blank probe space RmlUi-click-through;
Normal/BlockGameplay/Modal/None therefore distinguish DOM consumption from host gameplay admission.
Controls compose explicit/Layout/shell pause, focus/edit/scroll and inherit/ignore UI/text scaling.
`menus-and-input-ui` protects catalog/board realization, **not shell interactions**: the current
headless UI runner deliberately does not implement shell commands. Shell checks remain playable
manual workflows supplemented by native system-role/action-gateway/stack tests.

`hotspots-and-cursors` uses one synthetic alpha grid for alpha versus analytic regions, inert and
conditioned overlap, shared Features, ordinary Exit routing and a real custom Highlight Material.
Its explicitly selected contextual Inventory Layout anchors measured dimensions against captured
Trigger Context and parents child Layouts/Inventory independently of source lifetime. A separate
Scene panel demonstrates the no-Trigger fallback; arbitrary Scene SetLayout does not opt into
activation geometry. Two small synthetic cursor resources demonstrate
RCSS/Lua/native fitting, marked source hotspots and ordered Mount cursor lifetime. Their original-art
provenance and dimensions are documented in `assets/images/UI_SAMPLES.md`.
`hotspots-and-cursors-ui` realizes the board and pointer-less popup and clicks both source-removal
controls, asserting their authoritative Locations. Semantic Primary setup is not a pointer-picking
witness. Picking, hover/press appearance and native alignment retain complementary player/native
verification.

Native sandbox smoke rendered all three stations and exercised Slot commit/rejection through host
pointer input. A fresh player recheck through the real catalog accepted the custom board's transparent
center and opened contextual Inventory with captured pointer geometry. Removing that source and
rereading preserved the snapshot; a contextual child inherited it, and parent dismissal removed both
panels. No runtime warnings/errors occurred in these corrected paths. The prior
`host.input.hotspot_target_rejected` and `radio-operator` prediction diagnostics did not recur. This
focused check is not certification of every badge/priority/Exit or platform-cursor permutation; those
remain the catalog's manual/native workflows. The Project HUD hides its story-text panel in the two
board-only stations so it does not cover their world controls; instructions remain in the
catalog/boards.

Catalog category shortcuts bring later categories into the viewport without making Tests click
clipped entries. Their stable selectors are `runtime_game #feature-lab-category-<category-id>` and
`#feature-lab-category-all`; scenario selectors retain `#feature-lab-launch-<scenario-id>`.
`runtime_game #lab-shell-pause` opens the real shell, and the Project pause replacement owns
`runtime_pause_menu #lab-pause-{resume,settings,log,save,load,title}`. Other authored controls have stable RML IDs in their sources. Authored UI Tests address a uniquely
realized custom Mount with `uiClick.mountInstanceId` plus that stable selector; generated realization
document counters are internal and must not be frozen into Test data. Stateful multi-scope checks use
real panel controls and native Slot/contract/reconstruction tests rather than Lab-only flags or
private transport. ActiveText/Inventory behavior is shared with existing stations;
localization/display/save detail remains assigned to #257. Maps remain explicitly owner-deferred.

### Sound & Presentation

`materials-engine2d` preserves the original draw-texture, Definition/Instance specialization and
cross-family ordering witnesses. A small upper sampling row compares clamp-nearest, repeat-linear
and repeat-inherit with one shared pattern and one author-sampler replacement. Continue the Scene
for sparse Material inheritance, runtime selection/parameter precedence, dormant values,
Property/time/size bindings and light/dark premultiplied edges. Application overrides still outrank
Material defaults; the extra Prop pair deliberately has no application deltas for the base/child
comparison. Shader source and ordinary authoring records, not private renderer hooks, own these
examples.

`presentation-effects` compares Scene, visit and session lifetimes (background, actors, Prop,
Environment and loops), then runs Dialogue shake/punch over an authored zoomed Stage, independent
finite replacement, one-world-target Cut/Fade/Dissolve, nested paginated ActiveText Materials,
clipped RmlUi decorators, and world/full-game postprocess replacement/stack/clear. A noncommuting
tint/inversion pair makes same-scope order changes visible. Flash is shared
with the existing Dialogue pilot. `presentation-effects-flow` protects public desired-state queries
across Return and Room leave. A native sandbox entry smoke exercises the initial realization, not
all later pixel contracts.

`parameter-tween` now has an authored end-to-end witness in `materials-engine2d`: the Scene creates
a preset `postprocess-tint` occurrence, tweens `u_tint`, replaces the same finite operation, and the
UI Test uses semantic `fast-forward` to exercise the skippable path. Test preparation compiles shader
sources before Scene validation, canonical color values lower to the compiled object form, and the
native shader-material decoder accepts the canonical RGBA tuple representation. The same Test path
also admits preset-only `system:/` shader binaries without treating them as project package entries.
The decorator therefore uses the ordinary preset-only `rmlui-decorator` Material with no project-owned
shader-source workaround.

`sound-desk` layers desired loops, replaces Music by gain, clears exact instance/Purpose, overlaps
and stops transient one-shots, awaits audio completion, mixes spoken Voice, compares explicit and
actor/Anchor pan, and demonstrates pause/skip/owner policy. Project Voice ducking is enabled at 0.5
for Music/Ambience. Music/Voice/Ambience exercise streaming (including looping); SFX/UI Sound exercise buffered
one-shot playback. Asset reuse does not change the Purpose-selected preparation path. No new media or codec-permutation assets are needed.
The 3.318-second Music clip remains provisional pending human seam audition; no headless result
claims audible quality, backend completion, decoder position, stereo pan or orphan-sound proof.
`mix-and-duck` retains a second explicit gap: Project mix/mute settings exist, but current shell and
normal Lua expose no interactive master/Purpose controls. Voice duck/release is playable; instance
gain is not a substitute for that missing authoring surface. Desired reconstruction after
save/load remains a manual listening workflow; `sound-desk-flow` protects exact logical replacement
and clearing, not decoder resumption.

The three new `*-ui` Tests click real catalog category/launch controls and reopen the catalog without
changing the current Room. Their catalog links are **launch witnesses**, not automated visual/audio
acceptance. Use a shader-compiled stereo player for the catalog's later pixel/listening checks.
The category menu is separate from the numbered scenario guide: catalog launches hide the former
and display the latter. Direct Room entry does not supply Feature Lab scenario startup context.

### Interaction coverage policy

Canonical Lab configurations remain validation/diagnostic clean. Supported specificity, Guard
fallthrough, and fallback belong in green authored Tests; deliberately disjoint, statically
unreachable/dominated, or unconditional equal-tier/equal-priority configurations belong in focused
validation/native negative tests. Runtime-dependent ambiguity is not necessarily statically provable,
but error-emitting cases still need a negative executable seam: authored Test diagnostic expectations
do not convert runtime errors into success. Manual controls above remain manual for precisely that
limitation, not as a substitute for available authoritative automation.

The specificity sequence runs the ordinary Quick action between Probe activations, establishing a
distinct authoritative result before each check instead of inheriting a prior successful Probe value.
The equal-specificity rank check expects no Primary execution; `verbs-and-offers-rank-ui` additionally
proves that the lower-ranked non-primary Offer opens a real menu whose Probe action executes. Each
menu UI witness uses a fresh runtime, as do the other isolated interaction UI paths.

Interaction UI Tests use the built-in semantic Verb/slot selectors documented in
`editor/agent-kit/technical/LAYOUTS.md`; no menu position is contractual. Direct `run-interaction`
success proves complete-command behavior, not Offer discovery. Public semantics live in
`docs/public/concepts/interactions.md`, not this inventory.

Useful checks from the repository root:

```sh
node tools/feature-lab/validate.mjs --project tests/projects/feature-lab
pnpm -C editor noveltea -- --project ../tests/projects/feature-lab validate
pnpm -C editor project:compile -- --project tests/projects/feature-lab --output /tmp/feature-lab-compiled.json --json
build/cli/linux/noveltea --project tests/projects/feature-lab test run
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run room-lifecycle-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run world-composition-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run dialogue-presentation-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run dialogue-presentation-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run conversation-paths-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run conversation-paths-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run character-studio-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run active-text-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run inventory-workbench-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run properties-and-traits-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run runtime-workshop-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run scene-director-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run background-stories-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run script-and-data-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run layout-counter-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run layout-counter-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run menus-and-input-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run hotspots-and-cursors-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run sound-desk-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run presentation-effects-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run materials-engine2d-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run presentation-effects-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run sound-desk-ui
```

The bare `test run` command is the normal automation/acceptance entry point. It executes the complete
lowered authored suite through the shared native suite runner and returns nonzero when any executed
Test is `failed` or `error`; `blocked` Tests remain visible but do not by themselves fail the suite.
With `--json`, use `native.report.counts` and the ordered `native.report.entries` statuses as the
aggregate contract. Individual `test run <id>` commands remain useful for diagnosis and retain the
complete playback report for that Test.

Earlier full-suite runs encountered a native UI-worker SIGSEGV and a stalled invocation, including
on unchanged-baseline Project source. During #256 verification the worker instability recurred:
`verbs-and-offers-rank-ui` aborted once and later crashed alongside `verbs-and-offers-ambiguity-ui`.
No authored expectation failed in those runs; the workers failed to return a response. A targeted
rank recheck, an isolated unchanged-baseline 29-Test suite, and the final expanded 34-Test suite
passed. This intermittent failure remains undiagnosed; a green rerun is not a crash fix. The native file-backed Layout
playback fixture also passes after the resource/addressing changes. The native runner bounds each
worker to 120 seconds and retains its request/response evidence directory when no valid response is
produced; use that path if a failure recurs rather than weakening authored expectations. The separate
editor decoder recovery test still fails in broader verification; distinguish that editor-wide
baseline gate from the green authored Project suite.

Standalone release certification copies this Project to an isolated temporary workspace, runs the
bare suite from a cold cache, verifies the aggregate result, then runs a targeted Test from the shared
cache. Manual Feature Lab inspection remains complementary for visual/audio quality; it is not needed
to infer whether the authored automation suite passed.

The same release certification also uses this Project as the resident-authoring performance reference.
After resident admission it changes one existing Room record seven times and validates after each edit;
the final scheduler architecture must stay at or below 75 ms median and 100 ms p95 on the documented
development benchmark path. The gate also verifies useful-work counters so the timing cannot hide a
whole-Project semantic rebuild. Larger scaling coverage is generated from a temporary synthetic Project
rather than adding benchmark-only gameplay content to Feature Lab.
