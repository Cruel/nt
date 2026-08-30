# Verbs, Interactions, Features, and Hotspot Selection

NovelTea separates pointer geometry from semantic gameplay behavior. Do not attach gameplay behavior to Hotspots and do not invent placeholder Verbs merely to satisfy validation.

## Named Verb slots

Every Verb declares stable required named subject `slots` and one locale-independent `bindingOrder`. Each slot contains localized `label` and `prompt` text plus a non-empty finite union of Subject Selectors. Final commands bind exact live subjects by slot ID; they are never positional.

A completed-command template may use stable named placeholders, for example `Show {object} to {recipient}`. Localized wording may reorder those placeholders without changing command semantics.

Subject Selectors are the shared closed vocabulary:

- `any-subject`;
- `family` for Character, Interactable, or Feature;
- `trait` for a required live Trait;
- `interactable-definition` for Interactable Instances of one Interactable Definition;
- `qualified-pattern` for a stable family-qualified identity prefix with one trailing `*`;
- `exact` for one exact semantic subject.

Selector arrays are unions: a subject is admitted when any selector in the slot matches. The same exact live subject may fill multiple slots; relationship restrictions belong in Guards rather than slot binding.

## Semantic subjects

Interaction subjects are exactly Character, exact live Interactable Instance, and owner-qualified Feature identities. A Feature is a stable semantic part owned by a Room or Interactable Instance; its reference is always owner-qualified.

Runtime-created subjects use the same selector vocabulary as declared subjects. Match their live family, effective Traits, Interactable Definition, qualified identity, or exact identity; do not depend on Archetype provenance.

## Hotspots select subjects; they do not own behavior

A Hotspot is pointer geometry, condition/input ordering, highlight presentation, and a semantic target. There is no Hotspot Verb activation and no exact-Hotspot Interaction context.

Room Hotspots may target a Feature owned by the same Room, another admitted exact semantic subject, or an Exit owned by that Room. Interactable Hotspots may target the owning Interactable, one of its Features, or another admitted exact semantic subject.

Multiple Hotspots may deliberately target the same Feature. Pointer input then selects the exact same semantic subject that non-pointer input would select. Do not create duplicate Features merely because one semantic part has multiple clickable regions.

## Minimal Verb shape

Use `noveltea entity create verbs <id>` to obtain the current initialized shape rather than copying a stale hand-written schema. A Verb contains slots, `bindingOrder`, action text, completed-command text, availability, quick-action policy, and one default Interaction program. A structurally empty default program is:

```json
{
  "instructions": [],
  "completion": { "kind": "return" },
  "outcome": "handled"
}
```

An empty default program executes no authored instructions. Use it only when that behavior is intended or while completing a coherent requested edit; do not create placeholder Verbs solely to silence validation.

## Interactable versus behavior

An Interactable record means the object can participate as a semantic subject. Its presentation, location, nested Features, and Hotspot geometry are separate from the Interaction rules/Verb programs that define gameplay behavior.

If an object is purely visual, model it as a Room Prop. If a meaningful sub-part needs independent behavior or Properties, model that sub-part as a Feature rather than as a Hotspot identity. See `.noveltea/agent/docs/ROOMS.md`.

## Interactions

Interaction Rules connect a Verb to one selector union for every named Verb slot, plus semantic context and an authored program. Rule slot order has no meaning; `slotId` is authoritative. Keep references typed and stable-ID based.

Interaction contexts are semantic runtime contexts such as active Room, Room placement, or predicate. Hotspot identity is not an Interaction context and cannot be supplied through `Game.run_action`.

Inline conditions, expressions, predicates, and effect snippets remain in their owning JSON records unless the current workspace contract explicitly externalizes them. Do not infer semantic references from arbitrary Lua text.
