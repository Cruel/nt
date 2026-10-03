---
title: Characters, Dialogues, and Scenes
description: Persistent Character identity, conversation graphs, ordered story orchestration, and the boundary between presentation and world state.
---

NovelTea separates persistent story identities from the temporary presentation used to tell a scene
or conversation. **Characters** are semantic actors, **Dialogues** are conversation graphs, and
**Scenes** are ordered orchestration programs. They can call and present one another without merging
their responsibilities.

## Characters are persistent semantic identities

A **Character** represents one person or actor identity that can be referenced by Room cast,
Dialogue speakers, Scene actors, Traits, Properties, and world Location.

Character presentation is reusable configuration layered around that identity. Presentation Profiles
define compatible visual sets; Poses provide base compositions; Expressions and optional Appearances
override parts of that composition; Gestures name semantic presentation actions that can map to
profile-specific animation. Automatic speaking/blink/idle presentation is presentation state, not
gameplay logic.

A visual occurrence never creates or moves the Character. Showing a Character in a Dialogue Stage
Slot or Scene actor slot does not change the Character's world Location. Story logic that should move
the Character must author an explicit gameplay/world-state change.

## Dialogues own conversation structure

A **Dialogue** is a stable-ID conversation graph built from blocks and edges. Sequence blocks present
ordered conversation content, Choice blocks expose authored branches, Redirect blocks transfer flow,
and Comment blocks are authoring documentation rather than runtime flow.

Dialogue owns conversation-specific concerns such as lines, choices, logging/show-once behavior,
conversation-local Stage/Media Slots, and typed inline cues. Stage Slots can retain Character
presentation across lines without changing the Character's semantic world state. Cues can coordinate
line-local presentation/media actions; they are not a general gameplay scripting language.

Dialogues can call child Scenes. When a Dialogue was called by a Scene, cooperative handoff can return
control to that waiting Scene while suspending the exact Dialogue invocation, then later resume the
same conversation position. The call relationship provides the identity; authors do not invent a
parallel handoff-token system.

## Scenes own ordered orchestration

A **Scene** is an ordered story/presentation program. It can stage visual context, present text and
choices, call Scenes or Dialogues, mutate gameplay through shared commands, navigate Rooms, invoke
Interactions, run admitted Lua, wait/branch, and finish through an explicit terminal action.

Scene Stage policy controls what presentation appears beneath Scene-owned content. A Scene may inherit
current presentation, visually stage a Room, or begin from a blank authored presentation. A staged
Room is presentation only: it does not become Current Room, run exploration lifecycle, or make the
Room's subjects interactable.

Scene actor slots are presentation occurrences of Characters. Event IDs, choice option IDs, and
other stable nested IDs matter because later events, tests, diagnostics, and tooling can address them
semantically.

Use Dialogue when the core structure is conversation and choices, Scene when the sequence coordinates
multiple story/presentation/gameplay concerns, and Interaction when the behavior is command matching
for live subjects.

For exact Character presentation structures, Dialogue block/cue variants, Scene event forms, call
bindings, outcomes, and terminal variants, use the generated Project schema reference.
