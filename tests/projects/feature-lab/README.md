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

The Feature Lab media are reusable reference assets rather than scenario-specific generated placeholders: a WebP bedroom background, transparent WebP button, matched normal/smile Character sprites, MP3 notification SFX, and a spoken MP3 voice line. The Fade remains a manual perceptual check. The registered `music-loop` Asset (`assets/audio/music_loop.mp3`) is reserved for future scenarios and is not played by either pilot. Current media checks are ready; use provisional status only for genuine temporary limitations, not to preserve a placeholder demonstration.

The World & Interaction expansion adds two focused stations. `room-lifecycle` exercises source/Exit/target rejection, ordered lifecycle program/Script Hook phases, entry context, child Dialogue flow, and authored transition behavior; `room-lifecycle-flow` and `room-lifecycle-child-flow` are its semantic witnesses. `world-composition` exercises background fit cycling, presentation-space bounds/views, multiple occurrences of one gameplay identity, fallback/explicit placements, a placement-attached Layout, conditional composition, cross-plane order, and authored plus runtime Environment lifetime; `world-composition-flow` verifies the authoritative state changes. The existing `rooms-interactions` station also distinguishes guard-vetoed navigation from directed Room Change. Inventory behaviors that still lack a normal authored invocation path are kept explicitly `blocked` rather than narrowed: `no-room-boundary`, full transition-precedence selection including an explicit request, occurrence Location plus independent visibility/eligibility mutation, dynamic/no-presentation placement precedence, and named camera-view/Focus selection.

The Dialogue & Presentation pilot uses an ordinary Room lifecycle to start a real Dialogue with staged Character presentation, a normal-to-smile expression change, timed flash and notification-sound cues, spoken voice playback, a real runtime Dialogue choice, and a choice effect that mutates authoritative global state. Its semantic Test covers opening/continuation/branch state, while its UI Test advances semantically to the behavior under test and then clicks the real RmlUi choice. The pilot intentionally does not add another GPU/readback fixture: existing focused runtime UI/rendering readback coverage already protects composition mechanics, while these pilot checks exercise the authored-project presentation path manually without adding a redundant GPU golden. Real reference media improve manual perceptual verification but do not by themselves justify another composition-mechanics fixture.

The People & Conversation expansion adds three stations around that pilot. `conversation-paths` exercises conditional/show-once transcript history, disabled versus hidden choices, speaker resolution, Stage Slot mutation, cue skip/barrier semantics, child Scene calls, completion destinations, nested effects, and text-log policy; its semantic and UI Tests cover the stateful and real-choice paths. `character-studio` uses one shared Character in independent Dialogue occurrences to demonstrate Profile/Pose/Expression/Appearance composition, automatic blink/speaking animation, mapped Gesture behavior, shared semantic identity, and reconstructible idle clocks; `character-studio-flow` protects the shared Property/Location contract. `active-text` is the manual/reference station for nested styles, real and synthetic font faces, cluster-safe paging/reveal, effects, wrapped object spans, explicit diff emphasis, and mixed-script shaping/fallback. Its DejaVu Sans and IPA Gothic files are registered Project font Assets with their licenses beside them. The catalog keeps `media-slot-content` blocked because the runtime publishes the authored state but the built-in Dialogue UI does not yet provide a normal image/Character-snapshot Media Slot realizer.

The Objects & State expansion adds `inventory-workbench`, `properties-and-traits`, and `runtime-workshop`. The Inventory Workbench keeps exact Interactable identities visible while exercising direct and nested inventories, independent enabled/visible state, stack creation/split/merge/transfer, aggregate selection, atomic rejection, and owner-qualified Feature state. Properties & Traits covers typed and schema-less Properties, exact owner locality, Instance/Definition/Archetype/Trait fallback precedence, live Trait capabilities, and recursive Conditions. Runtime Workshop exercises Archetype materialization, compiled/effective creation and provenance, structural configuration replacement/clear, live Exit retargeting, and non-cascading destruction. Their semantic witnesses are `inventory-workbench-flow`, `properties-and-traits-flow`, and `runtime-workshop-flow`. `inventory-presentation` remains explicitly blocked for the mutually exclusive Project-default-versus-built-in-fallback Layout branch; `containment-context` records that expected cyclic-containment rejection is emitted as a runtime error and therefore cannot be a passing authored Test; `trait-capabilities` records the current runtime-added Trait selector/Condition authority gaps; and `owner-local-values` records the runtime's current inability to represent one Property ID as both Global and identity-local while its supported Room/Character/Interactable/Feature owner matrix still runs semantically. Interactable hotspot-mode comparison is intentionally shared with the later `hotspots-and-cursors/alpha-versus-custom` station, and #252's Map projection/navigation work remains owner-deferred.

The Commands & Discovery expansion adds `verbs-and-offers` and `interaction-rules`. Verbs & Offers contrasts unique Primary activation with the real built-in Verb Menu, exercises explicit and rule-derived Offer specificity/ranking/suppression, separates discovery from command authority, and drives the named-slot Command Builder with world and Inventory subjects. The `verbs-and-offers-*-ui` tests isolate Primary, explicit/ambiguous Verb Menu, builder submit, and Rebind/Cancel paths in fresh UI runtimes; `verbs-and-offers-flow` covers the semantic Offer and named-binding contracts. Interaction Rules exercises live selector families, containment-tier Guard fallthrough, the full unhandled fallback chain, immediate atomicity, and observable command boundaries. `interaction-rules-flow` covers the green semantic resolver paths. Same-tier priority and equal-winner ambiguity are intentionally shared with the focused native Interaction resolver tests in `tests/script/typed_interaction_execution_tests.cpp`, keeping the canonical Lab free of deliberately ambiguous authoring diagnostics. Rejected immediate mutation and post-observable-boundary failure remain manual station controls because authored Test playback treats their real runtime error diagnostics as failures instead of suppressing them as expected errors.

The Stories & Scripting expansion adds `scene-director`, `background-stories`, and `script-and-data`. Scene Director exercises inherited/staged/blank presentation contexts, Scene-native Text/Choice, typed nested calls and Outcomes, two Dialogue Handoff/ResumeDialogue cycles, waits and Layout signals, gameplay-effect and structural transactions, directed Room change, navigation, and terminal variants; `scene-director-flow` protects the green semantic path. Background Stories runs detached Scene clocks under flow, active-Room, and runtime-session owners; `background-stories-flow` proves concurrent progress and owner cleanup, while the deliberate fault branch stays manual because a real runtime diagnostic correctly fails authored Test playback. Script & Data uses ordinary Bootstrap/Script Module ownership, On Game Ready reconstruction, direct/catchall Hook Registry selection, synchronous predicate/text Lua, an explicitly yielding audio effect, a declared structured JSON Data Asset, local/UTC wall-clock calls, deterministic saved random state, and typed restart startup context. `script-and-data-flow` now exercises save/load directly and verifies that the next random draw repeats after restoration. Qualified-prefix hook competition and fixed-clock calendar assertions remain intentionally shared with focused native tests where the canonical authored Project cannot express the same deterministic target/clock seam.

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
```

The bare `test run` command is the normal automation/acceptance entry point. It executes the complete
lowered authored suite through the shared native suite runner and returns nonzero when any executed
Test is `failed` or `error`; `blocked` Tests remain visible but do not by themselves fail the suite.
With `--json`, use `native.report.counts` and the ordered `native.report.entries` statuses as the
aggregate contract. Individual `test run <id>` commands remain useful for diagnosis and retain the
complete playback report for that Test.

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
