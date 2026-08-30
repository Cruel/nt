# Scenes

A Scene is NovelTea's general visual-novel/story orchestration record. It is an ordered program that can stage presentation, present text/choices, call other story content, mutate gameplay, navigate Rooms, invoke Interactions, run Lua, wait, and then finish through one explicit terminal action.

Use a Scene when a sequence coordinates several concerns. Use Dialogue for conversation structure, an Interaction for command matching/behavior, and a Room for exploration topology instead of forcing those jobs into Scene events.

## Stage: what is visible underneath the Scene

Every Scene chooses one Stage policy:

- `inherited`: keep the caller/current presentation and layer Scene-owned presentation over it.
- `staged-room`: use a Room as a visual composition without entering that Room for gameplay.
- `blank`: begin from an authored background/optional Layout without a Room.

A staged Room is presentation only. It does not change Current Room, fire Room lifecycle behavior, move Characters/Interactables, expose exploration Hotspots, or make its subjects interactable. If gameplay must actually enter a Room, author a Room/navigation operation.

## Ordered events and timeline

Scene events execute in authored order. Timeline track/start/duration data helps author overlapping presentation, but it does not make the Scene an arbitrary graph. When later work must wait for a previous finite operation to finish, use the event's explicit completion/dependency or wait mechanism rather than relying on visual timing guesses.

Major event families include:

- presentation: background changes, actor cues, Layout changes, material parameters, postprocess effects, transition groups;
- story flow: call Scene, call Dialogue, resume handed-off Dialogue, detached Scene launch;
- player/text flow: Scene text, Scene choice, waits, conditional branches;
- gameplay: shared Property/Trait/Location/state/Interactable-quantity commands and atomic gameplay-command batches;
- runtime world structure: create/configure/destroy runtime instances and retarget exits through runtime-world transactions;
- exploration: directed Room change, guarded navigation attempt, call Interaction;
- media/scripting: semantic audio cues and Run Lua.

Use the narrowest event that expresses the story intent. Do not use Lua merely to reproduce a typed Scene operation that already exists.

## Characters in Scenes

Scene actor slots are presentation occurrences that reference Characters. An actor cue can select Profile/Pose/Expression/Appearance, placement, visibility, Gesture/presentation behavior, and related presentation state without moving the semantic Character's world Location.

The same Character may appear in multiple actor slots. If the story requires persistent Character state/location to change, use a gameplay/world mutation explicitly.

## Calling and returning

`CallScene` and `CallDialogue` temporarily run child content and then resume this Scene at the next authored event when the child Returns. Scene calls may bind the target Scene's named typed inputs and receive declared Outcomes.

A Dialogue called by a Scene can **Handoff** control back to its awaiting Scene while keeping that exact Dialogue invocation suspended. A later `ResumeDialogue` event returns to that exact Dialogue cursor. This can repeat; authors do not invent handoff routing IDs. See `DIALOGUES.md`.

Use a detached Scene only for deliberately non-awaited background work with an appropriate lifetime owner. Keep ordinary sequential story flow in the foreground Scene.

## Gameplay mutation versus world/navigation operations

Use a gameplay-effect batch when several ordinary semantic mutations should succeed or fail together. Use a runtime-world transaction for structural runtime instance operations such as creating/destroying/configuring runtime Rooms/Interactables or retargeting exits. Use directed Room change/navigation events for actual Room lifecycle/navigation rather than hiding navigation inside a transaction.

## Terminal action

Every Scene has one explicit terminal. The important choices are:

- **Return**: resume a caller, optionally with a declared Outcome.
- **Continue/Replace Scene or Dialogue**: replace this Scene while preserving its return destination.
- **Release to Exploration**: end foreground Scene flow and resume the existing Current Room.
- **Complete Game**: finish the playthrough.

Choose the terminal from story structure; there is no implicit Scene fallthrough.

Use `noveltea entity create scenes <id>` for the initialized current shape and `schemas/records/scenes.schema.json` for exact event variants. Keep event IDs stable because choices, waits/dependencies, diagnostics, tests, and tooling may address them semantically.
