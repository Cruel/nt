# Characters

A Character record represents one persistent semantic person/actor identity. Dialogue speakers, Room inhabitants, Scene actors, Properties, Traits, and world Location can all refer to that same Character, but a visual occurrence is not the Character's gameplay state.

## Presentation model

Each Character has one or more **Presentation Profiles**. A Profile defines an ordered layer vocabulary, Poses, profile-local animation clips, and optional automatic blink/speaking behavior. Use Profiles when the same Character needs materially different presentation sets, such as courtroom, overworld, close-up, or alternate costume rigs.

A **Pose** is the Profile's base layer composition. An **Expression** supplies sparse layer overrides and can provide different overrides per Profile. An optional **Appearance** is another sparse override axis applied after Expression, useful for persistent visual variants such as clothing or damage without duplicating every Pose/Expression combination.

Defaults select the initial Profile, Expression, optional Appearance, and optional idle behavior. Keep the simplest Character simple: a one-layer Profile with one Pose and a neutral Expression uses the same model as a layered Character.

## Gestures and automatic animation

A **Gesture** is a stable semantic action such as `point`, `desk-slam`, or `shrug`. It may map to a different animation clip for each Presentation Profile. Author Dialogue/Scene behavior in terms of the Gesture ID, not animation frames.

Profiles may define automatic blink and speaking clips. Speaking animation follows semantic speaking state; Dialogue does not need to manually animate mouths for every line. Idle behaviors are reconstructible presentation loops and should represent ambient visual motion rather than gameplay state.

Gesture cues may synchronize presentation/audio cues, but Gestures are not a back door for gameplay logic. Put gameplay changes in Scene events, Dialogue effects, Interactions, or Lua.

## World identity versus visual occurrences

A Character may have a world Location such as a Room or Unplaced. Separately, Rooms, Scenes, and Dialogues can create presentation occurrences of that Character.

- A Room cast entry presents a Character in that Room composition.
- A Scene actor slot presents a Character for that Scene invocation.
- A Dialogue Stage Slot may present a Character during that Dialogue.

Displaying a Character in a Scene or Dialogue does **not** move the Character's world Location. Likewise, the same Character may appear in multiple Scene actor slots with independent presentation state. If story logic requires the Character to move Rooms, author an explicit gameplay/world mutation.

## Relationships

Dialogue speaker references use the Character identity and can drive Stage Slot speaking/expression synchronization. Scene actor cues address Scene-local actor slots that point to Characters. Character Traits and Properties describe semantic state shared by all visual occurrences; presentation choices do not create separate gameplay identities.

Characters may use a same-kind Archetype for reusable configuration. See `ARCHETYPES_TRAITS.md` before duplicating large profile/property configurations across many Characters.

Use `noveltea entity create characters <id>` for the initialized current shape and `schemas/records/characters.schema.json` for exact Profile/Pose/Expression/Appearance/Gesture fields. Validate after changing IDs because Scenes, Dialogues, Rooms, and other records may reference nested Character presentation IDs.
