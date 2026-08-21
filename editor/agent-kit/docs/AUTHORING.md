# Authoring Concepts

NovelTea projects are file-first. Use the focused generated documents to understand authoring semantics, edit the tracked records directly, then validate the complete change with `noveltea validate`. JSON Schema under `.noveltea/agent/schemas/` is an exhaustive fallback reference, not the normal tutorial path.

## Core concepts

- **Asset**: imported source media such as an image, audio file, or font. An image Asset is not itself a Prop or Interactable.
- **Placement**: a named normalized rectangle inside a Room. Placements provide geometry that Room content can reuse.
- **Prop**: a visual Room object that associates an Asset and/or Material with a Placement. Use a Prop when the object is only presentation and is not meant to participate in interaction.
- **Interactable**: a reusable interactive object definition. It owns its sprite/material presentation, hotspot definition, and initial enabled/visible state.
- **Room interactable**: an instance of an Interactable in one Room. It references both the global Interactable record and a Room Placement.
- **Room hotspot**: an interactive region directly on the Room background image, useful when the clickable feature is already baked into that image.
- **Verb**: an interaction operation with arity `0`, `1`, or `2`. Its `operandRoles` length must equal its arity.
- **Interaction**: authored behavior associated with a Verb and operands/conditions where applicable.

References use stable IDs, not labels. Record filesystem identity is also ID-based; see `.noveltea/agent/PROJECT_FORMAT.md`.

## Choose the right authoring concept

Use this decision rule before editing a Room:

- Need only an image visible in the Room? Use a **Prop** plus a Placement.
- Need an object the player can target or interact with? Use an **Interactable** record plus a Placement and a Room-interactable instance.
- Need an interactive region over something already visible in the Room background? Use a **Room hotspot**.

Do not create an Interactable merely to display a sprite. Do not create a separate sprite Prop for an Interactable whose own `presentation.sprite` is the intended visual.

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

- `operandRoles` must describe exactly one role per Verb operand.
- `defaultProgram` is the Verb's fallback behavior program; do not invent behavior merely to make validation pass.
- Hotspots are pointer geometry that select semantic subjects or Room Exits; Features are owner-local semantic parts that may carry Traits/Properties and participate in Interactions. See `.noveltea/agent/docs/INTERACTIONS.md` and `.noveltea/agent/docs/ROOMS.md`.

For Room-specific templates and coordinate rules, read `.noveltea/agent/docs/ROOMS.md`.
