# Interaction Component

## Contract

Interaction is immutable gameplay behavior keyed by one `VerbId` plus an ordered operand list.
Interaction subjects are a closed semantic union:

- Character;
- Interactable;
- Item Stack, by exact live `ItemStackId`;
- Feature, always qualified by its owning Room or Interactable.

A bare Feature ID is never a runtime subject. Exact operands carry one of those typed subjects.
`AnyCharacter`, `AnyInteractable`, and `AnyItemStack` are narrow wildcards, while `AnySubject`
matches all admitted subject families including Item Stacks and Features.

Hotspots are not Interaction contexts. They are presentation/input geometry that resolve to one
semantic subject or Room Exit before runtime dispatch. Interaction matching therefore sees the same
subject identity whether selection came from a pointer Hotspot, Layout UI, Lua, preview/debugger, or
an authored test.

Rules carry one of the remaining semantic contexts: generic, active Room, Room placement, or predicate.
Exact operands outrank wildcards. Equal-specificity ties use declaration order and produce the normal
authoring warning. The old exact-Hotspot context and Hotspot-specific precedence no longer exist.

## Program

An `InteractionProgram` is an ordered list containing only ApplyEffect, MoveInteractable,
SetInteractableState, Notify, CallScene, and CallDialogue, followed by one typed `FlowTarget` and an
authored successful outcome of `Handled` or `Unhandled`. Child Scene/Dialogue calls push frames and
return to the next instruction. Final targets use normal tail-continuation rules. Runtime instruction
or child-flow failure produces `Failed`; it is not an authored success result.

The additive typed visitor matches by Verb, arity, exact operands, explicit wildcards, active-Room
context, Room-placement context, and predicates. Candidates with more exact operands win;
declaration order is the final tie-break. The selected rule runs first. An `Unhandled` result then
attempts the selected Verb's default program once, while `Handled` applies the program FlowTarget and
`Failed` aborts. If that Verb default is also `Unhandled`, the current undefined-interaction policy is
a typed `Nothing happens.` notification.

Interaction is not a Property or Trait owner. Runtime command matching and execution state belong to
the Runtime Session rather than to the Interaction definition.

## Features as subjects

Features are owner-local semantic parts declared by Rooms or Interactables. An exact Feature subject
therefore uses one of these identities:

```text
RoomFeatureRef(RoomId, FeatureId)
InteractableFeatureRef(InteractableId, FeatureId)
```

Validation requires both the owner and the nested Feature to exist. Runtime eligibility is derived
from the owning semantic context: a Room Feature is eligible in its active Room context; an
Interactable Feature follows the owning Interactable's current eligibility. Feature Traits and
Properties do not change subject identity.

Multiple Hotspots may map to the same Feature. That produces one Interaction subject, not one subject
per geometry region. This is required so the same Verb/Feature rule works identically for pointer and
non-pointer invocation.

## Authoring, compiled, and state disposition

- **Authoring version 3:** collection-specific Interaction records with ordered rules,
  Character/Interactable/Item-Stack/Feature exact subjects, explicit wildcards, semantic context, and strict
  programs. Issue #70 changes the admitted subject/context shape without bumping the already-selected
  authoring version.
- **Compiled V4:** linked immutable `InteractionRule`/`InteractionProgram` with owner-qualified Feature
  subjects and no Hotspot context.
- **Mutable:** Interaction flow frames plus gameplay state changed by executed effects in
  `SessionState`; the Interaction definition itself has no mutable Property/Trait state.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Runtime and tooling surfaces

Runtime selection and invocation messages, saved Interaction frames, editor playback, debug snapshots,
RmlUi bindings, and Lua `Game.run_action` all use the same semantic subject vocabulary. The wire shape
for Feature subjects includes `ownerKind`, `ownerId`, and `featureId`; owner-qualified identity is
preserved instead of being collapsed to the nested Feature ID.

Pointer Hotspots never call an Interaction directly. A pointer release resolves a Hotspot target to
an exact semantic subject and dispatches ordinary subject selection, or resolves a Room Exit and
dispatches ordinary navigation. There is no `ActivateHotspotInput` and no exact-Hotspot invocation
state to save or restore.

Save state V8 persists owner-qualified Feature and exact Item Stack subjects when they appear in
yielding Interaction frames. Ended Stack identities are rejected rather than redirected. Feature and
Stack Property overrides use the normal Property-state path.

## Current editor implementation

The Interaction editor authors exact Character/Interactable/Item-Stack/Feature operands, all explicit wildcards,
remaining context variants, and closed program instructions. Every instruction has a stable nested ID;
creation preserves that identity through editing and reordering. Validation checks Verb arity,
subject/owner existence, Room placements, references, duplicate IDs, and equal-specificity warnings.
The compiler lowers every rule and instruction losslessly into the compiled program while preserving
authored order.
