# Interaction Component

## Contract

Interaction replaces the generic gameplay term Action. An `InteractionRule` matches one `VerbId` plus exact `InteractableId` operands or explicit `AnyInteractable` wildcards and owns an `InteractionProgram`.

Exact operands outrank wildcards. Equal-specificity ties use declared rule order and produce a compiler warning. The old `positionDependent` boolean is replaced by an explicit context predicate or positioning requirement.

## Program

An `InteractionProgram` is an ordered list containing only ApplyEffect, MoveInteractable, SetInteractableState, Notify, CallScene, and CallDialogue, followed by one typed `FlowTarget` and an authored successful outcome of `Handled` or `Unhandled`. Child Scene/Dialogue calls push frames and return to the next instruction. Final targets use normal tail-continuation rules. Runtime instruction or child-flow failure produces `Failed`; it is not an authored success result.

Interaction is property-bearing and may `extends` another Interaction only for declared custom-property lookup. Rules and programs do not merge or inherit.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Interaction records with optional `extends`, typed properties, ordered rules, exact/wildcard operands, and strict programs.
- **Compiled:** linked `InteractionRule`/`InteractionProgram`, retained parent edge, stable rule order, and property assignments.
- **Mutable:** Interaction flow frames, changed variables/interactable state, and property overrides in `SessionState`.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Current authoring implementation

Phase 3E implements strict V2 rules, exact/AnyInteractable operands, explicit context variants, and
closed program instructions. Every instruction has a stable nested ID; the editor allocates a unique
ID when creating it and preserves that identity through editing and reordering. Editor creation and
detail paths use undoable typed updates; validation checks arity, instruction and rule IDs, room
placements, references, duplicate IDs, and equal-specificity warnings. Phase 4E lowers every rule and
instruction losslessly into the specialized compiled program while preserving authored order.
Runtime matching and execution remain Phases 6--7 work. The transitional runtime-export adapter does
not acquire an Action compatibility path.
