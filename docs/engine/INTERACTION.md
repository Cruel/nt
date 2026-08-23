# Interaction Component

## Contract

Interaction is immutable gameplay behavior keyed by one `VerbId` plus named slot selector constraints. Interaction subjects are a closed semantic union:

- Character;
- Interactable;
- Item Stack, by exact live `ItemStackId`;
- Feature, always qualified by its owning Room or Interactable.

A bare Feature ID is never a runtime subject. Final commands carry exact live subject references bound to stable Verb slot IDs. The same live subject may bind multiple slots; #83 deliberately does not impose subject-distinctness.

Each Interaction Rule binds every slot declared by its Verb exactly once. A rule slot contains a finite union of the same `SubjectSelector` vocabulary used by Verb slots: any-subject, subject family, Trait, Item Definition, qualified-pattern identity, and exact identity. Rule slot ordering is not semantic; matching is by `slotId`.

Hotspots are not Interaction contexts. They are presentation/input geometry that resolve to one semantic subject or Room Exit before runtime dispatch. Interaction matching therefore sees the same subject identity whether selection came from a pointer Hotspot, Layout UI, Lua, preview/debugger, or an authored test.

Rules carry one of the remaining semantic contexts: generic, active Room, Room placement, or predicate. #83 replaces positional operand matching with named slot matching but does not implement the later Guard/priority resolver from #85. Current rule selection therefore keeps the existing deterministic pre-#85 ordering policy after the named-slot selector checks.

## Subject Selector matching

Selector evaluation is based on the exact live subject and its current effective runtime configuration:

- `any-subject` admits every supported subject family;
- `family` admits exactly one of Character, Interactable, Feature, or Item Stack;
- `trait` checks effective Traits on the live Character, Interactable, Feature owner configuration, or Item Stack;
- `item-definition` checks the live Item Stack definition;
- `qualified-pattern` checks a stable qualified identity prefix with one trailing `*`;
- `exact` compares the exact semantic subject identity.

Declared Archetype provenance is not part of matching or specificity. A runtime-created subject therefore matches when its live family, effective Traits, Item Definition, qualified identity, or exact identity satisfies the selector. Copying or instantiating from an Archetype does not grant hidden selector preference.

## Program

An `InteractionProgram` is an ordered list containing only ApplyEffect, MoveInteractable,
SetInteractableState, Notify, CallScene, and CallDialogue, followed by one typed `FlowTarget` and an
authored successful outcome of `Handled` or `Unhandled`. Child Scene/Dialogue calls push frames and
return to the next instruction. Final targets use normal tail-continuation rules. Runtime instruction
or child-flow failure produces `Failed`; it is not an authored success result.

The runtime matches by Verb, complete named bindings, the Verb slot selector unions, the corresponding Interaction Rule selector unions, semantic context, and predicates. The selected rule runs first. An `Unhandled` result then attempts the selected Verb's default program once, while `Handled` applies the program FlowTarget and `Failed` aborts. If that Verb default is also `Unhandled`, the current undefined-interaction policy is a typed `Nothing happens.` notification.

Interaction is not a Property or Trait owner. Runtime command matching and execution state belong to the Runtime Session rather than to the Interaction definition.

## Features as subjects

Features are owner-local semantic parts declared by Rooms or Interactables. An exact Feature subject therefore uses one of these identities:

```text
RoomFeatureRef(RoomId, FeatureId)
InteractableFeatureRef(InteractableId, FeatureId)
```

Validation requires both the owner and the nested Feature to exist. Runtime eligibility is derived from the owning semantic context: a Room Feature is eligible in its active Room context; an Interactable Feature follows the owning Interactable's current eligibility. Feature Traits and Properties do not change subject identity.

Multiple Hotspots may map to the same Feature. That produces one Interaction subject, not one subject per geometry region. This is required so the same Verb/Feature rule works identically for pointer and non-pointer invocation.

## Authoring, compiled, and state disposition

- **Current authoring schema:** collection-specific Interaction records with ordered rules, named slot selector unions, semantic context, and strict programs. #83 replaces positional operand fields without changing the already-selected authoring schema version.
- **Compiled V4:** linked immutable `InteractionRule`/`InteractionProgram` with named slot selectors and owner-qualified Feature subjects. #83 keeps compiled schema version 4.
- **Mutable:** Interaction flow frames plus gameplay state changed by executed effects in `SessionState`; the Interaction definition itself has no mutable Property/Trait state.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Runtime and tooling surfaces

Runtime selection and invocation messages, saved Interaction frames, editor playback, debug snapshots, RmlUi bindings, and Lua `Game.run_action` use the same semantic subject vocabulary. Final invocation is a collection of `{slotId, subject}` bindings. The wire shape for Feature subjects includes `ownerKind`, `ownerId`, and `featureId`; owner-qualified identity is preserved instead of being collapsed to the nested Feature ID.

Pointer Hotspots never call an Interaction directly. A pointer release resolves a Hotspot target to an exact semantic subject and dispatches ordinary subject selection, or resolves a Room Exit and dispatches ordinary navigation. There is no Hotspot-specific command shape.

Save state persists named bindings when a yielding Interaction frame exists. Ended Stack identities are rejected rather than redirected. Feature and Stack Property overrides use the normal Property-state path.

## Current editor implementation

The Interaction editor authors one selector union per named Verb slot, all six Subject Selector variants, remaining context variants, and closed program instructions. Every instruction has a stable nested ID; creation preserves that identity through editing and reordering. Validation checks that every Verb slot is represented exactly once, selector references and Feature owners exist, Room placements and program references are valid, and stable IDs are unique.

The compiler lowers rule slot IDs and selector unions losslessly into compiled V4. Native decoding rejects stale positional `operands` fields and unknown selector variants. Runtime, preview, Lua, authored-test playback, and recorded-test playback submit exact named bindings.
