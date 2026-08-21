# Verbs, Interactions, Features, and Hotspot Selection

NovelTea separates pointer geometry from semantic gameplay behavior. Do not attach gameplay behavior
to Hotspots and do not invent placeholder Verbs merely to satisfy validation.

## Verb arity

Every Verb declares `arity` as `0`, `1`, or `2`. `operandRoles` must contain exactly one non-empty role
name for each operand.

Examples:

```json
{
  "arity": 0,
  "operandRoles": []
}
```

```json
{
  "arity": 1,
  "operandRoles": ["target"]
}
```

```json
{
  "arity": 2,
  "operandRoles": ["tool", "target"]
}
```

The role names describe the meaning of operands; choose names that match the game concept rather than
arbitrary placeholders.

## Semantic subjects

Interaction subjects are exactly:

- Character;
- Interactable;
- Feature.

A Feature is a stable semantic part owned by a Room or Interactable. It is not a top-level record and
its reference is always owner-qualified. Authoring references therefore contain the owner plus the
nested `featureId`; runtime/preview subjects preserve the equivalent owner kind, owner ID, and Feature
ID.

Exact Feature subjects are appropriate for concepts such as a door handle, desk drawer, painting,
control panel, or other meaningful part whose behavior/state should be addressable independently of
its pointer geometry. Features may attach compatible Traits and assign compatible Properties.

`AnyCharacter` and `AnyInteractable` remain narrow wildcards. `AnySubject` also admits Features.

## Hotspots select subjects; they do not own behavior

A Hotspot is only pointer geometry, condition/input ordering, highlight presentation, and a semantic
target. There is no Hotspot Verb activation and no exact-Hotspot Interaction context.

Room Hotspots may target:

- a Feature owned by the same Room;
- another exact Character/Interactable/Feature subject; or
- an Exit owned by that Room.

Interactable Hotspots may target:

- the owning Interactable;
- a Feature owned by that Interactable; or
- another exact Character/Interactable/Feature subject.

Multiple Hotspots may deliberately target the same Feature. Pointer input then selects the exact same
semantic subject that non-pointer input would select. Do not create duplicate Features merely because
one semantic part has multiple clickable regions.

## Minimal Verb shape

When behavior is actually requested, a Verb record includes `arity`, matching `operandRoles`, action
text, availability, and a default program. A default empty program has this shape:

```json
{
  "instructions": [],
  "completion": { "kind": "return" },
  "outcome": "handled"
}
```

An empty default program is structurally valid, but it means exactly that: no authored instructions
are executed. Use it only when that is the intended behavior or while deliberately scaffolding a Verb
that will be completed as part of the same requested change. Do not create placeholder Verbs solely
to silence validation.

For a new Verb, prefer `noveltea entity create verbs <id>` to obtain the current initialized record
shape, then edit its semantic fields as needed. If the surrounding project is temporarily incomplete,
finish the coherent logical edit before treating validation diagnostics as final.

## Interactable versus behavior

An Interactable record means the object can participate as a semantic subject. Its presentation,
location, nested Features, and Hotspot geometry are separate from the Interaction rules/Verb programs
that define gameplay behavior.

If the requested object is purely visual and is not intended to participate in interaction at all,
model it as a Room Prop instead. If a meaningful sub-part needs independent behavior or Properties,
model that sub-part as a Feature rather than as a Hotspot identity. See `.noveltea/agent/docs/ROOMS.md`.

## Interactions

Interactions connect Verbs, semantic operands, conditions, context, and authored programs. When
modifying an existing game's interaction behavior, inspect nearby Interaction records before inventing
a new pattern. Keep references typed and stable-ID based.

Interaction contexts are semantic runtime contexts such as active Room, Room placement, or predicate.
Hotspot identity is not an Interaction context and cannot be supplied through `Game.run_action`.

Inline conditions, expressions, predicates, and effect snippets remain in their owning JSON records
unless the current workspace contract explicitly externalizes them. Do not infer semantic references
from arbitrary Lua text.
