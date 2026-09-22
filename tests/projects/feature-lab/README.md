# Feature Lab

Feature Lab is NovelTea's canonical in-tree authored acceptance and working-reference Project. It is intentionally an ordinary segmented NovelTea Project: engine/editor features used here must work through the same authoring, validation, compilation, runtime, and Test paths available to user projects.

The Project root is `tests/projects/feature-lab/`; this README lives beside `project.json`. Its authoritative catalog is the registered JSON `data` Asset `feature-lab-catalog`, backed by `assets/data/feature-lab.json`. The persistent Game HUD Layout reads that exact Asset at runtime; do not introduce a second Lua or generated catalog.

## Catalog contract

The project-specific validator is `tools/feature-lab/validate.mjs`. It checks stable IDs and references, `ready` / `provisional` / `blocked` statuses, valid UTC calendar timestamps, automation targets, Asset Requirement realizations, and derived scenario metadata. Reference collections must be arrays, including when empty. The catalog inherits Project Workspace Format; it has no independent `schemaVersion`, and the replaced versioned shape is rejected. Automation references resolve authored semantic/UI Tests or stable IDs declared in the manifest's `visualCheckpoints` registry.

`created` is immutable after an entry is introduced. Update `modified` only when the scenario/check's meaningful behavior or acceptance content changes. Pass `--previous <previous-catalog.json>` to validate timestamp history.

Categories, scenarios, and checks use their JSON array order as authoring order. The HUD search includes scenario identity/title/description and child-check identity/title/description/action/expected text. A child-check hit keeps its parent scenario visible. The rolling `Last 24 Hours` view uses the runtime wall clock; `New` is based on `created`, `Updated` on `modified` only when the entry is no longer new, and a scenario's effective modification time is the maximum of its own and its checks' `modified` values.

Asset Requirements describe acceptance intent separately from concrete Asset records. A requirement declares whether its source may be `synthetic` or should be `curated`; each realization points at a current Asset and marks it `placeholder` or `reference`. Placeholder/synthetic assets are acceptable unless a check specifically requires perceptual reference quality.

## Launch and verification

Opening or closing the HUD's Feature Lab panel does not reset gameplay. Launching a scenario calls `Game.restart(...)` with Feature Lab startup context so each scenario begins from fresh project defaults. The bootstrap module consumes the resolved launch target from that context and routes the fresh session. The persistent `Feature Lab` HUD control reopens the catalog during normal gameplay; `Fresh Home` deliberately starts a new home session.

The Rooms & Interactions pilot demonstrates authored Room conditions, a Room Feature, an Interactable, a Verb/Interaction state mutation, rejected and successful navigation, a non-Cut Fade transition, destination lifecycle behavior, and typed semantic expectations. The reusable bedroom background provides a real door landmark and wall area; a separate transparent button sprite is placed over the wall switch so placement and hotspot alignment remain independently testable. In the workshop, click **Try Bedroom Door**, then **Press wall button**, then **Try Bedroom Door** again. The door control deliberately submits a normal navigation attempt even while locked so the authored rejection lifecycle runs. The HUD displays rejection, button, and arrival notifications; workshop controls disappear at the destination. The UI Test describes this same click path, including navigator launch, overlay reopening, and fresh re-entry.

The Feature Lab media are reusable reference assets rather than scenario-specific generated placeholders: a WebP bedroom background, transparent WebP button, matched normal/smile Character sprites, MP3 notification SFX, and a spoken MP3 voice line. The Fade remains a manual perceptual check. `assets/audio/music_loop.mp3` is reserved for future scenarios and is not registered or played by either pilot. Current media checks are ready; use provisional status only for genuine temporary limitations, not to preserve a placeholder demonstration.

The Dialogue & Presentation pilot uses an ordinary Room lifecycle to start a real Dialogue with staged Character presentation, a normal-to-smile expression change, timed flash and notification-sound cues, spoken voice playback, a real runtime Dialogue choice, and a choice effect that mutates authoritative global state. Its semantic Test covers opening/continuation/branch state, while its UI Test advances semantically to the behavior under test and then clicks the real RmlUi choice. The pilot intentionally does not add another GPU/readback fixture: existing focused runtime UI/rendering readback coverage already protects composition mechanics, while these pilot checks exercise the authored-project presentation path manually without adding a redundant GPU golden. Real reference media improve manual perceptual verification but do not by themselves justify another composition-mechanics fixture.

Useful checks from the repository root:

```sh
node tools/feature-lab/validate.mjs --project tests/projects/feature-lab
pnpm -C editor noveltea -- --project ../tests/projects/feature-lab validate
pnpm -C editor project:compile -- --project tests/projects/feature-lab --output /tmp/feature-lab-compiled.json --json
build/cli/linux/noveltea --project tests/projects/feature-lab test run
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run dialogue-presentation-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run dialogue-presentation-ui
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
