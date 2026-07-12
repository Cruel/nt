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

The editor currently stores `actions`; runtime code scans legacy generic entities and JSON-backed action data. Phase 3 renames and replaces the collection, and Phases 4--7 implement deterministic matching and typed programs. No Action API or serialized shape is preserved.
