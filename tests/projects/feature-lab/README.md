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
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run rooms-interactions-ui
build/cli/linux/noveltea --project tests/projects/feature-lab test run dialogue-presentation-flow
build/cli/linux/noveltea --project tests/projects/feature-lab test run dialogue-presentation-ui
```

The four authored Test commands require a native NovelTea CLI/test runner build appropriate to the host. Inspect `--json` output's `native.report.passed`, not just the command exit status or top-level `success`: the current CLI can report command success for a failing playback report.

### Verification gaps

After flattening the Project root and updating media identities, manifest validation (2 scenarios / 13 checks), all 35 CI tests, normal Project validation/compilation, and the editor check passed. The editor suite passed on rerun (1,938 passed / 5 skipped) after an unrelated ComfyUI menu-test failure. All four authored Tests were rerun with the existing native CLI; their playback reports still fail for the gaps below. Manual visual/audio acceptance was not repeated for this path/identity cleanup.

The review fixes were exercised through a packaged Project in the Linux sandbox: navigator launch, locked-door rejection, button activation, successful navigation, and the destination notification. This does not certify the authored runners. Current follow-ups remain:

- `tools/editor_tool/tooling_ui_test_runner.cpp` reconciles gameplay Layouts but does not mount the shell-owned Game HUD. Feature Lab UI Tests report `document is not loaded: runtime_game` before their click assertions can run. The runner needs ordinary shell/system-Layout lifecycle and restart support, not Lab-specific mounts.
- The headless Rooms Test reaches the destination but its Fade never completes through the presentation driver, so the after-enter notification expectation fails; advancing authored time alone does not resolve it. The Dialogue semantic Test also reports `execution.dialogue_choice_without_blocker`. These are runner/runtime gaps, not passing automation coverage.
- The sandbox can reject post-restart UI publications with `host.runtime_ui_publication_rejected` until the new session revision catches up with the previous one. Fresh re-entry requires a host/UI generation-reset fix; do not treat this transient failure as a scenario status change.

Keep these failures visible rather than removing expectations or claiming that successful CLI invocation proves playback passed.
