# Interaction Component

## Contract

Interaction replaces the generic gameplay term Action. An `InteractionRule` matches one `VerbId` plus exact `InteractableId` operands or explicit `AnyInteractable` wildcards and owns an `InteractionProgram`.

Exact operands outrank wildcards. Equal-specificity ties use declared rule order and produce a compiler warning. The old `positionDependent` boolean is replaced by an explicit context predicate or positioning requirement.

## Program

An `InteractionProgram` is an ordered list containing only ApplyEffect, MoveInteractable, SetInteractableState, Notify, CallScene, and CallDialogue, followed by one typed `FlowTarget`. Child Scene/Dialogue calls push frames and return to the next instruction. Final targets use normal tail-continuation rules. Execution produces typed `Handled`, `Unhandled`, or `Failed` outcomes where Verb fallback requires them.

Interaction is property-bearing and may `extends` another Interaction only for declared custom-property lookup. Rules and programs do not merge or inherit.

## Authoring, compiled, and state disposition

- **Authoring V2:** collection-specific Interaction records with optional `extends`, typed properties, ordered rules, exact/wildcard operands, and strict programs.
- **Compiled:** linked `InteractionRule`/`InteractionProgram`, retained parent edge, stable rule order, and property assignments.
- **Mutable:** Interaction flow frames, changed variables/interactable state, and property overrides in `SessionState`.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Current implementation scaffold

The editor authoring schema now uses the V2 `interactions` collection. Its payload is still temporary Phase 3 scaffolding until the complete rule and program contract is implemented. Runtime code and the transitional runtime-export wire still use legacy Action-shaped data while Phases 4--7 introduce deterministic matching and typed programs. No Action API or serialized shape is preserved.
