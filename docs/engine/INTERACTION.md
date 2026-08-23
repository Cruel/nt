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

Rules carry one of the remaining semantic contexts: generic, active Room, Room placement, or predicate. They also carry an explicit nullable Offer declaration. `offer: null` opts the rule out of subject-first discovery; an Offer names its starting slot and owns an optional pure Offer Condition, authored rank, and primary intent. The starting subject selectors are the selectors already authored on that rule slot.

Rule context and the later Interaction Guard contract are execution concerns. They never participate in Offer discovery. #84 adds the rule-derived Offer surface but does not implement the Guard/priority resolver from #85; current complete-command rule selection therefore keeps the existing deterministic pre-#85 policy after named-slot selector checks.

## Subject Selector matching

Selector evaluation is based on the exact live subject and its current effective runtime configuration:

- `any-subject` admits every supported subject family;
- `family` admits exactly one of Character, Interactable, Feature, or Item Stack;
- `trait` checks effective Traits on the live Character, Interactable, Feature owner configuration, or Item Stack;
- `item-definition` checks the live Item Stack definition;
- `qualified-pattern` checks a stable qualified identity prefix with one trailing `*`;
- `exact` compares the exact semantic subject identity.

Declared Archetype provenance is not part of matching or specificity. A runtime-created subject therefore matches when its live family, effective Traits, Item Definition, qualified identity, or exact identity satisfies the selector. Copying or instantiating from an Archetype does not grant hidden selector preference.

## Discovery versus command execution

Offer discovery and complete-command execution are intentionally separate. Runtime may derive an Offer from a rule's starting-slot selectors without claiming that the rule will later win complete-command resolution. Conversely, a rule with `offer: null` can still handle a directly submitted complete command.

For each Verb, runtime first resolves the most-specific matching explicit or rule-derived Offer. Only that declaration's Offer Condition is evaluated. A false condition suppresses that Verb for the subject and never falls back to a broader declaration. Rule context/predicates are not substituted for Offer Conditions.

`Primary Activate` asks runtime to execute a unique immediately-complete primary Offer or otherwise open the ordinary Verb menu. `Open Verb Menu` only opens that menu and never auto-selects a primary Offer. Ambiguous primary Offers produce a typed diagnostic observation and leave the player at the menu.

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

- **Current authoring schema:** collection-specific Interaction records with ordered rules, named slot selector unions, nullable rule-derived Offer declarations, semantic context, and strict programs. #84 keeps the already-selected authoring schema version.
- **Compiled V4:** linked immutable `InteractionRule`/`InteractionProgram` with named slot selectors, nullable typed Offers, and owner-qualified Feature subjects. #84 keeps compiled schema version 4.
- **Mutable:** Interaction flow frames plus gameplay state changed by executed effects in `SessionState`; the Interaction definition itself has no mutable Property/Trait state.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Runtime and tooling surfaces

Runtime selection and invocation messages, semantic Primary Activate/Open Verb Menu inputs, editor playback, debug snapshots, RmlUi bindings, and direct Lua interaction submission use the same semantic subject vocabulary. Final invocation is a collection of `{slotId, subject}` bindings. The wire shape for Feature subjects includes `ownerKind`, `ownerId`, and `featureId`; owner-qualified identity is preserved instead of being collapsed to the nested Feature ID.

Pointer Hotspots never call an Interaction directly. A pointer release resolves a Hotspot target to an exact semantic subject and follows the default input policy: semantic Primary Activate for the main action, or Open Verb Menu when explicitly requested. Room Exit targets still dispatch ordinary navigation. Custom UI and tooling may independently select subjects or submit complete commands.

Save state persists named bindings when a yielding Interaction frame exists. Ended Stack identities are rejected rather than redirected. Feature and Stack Property overrides use the normal Property-state path.

## Current editor implementation

The Interaction editor authors one selector union per named Verb slot, all six Subject Selector variants, optional rule-derived Offers, remaining context variants, and closed program instructions. Every instruction has a stable nested ID; creation preserves that identity through editing and reordering. Validation checks that every Verb slot is represented exactly once, Offer starting slots name rule slots, selector references and Feature owners exist, Room placements and program references are valid, and stable IDs are unique.

The compiler lowers rule slot IDs, selector unions, and Offers losslessly into compiled V4. Native decoding rejects stale positional `operands` fields and unknown selector variants. Runtime, preview, Lua, authored-test playback, and recorded-test playback preserve direct complete-command submission while the preview/default UI additionally expose subject-first Offer discovery and semantic activation requests.
