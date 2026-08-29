# Interaction Component

## Contract

Interaction is immutable gameplay behavior keyed by one `VerbId` plus named slot selector constraints. Interaction subjects are a closed semantic union:

- Character;
- Interactable, by exact live `InteractableInstanceId`;
- Feature, always qualified by its owning Room or Interactable.

A bare Feature ID is never a runtime subject. Final commands carry exact live subject references bound to stable Verb slot IDs. The same live subject may bind multiple slots; #83 deliberately does not impose subject-distinctness.

Each Interaction Rule binds every slot declared by its Verb exactly once. A rule slot contains a finite union of the same `SubjectSelector` vocabulary used by Verb slots: any-subject, subject family, Trait, Interactable definition, reusable Interactable Feature declaration, qualified-pattern identity, and exact identity. Rule slot ordering is not semantic; matching is by `slotId`.

Hotspots are not Interaction contexts. They are presentation/input geometry that resolve to one semantic subject or Room Exit before runtime dispatch. Interaction matching therefore sees the same subject identity whether selection came from a pointer Hotspot, Layout UI, Lua, preview/debugger, or an authored test.

Rules carry one pure `Guard` plus an explicit signed integer `priority`. Runtime context such as the active Room or a placement is not a hidden matching dimension; authors express dynamic eligibility through ordinary pure Conditions. Rules also carry an explicit nullable Offer declaration. `offer: null` opts the rule out of subject-first discovery; an Offer names its starting slot and owns an optional pure Offer Condition, authored rank, and primary intent. The starting subject selectors are the selectors already authored on that rule slot.

Guards and priority are complete-command execution concerns and never participate in Offer discovery. Offer Conditions remain independent discovery predicates.

## Subject Selector matching

Selector evaluation is based on the exact live subject and its current effective runtime configuration:

- `any-subject` admits every supported subject family;
- `family` admits exactly one of Character, Interactable, or Feature;
- `trait` checks effective Traits on the live Character, Interactable, or Feature owner configuration;
- `interactable-definition` matches every live Interactable Instance whose immutable origin definition is the selected Interactable definition;
- `interactable-feature` matches the selected local Feature declaration on every live Instance of the selected Interactable definition;
- `qualified-pattern` checks a stable qualified identity prefix with one trailing `*`;
- `exact` compares the exact semantic subject identity.

Runtime-created Interactable Instances participate in the same matching and specificity rules as declared Instances. Definition-created and cloned Instances preserve the immutable origin definition used by `interactable-definition`; effective Traits and Properties are resolved from the live Instance configuration. Archetype provenance is not itself a selector or specificity dimension.

Inventory and quantity-oriented APIs reuse a deliberately narrower `InteractableMatcher` rather than the multi-family `SubjectSelector`. It supports broad Interactable matching plus conjunctive definition, Trait, Property-value, and exact-Instance narrowing. Boolean composition belongs to the surrounding Condition language; the matcher is not recursively composable.

## Discovery versus command execution

Offer discovery and complete-command execution are intentionally separate. Runtime may derive an Offer from a rule's starting-slot selectors without claiming that the rule will later win complete-command resolution. Conversely, a rule with `offer: null` can still handle a directly submitted complete command.

For each Verb, runtime first resolves the most-specific matching explicit or rule-derived Offer. Only that declaration's Offer Condition is evaluated. A false condition suppresses that Verb for the subject and never falls back to a broader declaration. Rule context/predicates are not substituted for Offer Conditions.

`Primary Activate` asks runtime to execute a unique immediately-complete primary Offer or otherwise open the ordinary Verb menu. `Open Verb Menu` only opens that menu and never auto-selects a primary Offer. Ambiguous primary Offers produce a typed diagnostic observation and leave the player at the menu.

