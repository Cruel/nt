# Interaction Component

## Contract

Interaction replaces the generic gameplay term Action. An `InteractionRule` matches one `VerbId`
plus a closed list of Character-or-Interactable subjects. Each operand is an exact typed subject,
`AnyCharacter`, `AnyInteractable`, or `AnySubject`, and the rule owns an `InteractionProgram`.

Rules also carry either generic context or an exact owner-qualified Room/Interactable hotspot
context. Exact hotspot context adds specificity after operand specificity and before declaration
order; generic rules remain available as fallbacks. Generic Verb APIs cannot fabricate exact hotspot
context.

Exact operands outrank wildcards. Equal-specificity ties use declared rule order and produce a compiler warning. The old `positionDependent` boolean is replaced by an explicit context predicate or positioning requirement.

## Program

An `InteractionProgram` is an ordered list containing only ApplyEffect, MoveInteractable, SetInteractableState, Notify, CallScene, and CallDialogue, followed by one typed `FlowTarget` and an authored successful outcome of `Handled` or `Unhandled`. Child Scene/Dialogue calls push frames and return to the next instruction. Final targets use normal tail-continuation rules. Runtime instruction or child-flow failure produces `Failed`; it is not an authored success result.

The additive typed visitor matches by Verb, arity, exact operands,
explicit wildcards, active-Room context, Room-placement proximity, and predicates. Candidates with
more exact operands win; declaration order is the final tie-break and equal-specificity authoring
ties are warned. The selected rule runs first. An `Unhandled` result then attempts the selected Verb's own default program once, while `Handled` applies the program FlowTarget and `Failed` aborts. If that Verb default is also `Unhandled`, the final V1 undefined-interaction policy is a typed `Nothing happens.` notification because the current compiled wire does not define an authored project-level fallback program.

Interaction is property-bearing and may attach supported Traits backed by ordinary Properties. Trait attachment does not merge or inherit rules or programs.

## Authoring, compiled, and state disposition

- **Authoring version 3:** collection-specific Interaction records with Trait attachments, typed properties, ordered rules, exact/wildcard operands, generic/exact-hotspot context, and strict programs.
- **Compiled:** linked `InteractionRule`/`InteractionProgram`, retained Trait IDs, stable rule order, and property assignments.
- **Mutable:** Interaction flow frames, changed variables/interactable state, and property overrides in `SessionState`.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Current authoring implementation

The current editor implements strict rules, exact Character/Interactable subjects and all three explicit
wildcards, explicit context variants, and
closed program instructions. Every instruction has a stable nested ID; the editor allocates a unique
ID when creating it and preserves that identity through editing and reordering. Editor creation and
detail paths use undoable typed updates; validation checks arity, instruction and rule IDs, Room
placements, references, duplicate IDs, and equal-specificity warnings. The compiler lowers every rule
and instruction losslessly into the specialized compiled program while preserving authored order.
`runtime::RuntimeExecutor` executes that program inside `runtime::RuntimeSession`; there is no Action
adapter.
Runtime selection, invocation messages, saved Interaction frames, editor playback, debug snapshots,
RmlUi bindings, and Lua `Game.run_action` all carry the same `{ kind = "character" | "interactable",
id = ... }` subject vocabulary. The live Room resolver applies the same eligibility contract to both
Character and Interactable occupants.

`ActivateHotspotInput` is the sole semantic hotspot entry. Room Verb hotspots invoke with no operands;
Interactable hotspots supply their owning Interactable as the one operand. Save state version 7
persists exact hotspot invocation identity for yielding programs and rejects stale/mismatched identity
on restore, while ordinary generic invocations persist explicit hotspot-null context.
