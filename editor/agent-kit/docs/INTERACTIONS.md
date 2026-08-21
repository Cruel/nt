# Verbs, Interactions, and Hotspot Activation

NovelTea separates an object's visual/presence model from the behavior triggered when the player interacts with it. Do not invent empty behavior merely to satisfy validation.

## Verb arity

Every Verb declares `arity` as `0`, `1`, or `2`. `operandRoles` must contain exactly one non-empty role name for each operand.

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

The role names describe the meaning of operands; choose names that match the game concept rather than arbitrary placeholders.

## Hotspot arity invariants

These rules are semantic authoring constraints and are more specific than the JSON Schema:

- A **Room hotspot** using Verb activation requires an arity-`0` Verb.
- An **Interactable hotspot** requires an arity-`1` Verb.
- Therefore an Interactable-hotspot Verb must also have exactly one `operandRoles` entry.

A hotspot may temporarily use `"verb": null` while its behavior is not yet configured. This is an incomplete-authoring state and should not cause an agent to fabricate a meaningless `look`, `examine`, or other empty Verb. Assign a real compatible Verb when the requested gameplay behavior is known.

## Minimal Verb shape

When behavior is actually requested, a Verb record includes `arity`, matching `operandRoles`, action text, availability, and a default program. A default empty program has this shape:

```json
{
  "instructions": [],
  "completion": { "kind": "return" },
  "outcome": "handled"
}
```

An empty default program is structurally valid, but it means exactly that: no authored instructions are executed. Use it only when that is the intended behavior or while deliberately scaffolding a Verb that will be completed as part of the same requested change. Do not create placeholder Verbs solely to silence validation.

For a new Verb, prefer `noveltea entity create verbs <id>` to obtain the current initialized record shape, then edit its semantic fields as needed. If the surrounding project is temporarily incomplete, finish the coherent logical edit before treating validation diagnostics as final.

## Interactable versus behavior

An Interactable record means the object is intended to participate in interaction, but its presentation and placement are separate from its eventual behavior. Its hotspot can remain unconfigured while authoring is incomplete.

If the requested object is purely visual and is not intended to participate in interaction at all, model it as a Room Prop instead. See `.noveltea/agent/docs/ROOMS.md`.

## Interactions

Interactions connect Verbs, operands, conditions, context, and authored programs. When modifying an existing game's interaction behavior, inspect nearby Interaction records before inventing a new pattern. Keep references typed and stable-ID based.

Inline conditions, expressions, predicates, and effect snippets remain in their owning JSON records unless the current workspace contract explicitly externalizes them. Do not infer semantic references from arbitrary Lua text.