The replaceable `command-builder` System Layout owns partial Command Draft presentation and editing, while runtime owns the active occurrence identity and semantic subject capture. The built-in Layout directly submits a one-slot Offer; a multi-slot Offer starts a Builder occurrence with the starting subject bound in the Draft. Project-authored replacements receive the unique selected subject plus each Offer's starting slot through the RuntimeUI projection and use the generic occurrence-bound `Game.ui` Builder transport to begin construction, report their exact watched references, and submit their own complete named bindings. While an occurrence is active, world and inventory subject activation is captured for the Builder instead of following ordinary subject-first activation. Runtime publishes typed snapshots for exactly the references reported by the Layout, including liveness, effective Room, enabled/visible availability, effective Traits, and current Offers. The Layout may retain, repair, rebind, or cancel its Draft in response.

Builder occurrences are transient and are not save/recording state. Stop, reset, load, Room/Flow ownership loss, Project replacement, an accepted direct control command, and the Builder lifecycle ending terminate the occurrence. Occurrence-bound capture/watch/submit/cancel requests carrying a stale token are rejected. Runtime accepts watched and submitted subjects only after semantic capture for that occurrence, so Layout-local Draft state cannot fabricate source authority. Final submission includes the complete named binding set and is passed through the same atomic Verb/slot/live-subject/selector/availability validation as any other complete Interaction command before Flow begins.

## Resolution and compact behavior

Complete-command resolution first validates the Verb and every named binding against the Verb slot selector unions. Candidate Interaction Rules then match only by Verb, named slot, and the closed structural Subject Selector vocabulary. Runtime orders matching rules by structural containment: a rule whose selector sets are strictly contained by another rule is narrower and is evaluated in an earlier tier. Declaration order is never a tie-break.

Within the current narrowest tier, runtime evaluates each pure Guard. A false Guard removes that rule and resolution stays within the tier; if no rule in the tier passes, resolution falls through to the next broader tier. A Guard evaluation error faults the command before any behavior executes. Among passing rules in one tier, the greatest explicit `priority` wins. More than one passing rule at the greatest priority is an ambiguity fault and executes nothing.

An `InteractionProgram` is the compact behavior representation. Its mutation prefix may contain ApplyEffect for typed non-Lua effects, MoveInteractable, and SetInteractableState. Runtime validates that mutation batch against a staged Session copy before committing any mutation, so a batch that would fail partway commits nothing. After the mutation prefix there may be at most one terminal action: Notify, Scene call, Dialogue call, or Lua handoff. A terminal `FlowTarget` such as Room navigation is also allowed when no terminal instruction is present. Terminal instructions must be final.

`Unhandled` is only valid for an empty behavior and therefore can never follow committed work. Once a handled behavior commits mutations or begins its terminal handoff, fallback is impossible. A later terminal failure faults execution while retaining already committed gameplay state.

Fallback is canonical and ordered: the selected Verb default program, then the optional Project undefined-Interaction program, then the engine's localized undefined-Interaction response. Each authored fallback can return `Unhandled` only while empty; a handled fallback terminates the chain. The built-in English response is `Nothing happens.` and the engine selects its localized equivalent from the active runtime locale.

Interaction is not a Property or Trait owner. Runtime command matching and execution state belong to the Runtime Session rather than to the Interaction definition.

## Features as subjects

Features are owner-local semantic parts declared by Rooms or Interactables. An exact Feature subject therefore uses one of these identities:

```text
RoomFeatureRef(RoomId, FeatureId)
InteractableFeatureRef(InteractableInstanceId, FeatureId)
```

Validation requires both the owner and the nested Feature to exist. Runtime eligibility is derived from the owning semantic context: a Room Feature is eligible in its active Room context; an Interactable Feature follows the owning Interactable's current eligibility. Feature Traits and Properties do not change subject identity.

Multiple Hotspots may map to the same Feature. That produces one Interaction subject, not one subject per geometry region. This is required so the same Verb/Feature rule works identically for pointer and non-pointer invocation.

## Authoring, compiled, and state disposition

