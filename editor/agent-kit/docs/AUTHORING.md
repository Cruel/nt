# Authoring Concepts

NovelTea projects are file-first. Use the focused generated documents to understand authoring semantics, edit the tracked records directly, then validate the complete change with `noveltea validate`. JSON Schema under `.noveltea/agent/schemas/` is an exhaustive fallback reference, not the normal tutorial path.

## Core concepts

- **Asset**: imported source media such as an image, audio file, or font. An image Asset is not itself a Prop or Interactable.
- **Character**: one persistent semantic person or actor identity. Character presentation is built from Profiles, Poses, Expressions, optional Appearances, Gestures, and automatic animation behavior. A Room/Scene/Dialogue can present a Character without changing that Character's world Location.
- **Room**: an explorable world location with background presentation, exits, placements, props, cast, Interactables, Features, and lifecycle behavior.
- **Placement**: a named normalized rectangle inside a Room. Placements provide geometry that Room content can reuse.
- **Prop**: a visual Room object that associates an Asset and/or Material with a Placement. Use a Prop when the object is only presentation and is not meant to participate in interaction.
- **Interactable**: a reusable interactive object definition. It owns its sprite/material presentation, hotspot definition, and initial enabled/visible state.
- **Room interactable**: an instance of an Interactable in one Room. It references both the global Interactable record and a Room Placement.
- **Room hotspot**: an interactive region directly on the Room background image, useful when the clickable feature is already baked into that image.
- **Item Definition**: the reusable definition of a fungible inventory item, such as a coin, herb, or ammunition type.
- **Item Stack**: one exact live identity containing a quantity of one Item Definition at one Location. Interactions and tests address the Stack identity, not a visually grouped inventory row.
- **Verb**: an interaction operation with stable named required subject slots, reusable Subject Selectors, and one locale-neutral `bindingOrder`.
- **Interaction**: authored behavior associated with a Verb, one selector union per named Verb slot, and semantic context/conditions.
- **Dialogue**: a conversation graph specialized for lines, choices, Dialogue-local Character/media presentation, inline cues, and cooperative Scene handoff.
- **Scene**: an ordered visual-novel orchestration program. Scenes stage presentation, call Dialogue/Scenes/Interactions, mutate gameplay, wait/branch/choose, and end through an explicit terminal action.
- **Map**: authored navigation/topology presentation over Rooms and their exits; it does not replace Room navigation authority.
- **Layout**: authored RML/RCSS/Lua UI or overlay presentation. Layouts display projected game state and may expose declared local state/signals.
- **Archetype**: reusable inherited configuration for exactly one gameplay-instance kind: Room, Character, or Interactable.
- **Trait**: a named Property-backed capability/configuration declaration. Traits do not add structural fields or executable behavior.

References use stable IDs, not labels. Record filesystem identity is also ID-based; see `.noveltea/agent/PROJECT_FORMAT.md`.

The Project chooses exactly one initial entrypoint: Room, Scene, or Dialogue. Script bootstrap is configured separately and should not be modeled as a fake entrypoint record.

## Choose the right authoring concept

Use this decision rule before editing a Room:

- Need only an image visible in the Room? Use a **Prop** plus a Placement.
- Need an object the player can target or interact with? Use an **Interactable** record plus a Placement and a Room-interactable instance.
- Need an interactive region over something already visible in the Room background? Use a **Room hotspot**.
- Need a fungible quantity such as coins, ingredients, or ammunition? Use an **Item Definition** plus one or more **Item Stacks**, not an Interactable with a custom count Property.
- Need a scripted/cinematic sequence that coordinates presentation and gameplay? Use a **Scene**.
- Need a branching conversation with line/choice history and Dialogue-local presentation? Use a **Dialogue**.

Do not create an Interactable merely to display a sprite. Do not create a separate sprite Prop for an Interactable whose own `presentation.sprite` is the intended visual.

For exact current record fields, create a correctly initialized record with `noveltea entity create` when practical and consult the matching generated schema. Do not infer behavior from schema shape alone: the focused Agent Kit docs describe ownership, lifetime, identity, and how records compose.

## Complete logical edits

Many authoring operations span more than one record or array. Treat them as one coherent edit before validation. For example, placing a new Interactable in a Room normally requires all of the following:

1. A global `records/interactables/<id>.json` record.
2. A Room `placements[]` entry.
3. A Room `interactables[]` entry that references both the Interactable and Placement.
4. Any Feature and Interaction/Verb records required by the intended semantic behavior; the Hotspot itself only selects a subject.

Make the complete relationship first, then run `noveltea validate`. Semantic CLI commands operate against the current project and can surface diagnostics from unrelated or temporarily incomplete intermediate state.

## Required boilerplate versus semantic choices

Some required fields are routine defaults. Preserve them unless the requested behavior needs something different. Common examples include `condition: {"kind":"always"}`, `visible`, `enabled`, `order`, `presentation`, `initialState`, and nullable Material/Layout fields.

Other required fields encode important semantics and should not be guessed. In particular:

- Verb slot IDs and `bindingOrder` are semantic command identity. Completed-command templates reference those slot IDs with named placeholders such as `{target}`.
- `defaultProgram` is the Verb's fallback behavior program; do not invent behavior merely to make validation pass.
- Hotspots are pointer geometry that select semantic subjects or Room Exits; Features are owner-local semantic parts that may carry Traits/Properties and participate in Interactions. See `.noveltea/agent/docs/INTERACTIONS.md` and `.noveltea/agent/docs/ROOMS.md`.

For Room-specific templates and coordinate rules, read `.noveltea/agent/docs/ROOMS.md`.
