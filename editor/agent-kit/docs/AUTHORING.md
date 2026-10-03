# Authoring Workflow

NovelTea projects are file-first. Read the relevant canonical model page under `.noveltea/agent/concepts/`, consult `.noveltea/agent/reference/` for exact current structure and constraints, edit tracked records directly, then validate the coherent change with `noveltea validate`. JSON Schema under `.noveltea/agent/schemas/` is an exhaustive fallback reference, not the normal tutorial path.

## Choose the right authoring concept

Use this decision rule before editing a Room:

- Need only an image visible in the Room? Use a **Prop** plus a Placement.
- Need an object the player can target or interact with? Use an **Interactable Definition**, one exact declared **Interactable Instance** in the Project registry, and a Room Placement/occurrence when it should be presented in that Room.
- Need an interactive region over something already visible in the Room background? Use a **Room hotspot**.
- Need a fungible quantity such as coins, ingredients, or ammunition? Make the **Interactable Definition** stackable and use exact quantity-bearing Interactable Instances; do not invent a custom count Property or a separate Item record.
- Need a scripted/cinematic sequence that coordinates presentation and gameplay? Use a **Scene**.
- Need a branching conversation with line/choice history and Dialogue-local presentation? Use a **Dialogue**.

Do not create an Interactable merely to display a sprite. Do not create a separate sprite Prop for an Interactable whose own `presentation.sprite` is the intended visual.

For exact current record fields, create a correctly initialized record with `noveltea entity create` when practical and consult the matching generated schema. Do not infer behavior from schema shape alone: the focused Agent Kit docs describe ownership, lifetime, identity, and how records compose.

## Complete logical edits

Many authoring operations span more than one record or array. Treat them as one coherent edit before validation. For example, placing a new Interactable in a Room normally requires all of the following:

1. A reusable `records/interactables/<definition-id>.json` Definition record.
2. A top-level `project.json` `interactableInstances` registry entry with a stable Instance ID, Definition reference, and authoritative Location/state/quantity.
3. A Room `placements[]` entry when that Room needs authored presentation geometry.
4. A Room `interactables[]` occurrence that references the exact Instance registry ID and Placement.
5. Any Feature and Interaction/Verb records required by the intended semantic behavior; the Hotspot itself only selects a subject.

Make the complete relationship first, then run `noveltea validate`. Semantic CLI commands operate against the current project and can surface diagnostics from unrelated or temporarily incomplete intermediate state.

## Required boilerplate versus semantic choices

Some required fields are routine defaults. Preserve them unless the requested behavior needs something different. Common examples include `condition: {"kind":"always"}`, `visible`, `enabled`, `quantity`, `order`, `presentation`, and nullable Material/Layout fields. Definition records do not own mutable `initialState`; declared Interactable Instance state belongs in `project.json` `interactableInstances`.

Other required fields encode important semantics and should not be guessed. In particular:

- Verb slot IDs and `bindingOrder` are semantic command identity. Completed-command templates reference those slot IDs with named placeholders such as `{target}`.
- `defaultProgram` is the Verb's fallback behavior program; do not invent behavior merely to make validation pass.
- Hotspots are pointer geometry that select semantic subjects or Room Exits; Features are owner-local semantic parts that may carry Traits/Properties and participate in Interactions. See `.noveltea/agent/concepts/interactions.md` and `.noveltea/agent/docs/ROOMS.md`.

For Room-specific templates and coordinate rules, read `.noveltea/agent/docs/ROOMS.md`.