- **Current authoring schema:** collection-specific Interaction records with named slot selector unions, nullable rule-derived Offers, pure Guards, explicit priority, and compact programs, plus an optional Project undefined-Interaction program. #85 preserves the already-selected authoring schema version.
- **Compiled project:** linked immutable `InteractionRule`/`InteractionProgram` with named slot selectors, nullable typed Offers, pure Guards, explicit priority, owner-qualified Feature subjects, and an optional Project fallback.
- **Mutable:** Interaction flow frames plus gameplay state changed by executed effects in `SessionState`; the Interaction definition itself has no mutable Property/Trait state.
- **Tooling only:** categories, tags, colors, sort keys, notes, graph layout, selection, and previews.

## Runtime and tooling surfaces

Runtime selection and invocation messages, semantic Primary Activate/Open Verb Menu inputs, editor playback, debug snapshots, RmlUi bindings, and direct Lua interaction submission use the same semantic subject vocabulary. Final invocation is a collection of `{slotId, subject}` bindings. The wire shape for Feature subjects includes `ownerKind`, `ownerId`, and `featureId`; owner-qualified identity is preserved instead of being collapsed to the nested Feature ID.

Pointer Hotspots never call an Interaction directly. A pointer release resolves a Hotspot target to an exact semantic subject and follows the default input policy: semantic Primary Activate for the main action, or Open Verb Menu when explicitly requested. Room Exit targets still dispatch ordinary navigation. Custom UI and tooling may independently select subjects or submit complete commands.

Save state persists named bindings and the exact fallback program stage when an Interaction frame exists, including the Project undefined-Interaction stage. Interaction frame subjects use only Character, Interactable Instance, and owner-qualified Feature identities.

## Current editor implementation

The Interaction editor authors one selector union per named Verb slot, all seven Subject Selector variants, optional rule-derived Offers, a pure Guard, explicit priority, and compact program instructions. Exact Interactable pickers enumerate declared Interactable Instances; definition records appear only in definition/reusable-Feature selectors. Every instruction has a stable nested ID; creation preserves that identity through editing and reordering. Project Settings → Runtime exposes the optional Project undefined-Interaction behavior. Each rule also exposes resolver analysis for its match space, broader and narrower overlaps, structural dominance, priority, conflicts, and reachability. The analysis is derived from the same selector-containment ordering used by runtime resolution and is informational only; edits still flow through the normal command/save-unit path and remain undo-safe.

Project validation checks complete named slots, selector references and Feature owners, Guard references, compact terminal constraints, program references, stable IDs, and resolver facts that are provably invalid. A rule whose selector space cannot intersect the corresponding Verb slot is an error. An unconditional equal-tier/equal-priority conflict is an error, including across separate Interaction records. A rule with an equivalent match space that is permanently dominated by an unconditional higher-priority rule is unreachable and is an error. Runtime-dependent Trait relationships, guarded overlap, runtime-created identity facts, and Lua predicates are warnings/information or conditional analysis rather than guessed blockers.

The Play inspector provides subject-centric and complete-command resolver explanations against its current debug snapshot. Subject analysis lists explicit and rule-derived Offer candidates, specificity tier, rank, primary intent, structural winner, suppression/shadowing, and condition/availability certainty. The native snapshot's resolved `verbOffers` remains the authoritative result for the concrete running state. Complete-command analysis shows structural tiers, Guard status when it can be established from snapshot variables, priority, winner, ambiguity, shadowing, and fallback. Lua predicates and live facts not present in the tooling snapshot remain explicitly conditional even when the subject identity itself was runtime-created.

The compiler lowers rule slot IDs, selector unions, Offers, Guards, priorities, and the optional Project fallback losslessly into the current compiled-project format. Native decoding rejects stale `context` and positional `operands` fields and unknown selector variants. Runtime, preview, Lua, authored-test playback, and recorded-test playback preserve direct complete-command submission while the preview/default UI additionally expose subject-first Offer discovery and semantic activation requests.
