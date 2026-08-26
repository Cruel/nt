# Dialogues

A Dialogue is a conversation graph specialized for lines, choices, conversation-local presentation, and conversation flow. Do not flatten substantial conversation logic into Scene text events when Dialogue's graph/history/choice model is the better fit.

## Blocks and edges

Dialogue uses stable-ID blocks:

- **Sequence**: ordered transcript/story segments and at most one Next edge.
- **Choice**: one or more ordered Choice edges.
- **Redirect**: immediately targets another block.
- **Comment**: editor-only documentation, not runtime flow.

Lines and Choice edges may carry conditions/effects, logging policy, and autosave-safe-point policy. Disabled choices are never selectable; project Dialogue settings decide whether unavailable choices are hidden or shown disabled.

Keep block, segment, cue, and edge IDs stable. Tests and runtime state use semantic IDs rather than screen position or list index.

## Lines, speakers, and text

A line chooses text from the supported text-source forms and may specify a Character speaker. Speaker resolution can also come from Sequence/Dialogue defaults. Dialogue logging/show-once behavior belongs to Dialogue rather than being reimplemented by a Scene or Layout.

Dialogue presentation is separate from semantic Character world state. A speaker can be off-screen, and showing a Character during Dialogue does not move that Character between Rooms.

## Stage Slots and Media Slots

**Stage Slots** are Dialogue-local Character presentation occurrences. A slot can retain Character/Profile/Pose/Expression/Appearance/placement/visibility state across lines. Speaker synchronization can automatically mark matching slots as speaking and can coordinate expression presentation.

**Media Slots** are Dialogue-local narrow media channels intended for the Dialogue Layout, such as an image or Character presentation snapshot. The Layout decides where/how the slot is displayed.

Use slots for presentation that should persist across several lines instead of re-authoring the same state on every line.

## Inline cues

Lines may contain typed cues at text reveal positions. Current semantic cue families include Character expression/stage changes, Media changes, Gestures, Voice, Sound Effects, and modest camera emphasis. Cues can specify waiting/skipping policy where supported.

Use Gestures for Character-authored semantic actions rather than selecting raw animation frames. Use Scene choreography when presentation becomes multi-stage or extends beyond a line-local cue.

The editor may expose cue markup alongside structured controls, but cue markup is not a generic gameplay scripting language. Gameplay changes still belong in Dialogue effects, Scenes, Interactions, or Lua.

## Calling Scenes and cooperative handoff

A Dialogue Sequence can call a child Scene and later resume at the saved Dialogue cursor. The call chooses whether the Dialogue UI is concealed or preserved while that child Scene runs.

When a Dialogue was called by a Scene, a **Handoff** can cooperatively return control to that awaiting Scene while suspending this exact Dialogue invocation. The Scene continues at the event after its `CallDialogue`. A later Scene `ResumeDialogue` returns to the exact suspended Dialogue position. The pair may repeat Handoff/ResumeDialogue multiple times.

Do not create your own handoff token, label, or invocation ID; the relationship is implicit in the direct Scene/Dialogue call structure. If you merely need to run a Scene and immediately return to Dialogue, use the ordinary child Scene call instead of Handoff.

## Completion

Dialogue completion may continue to a Scene, Dialogue, or Room, Return to a valid caller, or End as admitted by the current shape. A direct Project Dialogue entrypoint has no caller, so its completion must make sense without Return.

Dialogue choices remain distinct from Scene choices. A Layout may display both in layered presentation during handoff/Scene overlays; do not replace one model with the other.

Use `noveltea entity create dialogues <id>` for the initialized current shape and `schemas/records/dialogues.schema.json` for exact block/segment/cue/edge fields. Validate after changing stable IDs or Character/Scene references.
